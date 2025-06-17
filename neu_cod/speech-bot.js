require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const fs = require('fs');
const prism = require('prism-media');
const { GoogleGenAI } = require("@google/genai");

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Initialize Google AI
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// Constants
const TARGET_CHANNEL_ID = '1045406761554825430'; // The text channel to send responses to
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;

// Voice connection globals
let connection = null;
let receiver = null;
const userAudioStreams = new Map();

client.once(Events.ClientReady, () => {
  console.log(`🤖 Speech Bot ready as ${client.user.tag}`);
});

// Function to process audio and send to Gemini
async function processAudioToText(audioBuffer, userId, username) {
  try {
    // Create a temporary WAV file
    const wavHeader = createWavHeader(audioBuffer.length);
    const wavFile = Buffer.concat([wavHeader, audioBuffer]);
    
    // For now, we'll use a placeholder for speech recognition
    // You could integrate with Google Speech-to-Text API here
    const transcribedText = await transcribeAudio(wavFile);
    
    if (transcribedText && transcribedText.trim().length > 0) {
      // Send to Gemini AI for response
      const response = await getGeminiResponse(transcribedText, username);
      
      // Send response to the target text channel
      const channel = client.channels.cache.get(TARGET_CHANNEL_ID);
      if (channel) {
        await channel.send(`🎤 **${username}** said: "${transcribedText}"\n\n${response}`);
      }
    }
  } catch (error) {
    console.error('Error processing audio:', error);
  }
}

// Placeholder for speech recognition - you can replace this with actual speech-to-text
async function transcribeAudio(audioBuffer) {
  // This is a placeholder - you would implement actual speech recognition here
  // Options: Google Speech-to-Text API, Azure Speech Services, etc.
  return "Hello, this is a placeholder transcription";
}

async function getGeminiResponse(text, username) {
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

function createWavHeader(dataLength, sampleRate = SAMPLE_RATE, channels = CHANNELS) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataLength + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// Message handling for commands
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.toLowerCase();

  // Join voice channel command
  if (content === '!join' || content === '!listen') {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      await message.reply('❌ You need to be in a voice channel first!');
      return;
    }

    if (connection && !connection.destroyed) {
      await message.reply('Already listening in a voice channel!');
      return;
    }

    try {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });

      receiver = connection.receiver;
      await message.reply('🎤 Now listening to voice chat! Speak and I\'ll respond in the text channel!');

      // Listen for speaking events
      receiver.speaking.on('start', (userId) => {
        console.log(`User ${userId} started speaking`);
        
        const user = client.users.cache.get(userId);
        if (!user || user.bot) return;

        const audioStream = receiver.subscribe(userId, {
          end: {
            behavior: 'afterSilence',
            duration: 1000, // 1 second of silence
          },
        });

        const decoder = new prism.opus.Decoder({
          frameSize: 960,
          channels: 2,
          rate: 48000,
        });

        let audioChunks = [];

        audioStream.pipe(decoder);

        decoder.on('data', (chunk) => {
          audioChunks.push(chunk);
        });

        decoder.on('end', async () => {
          if (audioChunks.length > 0) {
            const audioBuffer = Buffer.concat(audioChunks);
            await processAudioToText(audioBuffer, userId, user.username);
          }
        });

        decoder.on('error', (error) => {
          console.error('Decoder error:', error);
        });
      });

    } catch (error) {
      console.error('Error joining voice channel:', error);
      await message.reply('❌ Failed to join voice channel!');
    }
  }

  // Leave voice channel command
  if (content === '!leave' || content === '!stop') {
    if (connection) {
      connection.destroy();
      connection = null;
      receiver = null;
      userAudioStreams.clear();
      await message.reply('👋 Stopped listening and left the voice channel!');
    } else {
      await message.reply('❌ Not currently in a voice channel!');
    }
  }
});

client.login(process.env.TOKEN); 