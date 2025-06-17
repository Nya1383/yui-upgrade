const fs = require('fs');
const path = require('path');

// Absolute paths for persistence files stored next to this script
const MEM_PATH = path.join(__dirname, 'memory.json');
const PROF_PATH = path.join(__dirname, 'profiles.json');

function loadJSON(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = {
  MEM_PATH,
  PROF_PATH,
  loadJSON,
  saveJSON,
}; 