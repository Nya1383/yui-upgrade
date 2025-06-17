require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
} = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const prism = require('prism-media');
const { GoogleGenAI } = require("@google/genai");
const { spawn } = require('child_process');

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
const SAMPLE_RATE = 16000; // Vosk prefers 16kHz
const CHANNELS = 1; // Mono for speech recognition
const MODEL_PATH = './vosk-model-en-us-0.22';

// Voice connection globals
let connection = null;
let receiver = null;

client.once(Events.ClientReady, () => {
  console.log(`🤖 Vosk Speech Bot ready as ${client.user.tag}`);
});

// Function to convert audio to proper format for Vosk
function convertAudioForVosk(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tempInputFile = path.join(__dirname, 'temp_input.wav');
    const tempOutputFile = path.join(__dirname, 'temp_output.wav');
    
    // Create WAV header for input
    const wavHeader = createWavHeader(inputBuffer.length, 48000, 2);
    const wavFile = Buffer.concat([wavHeader, inputBuffer]);
    
    // Write temporary file
    fs.writeFileSync(tempInputFile, wavFile);
    
    // Use ffmpeg to convert to 16kHz mono WAV
    const ffmpeg = spawn('ffmpeg', [
      '-i', tempInputFile,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y',
      tempOutputFile
    ]);
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        try {
          const convertedBuffer = fs.readFileSync(tempOutputFile);
          // Remove WAV header (44 bytes) to get raw PCM
          const pcmData = convertedBuffer.slice(44);
          
          // Cleanup temp files
          fs.unlinkSync(tempInputFile);
          fs.unlinkSync(tempOutputFile);
          
          resolve(pcmData);
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`FFmpeg failed with code ${code}`));
      }
    });
    
    ffmpeg.on('error', reject);
  });
}

// Function to use Vosk for speech recognition via Python script
function transcribeWithVosk(audioBuffer) {
  return new Promise(async (resolve, reject) => {
    try {
      // Convert audio to proper format
      const pcmData = await convertAudioForVosk(audioBuffer);
      
      // Create a Python script that uses Vosk
      const pythonScript = `
import json
import vosk
import sys
import struct

# Set up Vosk model
model = vosk.Model("${MODEL_PATH}")
rec = vosk.KaldiRecognizer(model, 16000)

# Read PCM data from stdin
pcm_data = sys.stdin.buffer.read()

# Process audio in chunks
chunk_size = 4000
result_text = ""

for i in range(0, len(pcm_data), chunk_size):
    chunk = pcm_data[i:i+chunk_size]
    if rec.AcceptWaveform(chunk):
        result = json.loads(rec.Result())
        if result.get('text'):
            result_text += result['text'] + " "

# Get final result
final_result = json.loads(rec.FinalResult())
if final_result.get('text'):
    result_text += final_result['text']

print(result_text.strip())
`;

      // Write Python script to temporary file
      const scriptPath = path.join(__dirname, 'temp_vosk_script.py');
      fs.writeFileSync(scriptPath, pythonScript);
      
      // Run Python script with PCM data
      const python = spawn('python', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let transcription = '';
      let errorOutput = '';
      
      python.stdout.on('data', (data) => {
        transcription += data.toString();
      });
      
      python.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      python.on('close', (code) => {
        // Cleanup
        fs.unlinkSync(scriptPath);
        
        if (code === 0) {
          resolve(transcription.trim());
        } else {
          reject(new Error(`Python script failed: ${errorOutput}`));
        }
      });
      
      // Send PCM data to Python script
      python.stdin.write(pcmData);
      python.stdin.end();
      
    } catch (error) {
      reject(error);
    }
  });
}

// Function to process audio and send to Gemini
async function processAudioToText(audioBuffer, userId, username) {
  try {
    console.log(`Processing audio from ${username}...`);
    
    const transcribedText = await transcribeWithVosk(audioBuffer);
    console.log(`Transcribed: "${transcribedText}"`);
    
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
    const channel = client.channels.cache.get(TARGET_CHANNEL_ID);
    if (channel) {
      await channel.send(`❌ Sorry, I couldn't understand what was said. Error: ${error.message}`);
    }
  }
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

function createWavHeader(dataLength, sampleRate = 48000, channels = 2) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataLength + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
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
      await message.reply('🎤 Now listening to voice chat with Vosk! Speak and I\'ll respond in the text channel!');

      // Listen for speaking events
      receiver.speaking.on('start', (userId) => {
        console.log(`User ${userId} started speaking`);
        
        const user = client.users.cache.get(userId);
        if (!user || user.bot) return;

        const audioStream = receiver.subscribe(userId, {
          end: {
            behavior: 'afterSilence',
            duration: 1500, // 1.5 seconds of silence
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
            // Only process if we have enough audio (at least 0.5 seconds)
            if (audioBuffer.length > 48000) {
              await processAudioToText(audioBuffer, userId, user.username);
            }
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
      await message.reply('👋 Stopped listening and left the voice channel!');
    } else {
      await message.reply('❌ Not currently in a voice channel!');
    }
  }
});

client.login(process.env.TOKEN); 