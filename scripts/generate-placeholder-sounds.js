const fs = require('fs');
const path = require('path');

function writeWav(filePath, freq, durationSec, sampleRate = 44100) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const buffer = Buffer.alloc(44 + numSamples * 2);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // simple decay envelope so it doesn't click at the end
    const envelope = Math.min(1, (numSamples - i) / (sampleRate * 0.05));
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.3;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  fs.writeFileSync(filePath, buffer);
}

const outDir = path.join(__dirname, '..', 'sounds', 'malayalam');
fs.mkdirSync(outDir, { recursive: true });

const tones = [
  { name: 'placeholder-1.wav', freq: 440, duration: 0.35 },
  { name: 'placeholder-2.wav', freq: 550, duration: 0.4 },
  { name: 'placeholder-3.wav', freq: 660, duration: 0.3 },
  { name: 'placeholder-4.wav', freq: 330, duration: 0.5 },
  { name: 'placeholder-5.wav', freq: 220, duration: 0.45 },
];

for (const t of tones) {
  writeWav(path.join(outDir, t.name), t.freq, t.duration);
}

console.log(`Generated ${tones.length} placeholder tones in ${outDir}`);
