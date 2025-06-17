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
const path = require('path');
const prism = require('prism-media');
const { Readable } = require('stream');
const { spawn } = require('child_process');

// Google GenAI configuration
const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// Deepgram configuration
const { createClient } = require("@deepgram/sdk");
const deepgram = createClient(process.env.DEEPGRAM);

// Constants
const VOICE_RESPONSE_CHANNEL = "1045406761554825430"; // Channel to send voice transcriptions

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
  console.log(`🤖 Yui Voice Bot ready as ${client.user.tag}`);
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

// Voice transcription functions
async function transcribeWithDeepgram(audioBuffer) {
    try {
        console.log(`🎙️ Starting Deepgram transcription for ${audioBuffer.length} byte audio buffer`);
        
        // Create WAV file with proper header for Deepgram
        const wavHeader = createWavHeader(audioBuffer.length, SAMPLE_RATE, CHANNELS);
        const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
        
        console.log(`📡 Sending ${wavBuffer.length} bytes to Deepgram API...`);
        
        // Send to Deepgram API
        const response = await deepgram.listen.prerecorded.transcribeFile(
            wavBuffer,
            {
                model: "nova-2", // Latest and most accurate model
                language: "en",
                smart_format: true, // Auto punctuation and formatting
                punctuate: true,
                utterances: false,
                paragraphs: false,
                profanity_filter: false,
                redact: false
            }
        );
        
        const transcription = response.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log(`✅ Deepgram transcription: "${transcription}"`);
        
        if (!transcription || transcription.trim().length === 0) {
            throw new Error('No speech detected in audio');
        }
        
        return transcription.trim();
        
    } catch (error) {
        console.error(`❌ Deepgram transcription failed:`, error);
        throw new Error(`Deepgram transcription failed: ${error.message}`);
    }
}

async function processVoiceMessage(audioBuffer, userId, username) {
    try {
        console.log(`🎤 Processing voice message from ${username} (${audioBuffer.length} bytes)...`);
        
        // Much smaller minimum size for Deepgram (1 second is fine)
        const minAudioSize = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 1; // 1 second
        if (audioBuffer.length < minAudioSize) {
            console.log(`⏱️ Audio too short: ${audioBuffer.length} bytes (need at least ${minAudioSize})`);
            return; // Don't process very short audio clips
        }
        
        const transcribedText = await transcribeWithDeepgram(audioBuffer);
        console.log(`✅ Deepgram transcribed: "${transcribedText}"`);
        
        if (transcribedText && transcribedText.trim().length > 2) { // At least 3 characters
            // Send to Gemini AI for response
            const response = await getGeminiVoiceResponse(transcribedText, username);
            
            // Send response to the voice response channel
            const channel = client.channels.cache.get(VOICE_RESPONSE_CHANNEL);
            if (channel) {
                await channel.send(`🎤 **${username}** said: "${transcribedText}"\n\n${response}`);
            }
        } else {
            console.log(`🔇 Transcription too short or empty, skipping response`);
        }
    } catch (error) {
        console.error('❌ Error processing voice message:', error);
        const channel = client.channels.cache.get(VOICE_RESPONSE_CHANNEL);
        if (channel) {
            await channel.send(`❌ Sorry ${username}, I couldn't understand what you said. Error: ${error.message}`);
        }
    }
}

async function getGeminiVoiceResponse(text, username) {
    try {
        const systemMessage = "You are Yui Hirasawa from K-On! You're super energetic, cheerful, and a bit airheaded but in the cutest way! You love music, especially your guitar Giita, and you're always excited about everything. Use expressions like 'Ehehe~', 'Uwaa~', 'Fuwa fuwa~' and add '~' to the end of sentences sometimes. You get easily distracted by food (especially cake and sweets) and sometimes forget what you were talking about. You're very caring about your friends and always try your best even when you're confused. Keep responses under 1 paragraph.";

        const prompt = `${systemMessage}

${username} just said via voice: "${text}"

Please respond as Yui would to this voice message.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: prompt,
            generationConfig: {
                temperature: 0.8
            }
        });

        return response.text || "Ehehe~ I didn't quite catch that! 🎵";
    } catch (error) {
        console.error('Error getting Gemini response:', error);
        return "Uwaa~ Something went wrong with my brain! 💫";
    }
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

// Track speaking state for transcription
const speakingStates = new Map(); // userId => { speaking: boolean, silenceTimer: timeout, processing: boolean }

// ================= Slash commands setup =================
const commands = [
  {
    name: 'join',
    description: 'Join your current voice channel and start listening with Vosk transcription.',
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
      await interaction.reply({ content: 'Already listening in this server!', ephemeral: true });
      return;
    }

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    receiver = connection.receiver;

    // Listen for speaking events for transcription
    receiver.speaking.on('start', (userId) => {
      console.log(`🎤 User ${userId} started speaking`);
      const user = client.users.cache.get(userId);
      if (!user || user.bot) return;

      // Clear any existing silence timer
      const speakingState = speakingStates.get(userId);
      if (speakingState && speakingState.silenceTimer) {
        clearTimeout(speakingState.silenceTimer);
      }

      speakingStates.set(userId, { speaking: true, silenceTimer: null, processing: false });
      ensureUserBuffer(userId);
    });

    receiver.speaking.on('end', (userId) => {
      console.log(`🔇 User ${userId} stopped speaking`);
      const user = client.users.cache.get(userId);
      if (!user || user.bot) return;

      const speakingState = speakingStates.get(userId);
      if (!speakingState) return;

      // Set a silence timer before processing transcription  
      speakingState.silenceTimer = setTimeout(async () => {
        // Check if already processing to prevent duplicates
        if (speakingState.processing) {
          console.log(`⏭️ Already processing transcription for ${user.username}, skipping`);
          return;
        }
        
        console.log(`📝 Processing transcription for ${user.username}`);
        
        // Use the HIGH-QUALITY main buffer instead of the speech buffer
        const highQualityBuffer = readPCM(userId);
        if (highQualityBuffer && highQualityBuffer.length > 0) {
          console.log(`📊 High-quality buffer size: ${highQualityBuffer.length} bytes`);
          
          // Take only the most recent 10 seconds for transcription to avoid too much audio
          const maxTranscriptionSize = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 10; // 10 seconds
          let transcriptionBuffer = highQualityBuffer;
          
          if (highQualityBuffer.length > maxTranscriptionSize) {
            // Take the most recent 10 seconds
            transcriptionBuffer = highQualityBuffer.slice(highQualityBuffer.length - maxTranscriptionSize);
            console.log(`📏 Trimmed to recent 10s: ${transcriptionBuffer.length} bytes`);
          }
          
          // Mark as processing
          speakingState.processing = true;
          
          await processVoiceMessage(transcriptionBuffer, userId, user.username);
          speakingState.processing = false;
        } else {
          console.log(`