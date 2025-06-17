#!/usr/bin/env python3

import json
import sys
import vosk
import wave
import os

def transcribe_audio(wav_file_path, model_path):
    """
    Transcribe audio using Vosk speech recognition
    """
    try:
        # Debug: Print input parameters
        print(f"DEBUG: Processing file: {wav_file_path}", file=sys.stderr)
        print(f"DEBUG: Model path: {model_path}", file=sys.stderr)
        
        # Check if files exist
        if not os.path.exists(wav_file_path):
            raise FileNotFoundError(f"Audio file not found at {wav_file_path}")
            
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Model not found at {model_path}")
        
        # Check file size
        file_size = os.path.getsize(wav_file_path)
        print(f"DEBUG: Audio file size: {file_size} bytes", file=sys.stderr)
        
        if file_size < 1000:  # Less than 1KB
            raise ValueError(f"Audio file too small: {file_size} bytes")
        
        # Initialize Vosk model
        print(f"DEBUG: Loading Vosk model...", file=sys.stderr)
        model = vosk.Model(model_path)
        print(f"DEBUG: Model loaded successfully", file=sys.stderr)
        
        # Open WAV file
        wf = wave.open(wav_file_path, 'rb')
        
        # Debug: Print audio parameters
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        frames = wf.getnframes()
        duration = frames / framerate
        
        print(f"DEBUG: Audio info - Channels: {channels}, Sample width: {sampwidth}, Frame rate: {framerate}", file=sys.stderr)
        print(f"DEBUG: Duration: {duration:.2f} seconds, Frames: {frames}", file=sys.stderr)
        
        # Check if audio format is supported
        if channels != 1:
            raise ValueError(f"Audio must be mono (1 channel), got {channels} channels")
        if sampwidth != 2:
            raise ValueError(f"Audio must be 16-bit (2 bytes), got {sampwidth} bytes")
        if wf.getcomptype() != 'NONE':
            raise ValueError("Audio file must be uncompressed PCM")
        
        # Create recognizer
        print(f"DEBUG: Creating recognizer...", file=sys.stderr)
        rec = vosk.KaldiRecognizer(model, framerate)
        rec.SetWords(True)
        
        results = []
        bytes_processed = 0
        
        # Process audio in chunks
        print(f"DEBUG: Processing audio...", file=sys.stderr)
        while True:
            data = wf.readframes(4000)
            if len(data) == 0:
                break
            bytes_processed += len(data)
            
            if rec.AcceptWaveform(data):
                result = json.loads(rec.Result())
                if 'text' in result and result['text'].strip():
                    print(f"DEBUG: Partial result: {result['text']}", file=sys.stderr)
                    results.append(result['text'])
        
        print(f"DEBUG: Processed {bytes_processed} bytes of audio", file=sys.stderr)
        
        # Get final result
        final_result = json.loads(rec.FinalResult())
        if 'text' in final_result and final_result['text'].strip():
            print(f"DEBUG: Final result: {final_result['text']}", file=sys.stderr)
            results.append(final_result['text'])
        
        # Join all results
        full_transcription = ' '.join(results).strip()
        print(f"DEBUG: Complete transcription: '{full_transcription}'", file=sys.stderr)
        
        if not full_transcription:
            print(f"DEBUG: No speech detected in audio", file=sys.stderr)
            return "No speech detected"
        
        return full_transcription
        
    except Exception as e:
        error_msg = f"Error: {str(e)}"
        print(f"DEBUG: Exception occurred: {error_msg}", file=sys.stderr)
        return error_msg
    finally:
        if 'wf' in locals():
            wf.close()

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python vosk_transcriber.py <wav_file> <model_path>", file=sys.stderr)
        sys.exit(1)
    
    wav_file = sys.argv[1]
    model_path = sys.argv[2]
    
    transcription = transcribe_audio(wav_file, model_path)
    print(transcription)  # This goes to stdout for the main script 