// Deterministic audio + .osu fixture generator.
// Default (no args): 30 s click track → public/audio/click-track.wav (unchanged W2 path).
// --songs (W3 T14): 3 seeded real-length tracks (short 30 s, medium 90 s, long 240 s) at
//   120 BPM — kick every beat + melodic line from a fixed note table — written as .wav
//   intermediates (gitignored) plus deterministic 4K .osu maps for short and long.
//   The .wav → mono-Opus .webm encoding pass is encode-songs.mjs (chromium MediaRecorder).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 22050; // both paths use one sample rate — WAV intermediate, 16-bit mono
const SONGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "songs");

// ---------- W2 default: 30 s click track (path unchanged) ----------
function writeClickTrack() {
  const SECONDS = 30, CLICK_MS = 20, PERIOD_MS = 500;
  const total = SR * SECONDS;
  const pcm = Buffer.alloc(total * 2);
  for (let n = 0; n < total; n++) {
    const ms = (n / SR) * 1000;
    const inClick = ms % PERIOD_MS < CLICK_MS;
    if (inClick) {
      const v = Math.round(12000 * Math.sin((2 * Math.PI * 1000 * n) / SR));
      pcm.writeInt16LE(v, n * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio", "click-track.wav");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.concat([header, pcm]));
  console.log(`wrote ${out} (${header.length + pcm.length} bytes)`);
}

// ---------- W3 T14: --songs ----------

// Seeded PRNG (mulberry32) — deterministic, so regeneration is byte-identical.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A fixed note table — one frequency per 16th-note step, 32-step cycle (seed-independent).
// 120 BPM → 1 beat = 500 ms → 16th note = 125 ms.
const NOTE_TABLE_HZ = [
  261.63, 329.63, 392.0, 523.25, // C4 E4 G4 C5
  293.66, 369.99, 440.0, 587.33, // D4 F4 A4 D5
  329.63, 415.3, 493.88, 659.25, // E4 G4 B4 E5
  349.23, 440.0, 523.25, 698.46, // F4 A4 C5 F5
  392.0, 493.88, 587.33, 783.99, // G4 B4 D5 G5
  440.0, 554.37, 659.25, 880.0, // A4 C5 E5 A5
];

// Render one song: kick every beat (120 BPM), melody one 16th-note per step, seeded chord
// every 4 beats. Returns int16 PCM + a note list (for the .osu map, beat-aligned).
function renderSong({ seconds, seed }) {
  const total = SR * seconds;
  const pcm = Buffer.alloc(total * 2); // zero-init: silence between events
  const rng = mulberry32(seed);
  const beatMs = 500, stepMs = 125;
  const notes = []; // { t, lane, type, d }

  // Melody: a 16th-note line at low amplitude + kick on every beat.
  const stepDur = stepMs / 1000;
  const nSteps = Math.floor((seconds * 1000) / stepMs);
  for (let s = 0; s < nSteps; s++) {
    const t0 = Math.round(s * stepMs * (SR / 1000));
    const t1 = Math.min(total, t0 + Math.round(stepDur * SR));
    const f = NOTE_TABLE_HZ[(s * 3) % NOTE_TABLE_HZ.length] * (1 + 2 * Math.floor(rng() * 2));
    // Envelope: 10 ms attack, linear decay over the step, peak 0.25.
    for (let n = t0; n < t1; n++) {
      const rel = n - t0;
      const attack = Math.min(1, rel / (SR * 0.01));
      const decay = Math.max(0, 1 - rel / (t1 - t0));
      const v = 0.25 * attack * decay * Math.sin(2 * Math.PI * f * rel / SR);
      const i = pcm.readInt16LE(n * 2) + Math.round(v * 32767);
      pcm.writeInt16LE(Math.max(-32767, Math.min(32767, i)), n * 2);
    }
  }

  // Kick: every beat — short 60 Hz sine, 80 ms, exponential decay.
  const nBeats = Math.floor((seconds * 1000) / beatMs);
  for (let b = 0; b < nBeats; b++) {
    const t0 = Math.round(b * beatMs * (SR / 1000));
    const t1 = Math.min(total, t0 + Math.round(0.08 * SR));
    for (let n = t0; n < t1; n++) {
      const rel = n - t0;
      const env = Math.exp(-rel / (SR * 0.03));
      const v = 0.6 * env * Math.sin(2 * Math.PI * 60 * rel / SR);
      const i = pcm.readInt16LE(n * 2) + Math.round(v * 32767);
      pcm.writeInt16LE(Math.max(-32767, Math.min(32767, i)), n * 2);
    }
    // Note on every beat (lane cycle 0-3, occasional chord on the beat).
    const t = b * beatMs;
    const lane = b % 4;
    notes.push({ t, lane, type: "tap", d: 0 });
    // Seeded chord: every 4th beat add a 2nd lane.
    if (b % 4 === 0 && b > 0 && rng() < 0.75) {
      notes.push({ t, lane: (lane + 2) % 4, type: "tap", d: 0 });
    }
  }

  // short.osu: hold note at t=3000, lane 1, d=1000 — documented for T10 A7 e2e.
  if (seconds === 30) {
    notes.push({ t: 3000, lane: 1, type: "hold", d: 1000 });
  }

  return { pcm, notes };
}

function wavHeader(pcmLength) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcmLength, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcmLength, 40);
  return header;
}

function writeOsu(name, notes, seconds) {
  const LANE_X = [64, 192, 320, 448]; // 4K lane x-coords (osu! mania 512-wide grid)
  // Round-13 hold payload: endTime + exactly 5 hitSample fields (hitSound:
  // startNum:endNum:startGroup:endGroup), all 0 — "128,0,<end>:0:0:0:0:0:"
  const lines = [
    "osu file format v14",
    "",
    "[General]",
    `AudioFilename:${name}.webm`,
    "AudioLeadIn:0",
    "Mode: 3",
    "PreciseScrollSpeed:1.0",
    "",
    "[Metadata]",
    `Title:${name}`,
    "Artist:AI Rhythm",
    "Creator:W3 Fixture Generator",
    "Version:W3 Fix",
    `Tags:fixture ${name} w3`,
    "PreviewTime:0",
    "",
    "[Difficulty]",
    "HPDrainRate:5",
    "CircleSize:4",
    "OverallDifficulty:8",
    "ApproachRate:5",
    "SliderMultiplier:1.0",
    "SliderTickRate:1",
    "",
    "[TimingPoints]",
    "0,500,4,2,0,60,1,0",
    "",
    "[HitObjects]",
  ];
  for (const n of notes) {
    const x = LANE_X[n.lane];
    if (n.type === "hold" && n.d > 0) {
      const end = n.t + n.d;
      lines.push(`${x},192,${n.t},128,0,${end}:0:0:0:0:0:`);
    } else {
      lines.push(`${x},192,${n.t},1,0,0:0:0:0:0:`);
    }
  }
  return lines.join("\n") + "\n";
}

function writeSongs() {
  mkdirSync(SONGS_DIR, { recursive: true });
  const defs = [
    { name: "short", seconds: 30, seed: 1 },
    { name: "medium", seconds: 90, seed: 2 },
    { name: "long", seconds: 240, seed: 3 },
  ];
  let shortNotes = null, longNotes = null;
  for (const { name, seconds, seed } of defs) {
    const { pcm, notes } = renderSong({ seconds, seed });
    writeFileSync(join(SONGS_DIR, `${name}.wav`), Buffer.concat([wavHeader(pcm.length), pcm]));
    console.log(`wrote ${name}.wav (${pcm.length + 44} bytes)`);
    if (name === "short") shortNotes = notes;
    if (name === "long") longNotes = notes;
  }
  // .osu only for short and long (medium has no map — it's the §13.3 soak track).
  writeFileSync(join(SONGS_DIR, "short.osu"), writeOsu("short", shortNotes, 30));
  writeFileSync(join(SONGS_DIR, "long.osu"), writeOsu("long", longNotes, 240));
  console.log(`wrote short.osu (${shortNotes.length} notes), long.osu (${longNotes.length} notes)`);
}

// ---------- entry ----------
if (process.argv.includes("--songs")) {
  writeSongs();
} else {
  writeClickTrack();
}
