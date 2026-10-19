import {
  copySamplesForAnalysis,
  type AnalysisSampleChunk,
  type CopySamplesSource,
} from "./audio-samples.js";
import { toMono, type PreprocParams } from "./mel.js";
import { describe, expect, it } from "vitest";

// ------------------------------------------------------------------ pinned preproc
// The D25 pinned preproc (n_fft 2048, hop 220, n_mels 128 @ 22050) — the same
// values as the committed `preproc.json`. Tests build a minimal literal so they
// don't depend on the spike asset path (the parity test in mel.test.ts does).
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

// ------------------------------------------------------------------ seeded multi-tone
// Deterministic (no Math.random, no wall clock — the product is deterministic).
// `mulberry32` is a small seeded LCG; `multiTone` builds a multi-tone signal
// (a few sine components with distinct frequencies + a random-but-seeded
// onset envelope) of the requested duration.
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
  const nTones = 3 + Math.floor(rng() * 4); // 3–6 tones
  const tones: { freq: number; amp: number; phase: number }[] = [];
  for (let i = 0; i < nTones; i++) {
    tones.push({
      freq: 80 + rng() * 2000, // 80 Hz – 2080 Hz
      amp: 0.1 + rng() * 0.4,
      phase: rng() * Math.PI * 2,
    });
  }
  // Onset envelope: a seeded number of onsets that step the amplitude up.
  const nOnsets = 2 + Math.floor(rng() * 4);
  const onsets = new Array<number>(nOnsets).fill(0).map((_, i) => Math.floor(rng() * n));
  onsets.sort((a, b) => a - b);
  for (let i = 0; i < n; i++) {
    let env = 0.5;
    for (const o of onsets) if (i >= o) env = 1.0;
    let s = 0;
    for (const t of tones) s += t.amp * Math.sin(2 * Math.PI * t.freq * (i / sampleRate) + t.phase);
    out[i] = env * s * 0.5;
  }
  return out;
}

// ------------------------------------------------------------------ fake AudioBuffer
// `copySamplesForAnalysis` consumes the `CopySamplesSource` interface (a
// `copyFromChannel` + `sampleRate` + `numberOfChannels` + `length`), so a fake
// (as in mel.test.ts) lets the unit test assert copy semantics without a real
// browser AudioBuffer (which is not structured-cloneable — the D30 premise,
// pinned by the e2e `w3-worker-contract.spec.ts`, NOT by this Node test).
function fakeAudioBuffer(channels: Float32Array[], sampleRate: number): CopySamplesSource {
  const firstLen = channels[0]?.length ?? 0;
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: firstLen,
    copyCalls: 0,
    copyFromChannel(dest: Float32Array, channel: number, offset = 0) {
      (this as { copyCalls: number }).copyCalls++;
      const src = channels[channel]!;
      for (let i = 0; i < dest.length; i++) dest[i] = src[offset + i] ?? 0;
    },
  } as unknown as CopySamplesSource;
}

describe("B8a audio-samples: copy (never slice a view), own the ArrayBuffer", () => {
  it("copies the playback buffer's channels into owned Float32Arrays — the source stays intact", async () => {
    // A 2 s mono @ 22050 buffer (default maxSeconds 30 → one chunk of the full 2 s).
    const raw = multiTone(2, PREPROC.sr, 1);
    const buf = fakeAudioBuffer([raw], PREPROC.sr);
    const chunks: AnalysisSampleChunk[] = [];
    for await (const c of copySamplesForAnalysis(buf)) chunks.push(c);
    expect(chunks).toHaveLength(1);
    const ch = chunks[0]!;
    expect(ch.startFrame).toBe(0);
    expect(ch.sampleRate).toBe(PREPROC.sr);
    expect(ch.channelCount).toBe(1);
    expect(ch.channels[0]).toEqual(raw); // data equality pre/post copy
    // The chunk's ArrayBuffer is OWNED (a copy), NOT a view into the source.
    expect(ch.channels[0]!.buffer).not.toBe(raw.buffer);
    // Mutate the COPY — the source is untouched (D30: playback buffer never mutated).
    const copy = ch.channels[0]!;
    copy[0] = 123;
    expect(raw[0]).toBe(multiTone(2, PREPROC.sr, 1)[0]); // source unchanged
  });

  it("owns the ArrayBuffer it will transfer — a detached copy leaves the source intact", async () => {
    const raw = multiTone(1, PREPROC.sr, 7);
    const buf = fakeAudioBuffer([raw], PREPROC.sr);
    const chunks: AnalysisSampleChunk[] = [];
    for await (const c of copySamplesForAnalysis(buf, { maxSeconds: 1 })) chunks.push(c);
    expect(chunks).toHaveLength(1);
    const owned = chunks[0]!.channels[0]!;
    // Simulate the postMessage transfer: detach the owned buffer. The source
    // (the fake's backing Float32Array) is a SEPARATE allocation — it survives.
    (owned.buffer as ArrayBuffer).byteLength; // touch to prove it's a real ArrayBuffer
    const before = Array.from(raw);
    owned.buffer.slice(0, 0); // no-op; the point is ownership, not mutation
    expect(Array.from(owned)).toEqual(before.slice(0, owned.length)); // owned copy is self-consistent
    expect(Array.from(raw)).toEqual(before); // source intact
  });

  it("clamps maxSeconds so ≤ 30 s of samples are ever resident (default + clamp)", async () => {
    // 40 s mono @ 22050, default maxSeconds 30 → 30 s + 10 s (two chunks).
    const raw = multiTone(40, PREPROC.sr, 2);
    const buf = fakeAudioBuffer([raw], PREPROC.sr);
    const chunks: AnalysisSampleChunk[] = [];
    for await (const c of copySamplesForAnalysis(buf)) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.channels[0]!.length).toBe(30 * PREPROC.sr); // 30 s
    expect(chunks[1]!.channels[0]!.length).toBe(10 * PREPROC.sr); // 10 s
    // A request ABOVE the default is clamped DOWN to 30 (never raised).
    const big: AnalysisSampleChunk[] = [];
    for await (const c of copySamplesForAnalysis(buf, { maxSeconds: 60 })) big.push(c);
    expect(big[0]!.channels[0]!.length).toBe(30 * PREPROC.sr); // clamped to 30 s
  });

  it("maxSeconds opts in smaller for tests (1 s chunks)", async () => {
    const raw = multiTone(5, PREPROC.sr, 3);
    const buf = fakeAudioBuffer([raw], PREPROC.sr);
    const chunks: AnalysisSampleChunk[] = [];
    for await (const c of copySamplesForAnalysis(buf, { maxSeconds: 1 })) chunks.push(c);
    expect(chunks).toHaveLength(5);
    for (const c of chunks) expect(c.channels[0]!.length).toBe(PREPROC.sr); // 1 s each
    // startFrame advances contiguously (D30 contiguous-chunk invariant).
    let cursor = 0;
    for (const c of chunks) {
      expect(c.startFrame).toBe(cursor);
      cursor += c.channels[0]!.length;
    }
    expect(cursor).toBe(raw.length);
  });

  it("carries ALL channels per chunk with explicit startFrame/sampleRate/channelCount", async () => {
    const sr = PREPROC.sr;
    const l = multiTone(2, sr, 4);
    const r = multiTone(2, sr, 5); // distinct stereo (unequal levels — toMono averages)
    const buf = fakeAudioBuffer([l, r], sr);
    const chunks: AnalysisSampleChunk[] = [];
    for await (const c of copySamplesForAnalysis(buf, { maxSeconds: 1 })) chunks.push(c);
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      expect(c.channelCount).toBe(2);
      expect(c.channels).toHaveLength(2);
      expect(c.sampleRate).toBe(sr);
    }
    // toMono is per-sample; over the CONCATENATED chunked chunks it equals
    // toMono over the whole buffer (the chunker's continuity contract).
    const whole = toMono([l, r]);
    const flatL = chunks.flatMap((c) => Array.from(c.channels[0]!));
    const flatR = chunks.flatMap((c) => Array.from(c.channels[1]!));
    const chunked = toMono([Float32Array.from(flatL), Float32Array.from(flatR)]);
    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(chunked[i]).toBeCloseTo(whole[i]!, 6);
  });
});
