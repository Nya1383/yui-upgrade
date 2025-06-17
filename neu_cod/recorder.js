require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
  VoiceReceiver,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const fs = require('fs');
const prism = require('prism-media');
const { Readable } = require('stream');

// Deepgram configuration
const { createClient } = require("@deepgram/sdk");
const deepgram = createClient(process.env.DEEPGRAM);

// Google GenAI configuration
const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// Create bot client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Bot login
client.once(Events.ClientReady, () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// ===== Voice-recording rolling buffer setup =====
const SAMPLE_RATE = 48_000;          // Hz
const CHANNELS = 2;                  // Stereo
const BYTES_PER_SAMPLE = 2;          // 16-bit signed int
const BUFFER_DURATION_SECONDS = 30;  // keep the last 30 s
const FRAME_SIZE = 960; // samples per channel in one Opus packet (20 ms)
const FRAME_DURATION_MS = 20; // 960 / 48000 * 1000
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE * FRAME_SIZE; // 3840 bytes
const BUFFER_SIZE = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * BUFFER_DURATION_SECONDS; // 5.76 MB
const IDLE_THRESHOLD_MS = FRAME_DURATION_MS * 3; // 60 ms before we inject silence

// Store per-user circular buffers
const userBuffers = new Map(); // userId => { buffer: Buffer, writePos: number, length: number, lastWriteMs: number }

function ensureUserBuffer(userId) {
  if (!userBuffers.has(userId)) {
    userBuffers.set(userId, {
      buffer: Buffer.alloc(BUFFER_SIZE),
      writePos: 0,
      length: 0,
      lastWriteMs: Date.now(),
    });
  }
}

function writePCM(userId, chunk) {
  ensureUserBuffer(userId);
  const ub = userBuffers.get(userId);
  let pos = ub.writePos;

  for (let i = 0; i < chunk.length; i++) {
    ub.buffer[pos] = chunk[i];
    pos = (pos + 1) % BUFFER_SIZE;
  }
  ub.writePos = pos;
  ub.length = Math.min(BUFFER_SIZE, ub.length + chunk.length);
  ub.lastWriteMs = Date.now();
}

function readPCM(userId) {
  const ub = userBuffers.get(userId);
  if (!ub || ub.length === 0) return null;

  const out = Buffer.alloc(ub.length);
  const start = (ub.writePos - ub.length + BUFFER_SIZE) % BUFFER_SIZE;

  if (start + ub.length <= BUFFER_SIZE) {
    // contiguous
    ub.buffer.copy(out, 0, start, start + ub.length);
  } else {
    // wrapped
    const firstPart = BUFFER_SIZE - start;
    ub.buffer.copy(out, 0, start, BUFFER_SIZE);
    ub.buffer.copy(out, firstPart, 0, ub.length - firstPart);
  }
  return out;
}

function mixPCM(buffers) {
  if (buffers.length === 1) return buffers[0];
  const minLen = Math.min(...buffers.map((b) => b.length));
  const mixed = Buffer.alloc(minLen);

  for (let i = 0; i < minLen; i += 2) {
    let sum = 0;
    for (const b of buffers) sum += b.readInt16LE(i);
    let avg = sum / buffers.length;
    // clamp
    if (avg > 32767) avg = 32767;
    if (avg < -32768) avg = -32768;
    mixed.writeInt16LE(avg, i);
  }
  return mixed;
}

function createWavHeader(dataLength, sampleRate = SAMPLE_RATE, channels = CHANNELS) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataLength + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // sub-chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// ====== Voice connection globals ======
let connection = null;
let receiver = null;
const activeDecoders = new Map(); // userId => decoder stream (for cleanup)
let silenceInterval = null; // interval handle

// ================= Slash commands setup =================
const commands = [
  {
    name: 'join',
    description: 'Join your current voice channel and start buffering the last 30 s of audio.',
  },
  {
    name: 'clip',
    description: 'Send the last 30 s clip (optionally only of specified users).',
    options: [
      {
        name: 'targets',
        description: 'Mention one or more users separated by spaces to limit the clip.',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'leave',
    description: 'Stop recording and leave the voice channel.',
  },
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
}

registerCommands();

// Interaction handling
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // --- JOIN ---
  if (commandName === 'join') {
    const channel = interaction.member.voice.channel;
    if (!channel) {
      await interaction.reply({ content: '❌ You must be in a voice channel first.', ephemeral: true });
      return;
    }

    if (connection && !connection.destroyed) {
      await interaction.reply({ content: 'Already recording in this server!', ephemeral: true });
      return;
    }

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    receiver = connection.receiver;

    // Start silence interval if not running
    if (!silenceInterval) {
      silenceInterval = setInterval(() => {
        const now = Date.now();
        userBuffers.forEach((ub, uid) => {
          const elapsed = now - ub.lastWriteMs;
          if (elapsed >= IDLE_THRESHOLD_MS) {
            const framesToInsert = Math.floor(elapsed / FRAME_DURATION_MS);
            for (let i = 0; i < framesToInsert; i++) writePCM(uid, Buffer.alloc(FRAME_BYTES));
          }
        });
      }, FRAME_DURATION_MS);
    }

    // Subscribe to speaker streams
    receiver.speaking.on('start', (userId) => {
      const user = client.users.cache.get(userId);
      if (!user || user.bot) return;
      if (activeDecoders.has(userId)) return;
      
      console.log(`🎤 ${user.username} started speaking`);

      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1000,
        },
      });

      const decoder = new prism.opus.Decoder({ frameSize: 960, channels: CHANNELS, rate: SAMPLE_RATE });
      const audioChunks = [];
      
      opusStream.pipe(decoder);
      decoder.on('data', (pcmChunk) => {
        writePCM(userId, pcmChunk);
        audioChunks.push(pcmChunk); // Capture for transcription
      });
      decoder.once('close', () => {
        activeDecoders.delete(userId);
        // Transcribe when speaking ends
        if (audioChunks.length > 0) {
          const audioBuffer = Buffer.concat(audioChunks);
          transcribeAudio(audioBuffer, user.username);
        }
      });
      opusStream.once('end', () => {
        if (activeDecoders.has(userId)) {
          decoder.end();
          activeDecoders.delete(userId);
        }
      });

      activeDecoders.set(userId, decoder);
    });

    await interaction.reply('🔊 Joined and started buffering the last 30 seconds of audio.');
  }

  // --- CLIP ---
  if (commandName === 'clip') {
    if (!connection || connection.destroyed) {
      await interaction.reply({ content: 'I am not connected to a voice channel. Use /join first.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const targetsOption = interaction.options.getString('targets');
    const mentionedIds = targetsOption ? targetsOption.match(/\d{17,19}/g) || [] : [];

    const targetBuffers = [];
    if (mentionedIds.length > 0) {
      for (const id of mentionedIds) {
        const data = readPCM(id);
        if (data) targetBuffers.push(data);
      }
    } else {
      for (const [uid] of userBuffers) {
        const data = readPCM(uid);
        if (data) targetBuffers.push(data);
      }
    }

    if (targetBuffers.length === 0) {
      await interaction.editReply('No audio captured yet for the requested users.');
      return;
    }

    const mixed = mixPCM(targetBuffers);
    const wav = Buffer.concat([createWavHeader(mixed.length), mixed]);
    const clipName = `clip-${Date.now()}.wav`;

    const description = mentionedIds.length > 0
      ? `🎞️ Last 30 seconds of ${mentionedIds.map((id) => `<@${id}>`).join(', ')}`
      : '🎞️ Last 30 seconds of the voice channel';

    await interaction.editReply({
      content: description,
      files: [{ attachment: wav, name: clipName }],
    });
  }

  // --- LEAVE ---
  if (commandName === 'leave') {
    if (connection) {
      connection.destroy();
      connection = null;
      receiver = null;
      activeDecoders.forEach((d) => d.end());
      activeDecoders.clear();
      userBuffers.clear();
      if (silenceInterval) {
        clearInterval(silenceInterval);
        silenceInterval = null;
      }
      await interaction.reply('👋 Left voice channel and cleared buffers.');
    } else {
      await interaction.reply({ content: 'I am not connected to a voice channel.', ephemeral: true });
    }
  }
});

// ======= End of new functionality =======

// ============ Graceful shutdown ============
function shutdown() {
  console.log('\n⏹️  Shutting down...');
  try {
    if (connection && !connection.destroyed) connection.destroy();
    activeDecoders.forEach((d) => d.end());
    if (silenceInterval) clearInterval(silenceInterval);
    client.destroy();
  } catch (err) {
    console.error('Error during shutdown:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Login using your bot token
client.login(process.env.TOKEN);

// Simple Deepgram transcription
async function transcribeAudio(audioBuffer, username) {
  try {
    console.log(`🎙️ Transcribing ${audioBuffer.length} bytes for ${username}`);
    
    const response = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: "nova-2",
        language: "en",
        smart_format: true,
        encoding: "linear16",
        sample_rate: SAMPLE_RATE,
        channels: CHANNELS
      }
    );
    
    const transcript = response.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    if (transcript.trim()) {
      console.log(`✅ "${transcript}"`);
      
      // Get Gemini response
      const geminiResponse = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `You are Yui Hirasawa from K-On! You're super energetic, cheerful, and a bit airheaded but in the cutest way! You love music, especially your guitar Giita, and you're always excited about everything. Use expressions like 'Ehehe~', 'Uwaa~', 'Fuwa fuwa~' and add '~' to the end of sentences sometimes. You get easily distracted by food (especially cake and sweets) and sometimes forget what you were talking about. You're very caring about your friends and always try your best even when you're confused. Keep responses under 1 paragraph.

${username} just said via voice: "${transcript}"

Please respond as Yui would to this voice message.`,
        generationConfig: { temperature: 0.8 }
      });
      
      // Post to channel
      const channel = client.channels.cache.get("1045406761554825430");
      if (channel) {
        await channel.send(`🎤 **${username}** said: "${transcript}"\n\n${geminiResponse.text || "Ehehe~ I didn't quite catch that! 🎵"}`);
      }
    }
  } catch (error) {
    console.error(`❌ Transcription failed:`, error.message);
  }
}