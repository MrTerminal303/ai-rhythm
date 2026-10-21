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

  it("flux of a single impulse is the hand-derived spectral magnitude sum (independent ground truth)", () => {
    // An EXACT, hand-derived value for one frame — NOT a comparison of the implementation
    // against itself (the row above is exactly that, and it cannot fail).
    //
    // Signal: one impulse of amplitude A at sample 0. Frame 0's window covers the absolute
    // samples [-n_fft/2, +n_fft/2) with zero padding, so the ONLY non-zero windowed sample
    // is at frame index pad = n_fft/2, and the Hann window's peak is hann(pad) = 1. The
    // windowed frame is therefore x[i] = A * hann(i - pad), i.e. a single non-zero sample A.
    // Its DFT is X[k] = A * exp(-2*pi*i*k*pad/n_fft) = A * exp(-pi*i*k) = A * (-1)^k, so
    // |X[k]| = A for EVERY bin. The first frame's flux is the sum of the magnitude spectrum
    // (the first frame diffs against ZERO magnitude — computeFlux's documented convention):
    //   flux[0] = nBins * A = (1 + n_fft/2) * A = 1025 * A
    // — a closed form that never touches the FFT implementation.
    const amplitude = 1;
    const nBins = 1 + PREPROC.n_fft / 2;
    const impulse = (a: number): Float32Array => {
      const s = new Float32Array(PREPROC.sr); // 1 s at the pinned rate
      s[0] = a;
      return s;
    };
    const f1 = analyzeWhole(impulse(amplitude), PREPROC.sr, PREPROC);
    expect(f1.flux[0]).toBeCloseTo(nBins * amplitude, 4);
    // Spectral flux is LINEAR in the signal: doubling the amplitude doubles the flux.
    // (An independent property of the definition — the whole first frame is a scaled copy.)
    const f2 = analyzeWhole(impulse(2 * amplitude), PREPROC.sr, PREPROC);
    expect(f2.flux[0]).toBeCloseTo(2 * f1.flux[0]!, 4);
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
