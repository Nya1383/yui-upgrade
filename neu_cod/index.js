require('dotenv').config();
const { Client } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
} = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const prism = require('prism-media');
const { spawn } = require('child_process');

// Validate required environment variables
if (!process.env.TOKEN) {
    console.error('❌ DISCORD TOKEN is required! Please set TOKEN in your .env file');
    process.exit(1);
}

if (!process.env.GOOGLE_API_KEY) {
    console.error('❌ GOOGLE_API_KEY is required! Please set GOOGLE_API_KEY in your .env file');
    process.exit(1);
}

const client = new Client({
    intents: ['Guilds', 'GuildMessages', 'GuildMembers', 'MessageContent', 'GuildVoiceStates'],
})

client.on('ready', () => {
    console.log(`Yui is ready >_<`);
    console.log(`Bot is in ${client.guilds.cache.size} server(s)`);
});

const IGNORE_PREFIX = "!";
const CHANNELS = ["1382253103419494400"];
const VOICE_RESPONSE_CHANNEL = "1045406761554825430"; // Channel to send voice transcriptions

// Google GenAI configuration
const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY});

// Voice recording globals
let connection = null;
let receiver = null;
const MODEL_PATH = './vosk-model-en-us-0.22';

// NEW: persistent memory helpers and in-RAM buffers
const { MEM_PATH, PROF_PATH, loadJSON, saveJSON } = require('./memory');

const WINDOW_SIZE = 40;               // sliding window now accounts for both user & bot messages
const PROFILE_BUFFER_LINES = 30;      // lines before we try to update profile to reduce redundant calls
let windowMessages = [];              // recent channel messages
const recentByUser = {};              // map<userId, string[]>

function addToWindow(msg) {
    windowMessages.push({ authorId: msg.author.id, content: msg.content });
    if (windowMessages.length > WINDOW_SIZE) windowMessages.shift();
}

function buildWindowText() {
    return windowMessages.map(m => `<@${m.authorId}>: ${m.content}`).join('\n');
}

function buildProfileText(profiles) {
    const authors = [...new Set(windowMessages.map(m => m.authorId))];
    return authors
        .map(id => (profiles[id] ? `Persistent facts about <@${id}>: ${profiles[id].facts}` : ''))
        .filter(Boolean)
        .join('\n');
}

// Voice processing functions
function createWavHeader(dataLength, sampleRate = 16000, channels = 1) {
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

function convertAudioForVosk(inputBuffer) {
    return new Promise((resolve, reject) => {
        const tempInputFile = path.join(__dirname, `temp_input_${Date.now()}.wav`);
        const tempOutputFile = path.join(__dirname, `temp_output_${Date.now()}.wav`);
        
        console.log(`📁 Converting audio: ${inputBuffer.length} bytes`);
        
        // Create WAV header for input (48kHz stereo from Discord)
        const wavHeader = createWavHeader(inputBuffer.length, 48000, 2);
        const wavFile = Buffer.concat([wavHeader, inputBuffer]);
        
        // Write temporary file
        fs.writeFileSync(tempInputFile, wavFile);
        console.log(`📝 Wrote temp input file: ${tempInputFile}`);
        
        // Use local ffmpeg first
        const ffmpegPath = path.join(__dirname, 'ffmpeg', 'ffmpeg.exe');
        
        // Use ffmpeg to convert to 16kHz mono WAV (required by Vosk)
        const ffmpeg = spawn(ffmpegPath, [
            '-i', tempInputFile,
            '-ar', '16000',        // 16kHz sample rate
            '-ac', '1',            // mono
            '-f', 'wav',           // WAV format
            '-acodec', 'pcm_s16le', // 16-bit PCM
            '-y',                  // overwrite output
            tempOutputFile
        ]);
        
        let ffmpegError = '';
        
        ffmpeg.stderr.on('data', (data) => {
            ffmpegError += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            console.log(`🔧 FFmpeg finished with code: ${code}`);
            if (code === 0) {
                try {
                    // Check if output file exists and has content
                    if (fs.existsSync(tempOutputFile)) {
                        const stats = fs.statSync(tempOutputFile);
                        console.log(`📊 Output file size: ${stats.size} bytes`);
                        if (stats.size > 1000) { // At least 1KB for meaningful audio
                            fs.unlinkSync(tempInputFile);
                            resolve(tempOutputFile);
                        } else {
                            throw new Error('Output file too small - likely no audio content');
                        }
                    } else {
                        throw new Error('Output file was not created');
                    }
                } catch (err) {
                    reject(err);
                }
            } else {
                // Cleanup on error
                try { fs.unlinkSync(tempInputFile); } catch(e) {}
                try { fs.unlinkSync(tempOutputFile); } catch(e) {}
                reject(new Error(`FFmpeg failed with code ${code}. Error: ${ffmpegError}`));
            }
        });
        
        ffmpeg.on('error', (error) => {
            console.error(`❌ FFmpeg error: ${error.message}`);
            // Cleanup on error
            try { fs.unlinkSync(tempInputFile); } catch(e) {}
            try { fs.unlinkSync(tempOutputFile); } catch(e) {}
            reject(new Error(`FFmpeg not found: ${error.message}. Please ensure ffmpeg.exe is in the ffmpeg folder.`));
        });
    });
}

async function transcribeWithVosk(audioBuffer) {
    try {
        console.log(`🎙️ Starting transcription for ${audioBuffer.length} byte audio buffer`);
        
        // Convert audio to proper format for Vosk
        const wavFilePath = await convertAudioForVosk(audioBuffer);
        console.log(`✅ Audio converted successfully: ${wavFilePath}`);
        
        return new Promise((resolve, reject) => {
            // Run Python Vosk transcriber with better error handling
            const python = spawn('python', ['vosk_transcriber.py', wavFilePath, MODEL_PATH]);
            
            let transcription = '';
            let errorOutput = '';
            
            python.stdout.on('data', (data) => {
                transcription += data.toString();
            });
            
            python.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            python.on('close', (code) => {
                console.log(`🐍 Python script finished with code: ${code}`);
                // Cleanup temp file
                try { fs.unlinkSync(wavFilePath); } catch(e) {}
                
                if (code === 0) {
                    const result = transcription.trim();
                    console.log(`📝 Raw transcription result: "${result}"`);
                    
                    if (result && !result.startsWith('Error:') && result.length > 0) {
                        resolve(result);
                    } else {
                        reject(new Error('Empty or invalid transcription result'));
                    }
                } else {
                    reject(new Error(`Vosk transcription failed with code ${code}: ${errorOutput}`));
                }
            });
            
            python.on('error', (error) => {
                console.error(`❌ Python process error: ${error.message}`);
                // Cleanup temp file
                try { fs.unlinkSync(wavFilePath); } catch(e) {}
                reject(new Error(`Python process failed: ${error.message}. Please ensure Python and vosk are installed.`));
            });
        });
    } catch (error) {
        console.error(`❌ Audio conversion failed: ${error.message}`);
        throw new Error(`Audio conversion failed: ${error.message}`);
    }
}

async function processVoiceMessage(audioBuffer, userId, username) {
    try {
        console.log(`🎤 Processing voice message from ${username} (${audioBuffer.length} bytes)...`);
        
        // Improved minimum audio length check - at least 2 seconds of audio
        const minAudioSize = 48000 * 2 * 2 * 2; // 48kHz * 2 channels * 2 bytes * 2 seconds
        if (audioBuffer.length < minAudioSize) {
            console.log(`⏱️ Audio too short: ${audioBuffer.length} bytes (need at least ${minAudioSize})`);
            return; // Don't process very short audio clips
        }
        
        const transcribedText = await transcribeWithVosk(audioBuffer);
        console.log(`✅ Transcribed successfully: "${transcribedText}"`);
        
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

async function maybeUpdateSummary() {
    if (windowMessages.length < WINDOW_SIZE) return; // nothing to do yet

    const mem = loadJSON(MEM_PATH, { summary: '' });
    const newChunk = windowMessages.map(m => m.content).join('\n');

    const prompt = `You are a neutral third-person summariser for a Discord channel.\nGuidelines:\n• Write in neutral, third-person voice (no "I" / "you").\n• Capture only enduring facts, ongoing tasks, and topic changes.\n• Mention participants by name or ID.\n• Keep it ≤120 tokens.\n\nExisting summary:\n${mem.summary}\n\nNew messages:\n${newChunk}\n\nReturn ONLY the updated summary.`;

    try {
        const res = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: prompt,
            generationConfig: {
                temperature: 0.8
            }
        });
        if (res && res.text) {
            mem.summary = res.text.trim();
            saveJSON(MEM_PATH, mem);
            windowMessages = []; // reset buffer after summarising
        }
    } catch (err) {
        console.error('Failed to update channel summary:', err);
    }
}

async function updateUserProfile(userId) {
    const recent = recentByUser[userId];
    if (!recent || recent.length < PROFILE_BUFFER_LINES) return; // not enough data yet

    const profiles = loadJSON(PROF_PATH, {});
    const existingFacts = profiles[userId]?.facts || '';

    const prompt = `You keep a very short user profile for Discord users.
Existing profile:
${existingFacts}

Here are NEW messages from the user:
${recent.join('\n')}

Extract ONLY NEW stable facts (quirks, nicknames, long-term preferences) if any. 50 words max.
If nothing new, reply exactly: "NO NEW FACTS".`;

    try {
        const res = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: prompt,
            generationConfig: {
                temperature: 0.8
            }
        });
        const text = res?.text?.trim();
        if (text && !text.startsWith('NO NEW FACTS')) {
            // Deduplicate bullet lines
            const merged = [
                ...existingFacts.split('\n').map(s=>s.trim()).filter(Boolean),
                ...text.split('\n').map(s=>s.trim()).filter(Boolean)
            ];
            profiles[userId] = {
                facts: Array.from(new Set(merged)).join('\n'),
                updatedAt: new Date().toISOString(),
            };
            saveJSON(PROF_PATH, profiles);
        }
        // reset buffer
        recentByUser[userId] = [];
    } catch (err) {
        console.error(`Failed to update profile for ${userId}:`, err);
    }
}

// Rate limiting - track last request time
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000; // 5 seconds between requests for free tier - gemini 2.0 flash can do 15 requests per minute
let consecutiveRateLimits = 0;

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.startsWith(IGNORE_PREFIX)) return;

    // Voice commands
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
            await message.reply('🎤 Now listening to voice chat with Vosk! Speak and I\'ll transcribe and respond!');

            // Listen for speaking events
            receiver.speaking.on('start', (userId) => {
                console.log(`🎤 User ${userId} started speaking`);
                
                const user = client.users.cache.get(userId);
                if (!user || user.bot) return;

                const audioStream = receiver.subscribe(userId, {
                    end: {
                        behavior: 'afterSilence',
                        duration: 2000, // 2 seconds of silence (increased for better capture)
                    },
                });

                const decoder = new prism.opus.Decoder({
                    frameSize: 960,
                    channels: 2,
                    rate: 48000,
                });

                let audioChunks = [];
                let startTime = Date.now();

                audioStream.pipe(decoder);

                decoder.on('data', (chunk) => {
                    audioChunks.push(chunk);
                });

                decoder.on('end', async () => {
                    const duration = Date.now() - startTime;
                    console.log(`🔇 User ${userId} stopped speaking after ${duration}ms`);
                    console.log(`📝 Processing transcription for ${user.username}`);
                    
                    if (audioChunks.length > 0) {
                        const audioBuffer = Buffer.concat(audioChunks);
                        console.log(`📊 Captured ${audioChunks.length} chunks, total ${audioBuffer.length} bytes`);
                        await processVoiceMessage(audioBuffer, userId, user.username);
                    } else {
                        console.log(`⚠️ No audio chunks captured for ${user.username}`);
                    }
                });

                decoder.on('error', (error) => {
                    console.error('❌ Decoder error:', error);
                });
            });

        } catch (error) {
            console.error('Error joining voice channel:', error);
            await message.reply('❌ Failed to join voice channel!');
        }
        return;
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
        return;
    }

    // Regular text message processing
    if (!CHANNELS.includes(message.channelId) && !message.mentions.users.has(client.user.id)) return;

    console.log(`Processing message: "${message.content}" from ${message.author.tag}`);

    // Track context before any AI calls
    addToWindow(message);
    if (!recentByUser[message.author.id]) recentByUser[message.author.id] = [];
    recentByUser[message.author.id].push(message.content);

    // Rate limiting check
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
        console.log(`Rate limiting: waiting ${waitTime}ms before next request`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastRequestTime = Date.now();

    try {
        // Build dynamic context pieces
        const mem = loadJSON(MEM_PATH, { summary: '' });
        const profiles = loadJSON(PROF_PATH, {});
        const profileText = buildProfileText(profiles);
        const windowText = buildWindowText();

        const systemMessage = "You are Yui Hirasawa from K-On! You're super energetic, cheerful, and a bit airheaded but in the cutest way! You love music, especially your guitar Giita, and you're always excited about everything. Use expressions like 'Ehehe~', 'Uwaa~', 'Fuwa fuwa~' and add '~' to the end of sentences sometimes. You get easily distracted by food (especially cake and sweets) and sometimes forget what you were talking about. You're very caring about your friends and always try your best even when you're confused. Keep responses under 1 paragraph.";

        const prompt = `${systemMessage}

${profileText}

Channel summary so far:
${mem.summary}

Recent messages:
${windowText}

Please put more emphasis on the latest user message:
User: ${message.content}`;

        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: prompt,
            generationConfig: {
                temperature: 0.8
            }
        });

        consecutiveRateLimits = 0; // Reset on successful request

        if (response && response.text) {
            await message.reply(response.text);
            console.log('Response sent successfully');

            // Add bot's own reply to sliding window for better context
            windowMessages.push({ authorId: client.user.id, content: response.text });
            if (windowMessages.length > WINDOW_SIZE) windowMessages.shift();
        } else {
            console.error('Invalid response from Google GenAI:', response);
            await message.reply('Ehehe~ Something went wrong with my guitar strings... I mean, my brain! Try again? 🎵');
        }

        // Post-reply maintenance (does not block user)
        maybeUpdateSummary();
        updateUserProfile(message.author.id);
    } catch (error) {
        console.error('Error processing message:', error);
        if (error.message.includes('429')) {
            await message.reply('Ahh~ I\'m playing too fast! Let me slow down a bit, demo give me a moment, ne~ 🎸');
        } else {
            await message.reply('Uwaa~ Something went wrong! Demo I\'ll keep trying my best! 💪');
        }
    }
});

client.login(process.env.TOKEN);