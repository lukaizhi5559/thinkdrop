#!/usr/bin/env node
// Generates src/renderer/assets/thought-chime.wav — a short "lightbulb moment"
// bell ding for proactive Thought deliveries (distinct from water-drip.mp3,
// which is reserved for answers/reminders).
// Run once: node scripts/make-thought-chime.mjs
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SR = 44100;
const DUR = 0.8; // seconds
const N = Math.floor(SR * DUR);

// Bell-ish strike: bright fundamental + inharmonic partials, fast decay.
const PARTIALS = [
  { ratio: 1.0,  amp: 1.0,  decay: 5.5 },
  { ratio: 2.76, amp: 0.42, decay: 8.0 },
  { ratio: 5.40, amp: 0.22, decay: 11.0 },
  { ratio: 8.93, amp: 0.10, decay: 14.0 },
];
const FUND = 1318.5; // E6 — bright "ding"
// A quick second strike a minor third up gives the two-note "idea!" feel.
const SECOND = { at: 0.16, fund: 1568.0, amp: 0.8 }; // G6

function strike(t, fund, amp) {
  if (t < 0) return 0;
  let s = 0;
  for (const p of PARTIALS) {
    s += p.amp * Math.sin(2 * Math.PI * fund * p.ratio * t) * Math.exp(-p.decay * t);
  }
  return amp * s;
}

const samples = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const t = i / SR;
  let v = strike(t, FUND, 1.0) + strike(t - SECOND.at, SECOND.fund, SECOND.amp);
  // soft clip / normalize-ish headroom
  v = Math.tanh(v * 0.9);
  samples[i] = v;
}

// peak-normalize to -3 dB
let peak = 0;
for (const v of samples) peak = Math.max(peak, Math.abs(v));
const gain = 0.7 / (peak || 1);

// 16-bit stereo PCM WAV
const dataSize = N * 2 * 2;
const buf = Buffer.alloc(44 + dataSize);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < N; i++) {
  const s = Math.max(-1, Math.min(1, samples[i] * gain));
  const pcm = Math.round(s * 32767);
  buf.writeInt16LE(pcm, 44 + i * 4);
  buf.writeInt16LE(pcm, 44 + i * 4 + 2);
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'assets', 'thought-chime.wav');
writeFileSync(out, buf);
console.log('wrote', out, `(${(buf.length / 1024).toFixed(1)} KB, ${DUR}s)`);
