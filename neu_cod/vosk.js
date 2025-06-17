const vosk = require('vosk');
vosk.setLogLevel(0);

const MODEL_PATH = 'model/vosk-model-en-us-0.22'; // full-size
const SAMPLE_RATE = 48000;
const model = new vosk.Model(MODEL_PATH);
