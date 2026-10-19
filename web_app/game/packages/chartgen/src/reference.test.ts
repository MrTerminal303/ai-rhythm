import { CHUNK_FEATURE_TOL, analyzeWhole, melRows } from "./reference.js";
import { computeFlux } from "./flux.js";
import { computeLogMel, frameCount, toMono, type PreprocParams } from "./mel.js";
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

function multiTone(seconds: number, sr: number, seed: number): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const rng = mulberry32(seed);
  const nT = 3 + Math.floor(rng() * 4);
  const tones: { f: number; a: number; p: number }[] = [];
  for (let i = 0; i < nT; i++) tones.push({ f: 80 + rng() * 2000, a: 0.1 + rng() * 0.4, p: rng() * Math.PI * 2 });
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const t of tones) s += t.a * Math.sin((2 * Math.PI * t.f * i) / sr + t.p);
    out[i] = s * 0.3;
  }
  return out;
}

describe("B8a reference: analyzeWhole (the whole-buffer ground truth)", () => {
  it("flux length == frameCount(n, hop), all finite", () => {
    const samples = multiTone(2, PREPROC.sr, 7);
    const ref = analyzeWhole(samples, PREPROC.sr, PREPROC);
    expect(ref.flux.length).toBe(frameCount(samples.length, PREPROC.hop));
    for (let i = 0; i < ref.flux.length; i++) expect(Number.isFinite(ref.flux[i]!)).toBe(true);
  });

  it("flux is identical to computeFlux (the reference IS the flux core)", () => {
    const samples = multiTone(2, PREPROC.sr, 11);
    const ref = analyzeWhole(samples, PREPROC.sr, PREPROC);
    const direct = computeFlux(samples, PREPROC);
    expect(Array.from(ref.flux)).toEqual(Array.from(direct));
  });

  it("withMel=true returns the mel as per-frame rows; default (false) omits it", () => {
    const samples = multiTone(2, PREPROC.sr, 13);
    const noMel = analyzeWhole(samples, PREPROC.sr, PREPROC);
    expect(noMel.mel).toBeUndefined();

    const withMel = analyzeWhole(samples, PREPROC.sr, PREPROC, true);
    expect(withMel.mel).toBeDefined();
    const rows = withMel.mel!;
    const frames = frameCount(samples.length, PREPROC.hop);
    expect(rows.length).toBe(frames);
    for (const row of rows) expect(row.length).toBe(PREPROC.n_mels);
    // The rows are a partition of the flat frame-major mel (computeLogMel's layout).
    const flat = computeLogMel(samples, PREPROC.sr, PREPROC);
    for (let f = 0; f < frames; f++) {
      for (let m = 0; m < PREPROC.n_mels; m++) {
        expect(rows[f]![m]!).toBeCloseTo(flat[f * PREPROC.n_mels + m]!, 6);
      }
    }
  });

  it("CHUNK_FEATURE_TOL is 1e-6 (the frozen chunk contract)", () => {
    expect(CHUNK_FEATURE_TOL).toBe(1e-6);
  });

  it("rejects a sampleRate that is not the pinned preproc.sr (rate contract)", () => {
    expect(() => analyzeWhole(new Float32Array(PREPROC.sr), 44100, PREPROC)).toThrow(/sampleRate/);
  });

  it("a stereo stream down-mixed via toMono runs through the reference (D30 chunk contract)", () => {
    const l = multiTone(1, PREPROC.sr, 21);
    const r = multiTone(1, PREPROC.sr, 22);
    const mono = toMono([l, r]);
    const ref = analyzeWhole(mono, PREPROC.sr, PREPROC);
    expect(ref.flux.length).toBe(frameCount(mono.length, PREPROC.hop));
  });

  it("melRows partitions a flat frame-major mel into per-frame rows", () => {
    const flat = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const rows = melRows(flat, 4); // 2 frames of 4 mels
    expect(rows).toHaveLength(2);
    expect(Array.from(rows[0]!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(rows[1]!)).toEqual([5, 6, 7, 8]);
  });
});
