import { createAnalysisWorkerHandler } from "./analysis.worker.js";
import { analyzeWhole, CHUNK_FEATURE_TOL } from "./reference.js";
import { toMono, type PreprocParams } from "./mel.js";
import { describe, expect, it } from "vitest";

const PREPROC: PreprocParams = {
  version: 1,
  sr: 22050,
  channels: 1,
  n_fft: 2048,
  hop: 220,
  n_mels: 128,
  fmin: 0,
  fmax: 11025,
  htk: false,
  norm: "slaney",
  power: 1.0,
  log: "power_to_db_ref_max",
  amin: 1e-10,
  top_db: 80,
  center: true,
  pad_mode: "constant",
  window: "hann",
};

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function multiTone(seconds: number, sampleRate: number, seed: number): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rng = mulberry32(seed);
  const nTones = 3 + Math.floor(rng() * 4);
  const tones: { freq: number; amp: number; phase: number }[] = [];
  for (let i = 0; i < nTones; i++) {
    tones.push({ freq: 80 + rng() * 2000, amp: 0.1 + rng() * 0.4, phase: rng() * Math.PI * 2 });
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const t of tones) s += t.amp * Math.sin((2 * Math.PI * t.freq * i) / sampleRate + t.phase);
    out[i] = s * 0.3;
  }
  return out;
}

describe("B8a analysis worker protocol (ruling c — pure handler, fake Worker)", () => {
  it("chunk → streamed `features` (per-frame rows) + `ack` after fully consuming; `flush` → `done`", () => {
    const samples = multiTone(2, PREPROC.sr, 11);
    const handler = createAnalysisWorkerHandler(PREPROC);

    const out1 = handler.handle({
      type: "chunk",
      startFrame: 0,
      sampleRate: PREPROC.sr,
      channelCount: 1,
      channels: [samples.slice(0, PREPROC.sr)],
    });
    expect(out1).toHaveLength(2); // features + ack (1 s chunk at 22050 Hz → ~45 frames)
    expect(out1[0]!.type).toBe("features");
    expect(out1[1]!.type).toBe("ack");
    const features = out1[0]!;
    expect(features.type).toBe("features");
    if (features.type === "features") {
      expect(features.startFrame).toBe(0);
      expect(features.frames.length).toBeGreaterThan(0);
      for (const row of features.frames) expect(row.length).toBe(1);
    }
    if (out1[1]!.type === "ack") expect(out1[1]!.startFrame).toBe(0);

    const out2 = handler.handle({
      type: "chunk",
      startFrame: PREPROC.sr,
      sampleRate: PREPROC.sr,
      channelCount: 1,
      channels: [samples.slice(PREPROC.sr)],
    });
    expect(out2.some((m) => m.type === "ack")).toBe(true);

    const doneMsgs = handler.handle({ type: "flush" }).filter((m) => m.type === "done");
    expect(doneMsgs).toHaveLength(1);
    const done = doneMsgs[0]!;
    if (done.type !== "done") throw new Error("not done");
    const whole = analyzeWhole(samples, PREPROC.sr, PREPROC).flux;
    expect(done.flux.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(Math.abs(done.flux[i]! - whole[i]!)).toBeLessThanOrEqual(CHUNK_FEATURE_TOL);
    }
  });

  it("rejects a chunk whose `startFrame` is not contiguous (D30 protocol)", () => {
    const handler = createAnalysisWorkerHandler(PREPROC);
    handler.handle({
      type: "chunk",
      startFrame: 0,
      sampleRate: PREPROC.sr,
      channelCount: 1,
      channels: [new Float32Array(PREPROC.sr)],
    });
    // Second chunk jumps forward — the protocol forbids a gap.
    expect(() =>
      handler.handle({
        type: "chunk",
        startFrame: PREPROC.sr * 2, // skipped one second
        sampleRate: PREPROC.sr,
        channelCount: 1,
        channels: [new Float32Array(PREPROC.sr)],
      }),
    ).toThrow(/startFrame/);
  });

  it("rejects a chunk whose `sampleRate` differs from `preproc.sr` (the rate contract)", () => {
    const handler = createAnalysisWorkerHandler(PREPROC);
    expect(() =>
      handler.handle({
        type: "chunk",
        startFrame: 0,
        sampleRate: 44100,
        channelCount: 1,
        channels: [new Float32Array(PREPROC.sr)],
      }),
    ).toThrow(/sampleRate/);
  });

  it("`analyze-whole` runs the reference in one message — `done` carries `flux` + `mel` rows", () => {
    const samples = multiTone(2, PREPROC.sr, 21);
    const handler = createAnalysisWorkerHandler(PREPROC);
    const outs = handler.handle({
      type: "analyze-whole",
      sampleRate: PREPROC.sr,
      channelCount: 1,
      channels: [samples],
    });
    expect(outs).toHaveLength(1);
    const done = outs[0]!;
    if (done.type !== "done") throw new Error("not done");
    const ref = analyzeWhole(samples, PREPROC.sr, PREPROC, true);
    expect(done.flux.length).toBe(ref.flux!.length);
    expect(done.mel).toBeDefined();
    if (done.mel) {
      // `mel` is per-frame rows (`Float32Array(n_mels)` per frame).
      expect(done.mel.length).toBe(ref.flux!.length); // frames == frames
      for (const row of done.mel) expect(row.length).toBe(PREPROC.n_mels);
    }
  });

  it("a stereo chunk (2 channels) flows through `toMono` — the D30 chunk contract", () => {
    const l = multiTone(2, PREPROC.sr, 31);
    const r = multiTone(2, PREPROC.sr, 32);
    const handler = createAnalysisWorkerHandler(PREPROC);
    const outs = handler.handle({
      type: "chunk",
      startFrame: 0,
      sampleRate: PREPROC.sr,
      channelCount: 2,
      channels: [l, r],
    });
    expect(outs.some((m) => m.type === "ack")).toBe(true);
    // The mono downmix is the D30 analysis boundary (round 4 P1-6 — `toMono`).
    const mono = toMono([l, r]);
    expect(mono.length).toBe(l.length);
  });
});
