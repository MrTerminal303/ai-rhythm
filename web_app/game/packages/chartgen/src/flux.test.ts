import { computeFlux } from "./flux.js";
import { frameCount, type PreprocParams } from "./mel.js";
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

describe("flux core", () => {
  it("computeFlux returns frameCount(n, hop) finite frames, first frame diffs against zero", () => {
    const samples = multiTone(2, PREPROC.sr, 42);
    const flux = computeFlux(samples, PREPROC);
    expect(flux.length).toBe(frameCount(samples.length, PREPROC.hop));
    for (let i = 0; i < flux.length; i++) expect(Number.isFinite(flux[i]!)).toBe(true);
    // First frame: all magnitudes positive vs zero → flux[0] = sum(mag[0])
    expect(flux[0]!).toBeGreaterThan(0);
  });

  it("a silent stream has zero flux everywhere", () => {
    const flux = computeFlux(new Float32Array(PREPROC.sr * 2), PREPROC);
    for (let i = 0; i < flux.length; i++) expect(flux[i]!).toBe(0);
  });

  it("a tone step-up raises flux at the onset frame", () => {
    const sr = PREPROC.sr;
    const n = sr * 4;
    const out = new Float32Array(n);
    // Silence for 2 s, then a 440 Hz tone.
    for (let i = sr * 2; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    const flux = computeFlux(out, PREPROC);
    // The onset is at sample 2*sr → frame ≈ 2*sr/hop = 20000.
    const onsetFrame = Math.floor((2 * sr) / PREPROC.hop);
    // Frames well BEFORE the onset are silent: their windows sit entirely in
    // the zero region, so their magnitude is zero and their flux is zero.
    // (A frame right at the onset reads a window that straddles the step,
    // so its flux is the step — assert THAT frame, not one two before it.)
    const silent = flux[onsetFrame - 10]!;
    const at = flux[onsetFrame]!;
    expect(silent).toBe(0); // silent frames: zero magnitude, zero flux
    expect(at).toBeGreaterThan(0); // the onset frame carries the step
  });
});
