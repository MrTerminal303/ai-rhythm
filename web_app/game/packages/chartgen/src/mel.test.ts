import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computeLogMel,
  melFrameCount,
  toAnalysisPcm,
  toMelTensor,
  toMono,
  MEL_FEATURE_TOL,
  type PreprocParams,
} from "./mel.js";

// vectors: committed under apps/web/public/spike/ (gen_vectors.py writes both copies)
const spike = (n: string) => new URL(`../../../apps/web/public/spike/${n}`, import.meta.url);
const preproc = JSON.parse(readFileSync(spike("preproc.json"), "utf8")) as PreprocParams;
const expected = JSON.parse(readFileSync(spike("expected_mel.json"), "utf8")) as number[][];
const wav = readFileSync(spike("input.wav"));
const samples = decodeWavMono(wav); // 22050 mono 16-bit → Float32Array (small local helper in the test)

describe("B7 (a) mel-feature parity: TS vs Python test vector", () => {
  it("runs to completion, matches the frame count, and produces finite features (experiment validity)", () => {
    const mel = computeLogMel(samples, preproc.sr, preproc); // FLAT frame-major Float32Array (review P0: one layout)
    const frames = melFrameCount(mel, preproc.n_mels);
    expect(frames).toBe(expected.length);
    expect(mel.length).toBe(expected.length * preproc.n_mels);
    for (let i = 0; i < mel.length; i++) expect(Number.isFinite(mel[i]!)).toBe(true);
  });

  it("records the parity verdict against MEL_FEATURE_TOL — WITHOUT failing the suite on a NO-GO (spec §4 B7)", () => {
    const mel = computeLogMel(samples, preproc.sr, preproc);
    let sum = 0;
    for (let f = 0; f < expected.length; f++) {
      for (let m = 0; m < preproc.n_mels; m++) {
        sum += Math.abs(mel[f * preproc.n_mels + m]! - expected[f]![m]!);
      }
    }
    const mae = sum / (expected.length * preproc.n_mels);
    expect(Number.isFinite(mae)).toBe(true);
    const verdict = mae <= MEL_FEATURE_TOL ? "PASS" : "FAIL (valid NO-GO evidence — spike still complete)";
    console.log(`[B7 mel-parity] mae=${mae.toExponential(3)} vs MEL_FEATURE_TOL=${MEL_FEATURE_TOL} → ${verdict}`);
    // Review P0: a failed feasibility result must NOT fail W3's gate. The W8 recommendation
    // (D26) depends on the parity outcome; W3 spike completion does not (spec §4 B7).
    // W8 release gating later re-runs under STRICT_PARITY=1 (separate, documented invocation).
  });

  it("frame count matches hop-derived T (never assume 10 ms/frame — §13.1)", () => {
    const frames = Math.floor(samples.length / preproc.hop) + 1; // match the pinned center-padding rule in mel.ts
    expect(melFrameCount(computeLogMel(samples, preproc.sr, preproc), preproc.n_mels)).toBe(frames);
  });

  it("rejects a sample rate that is not the pinned preproc.sr (round 3 P1-1 rate contract)", () => {
    expect(() => computeLogMel(samples, 48000, preproc)).toThrow(/sampleRate/);
  });
});

describe("B7 mel layout: frame-major flat → (1,1,n_mels,frames) NCHW", () => {
  it("toMelTensor transposes frame-major into the model's channel-major input", () => {
    const frames = 3;
    const nMels = 2;
    // flat[f * nMels + m]; distinct values so a wrong transpose cannot coincide
    const flat = new Float32Array([1, 2, 3, 4, 5, 6]);
    const t = toMelTensor(flat, frames, nMels);
    expect(Array.from(t)).toEqual([1, 3, 5, 2, 4, 6]); // [m][f]
    expect(t.length).toBe(frames * nMels);
  });

  it("melFrameCount is the flat length divided by n_mels", () => {
    expect(melFrameCount(new Float32Array(40), 8)).toBe(5);
    expect(() => melFrameCount(new Float32Array(7), 8)).toThrow(/divisible/);
  });
});

describe("B7 shared analysis boundary: toMono downmix (round 4 P1-6 / round 5 P2)", () => {
  it("mono input is identity (same array, no copy)", () => {
    const mono = new Float32Array([1, -1, 0.5]);
    expect(toMono([mono])).toBe(mono);
  });

  it("stereo with UNEQUAL levels averages equal-weight (L=0.5, R=0 → 0.25)", () => {
    const l = new Float32Array([0.5, 1, -0.5]);
    const r = new Float32Array([0, 0, 0]);
    expect(Array.from(toMono([l, r]))).toEqual([0.25, 0.5, -0.25]);
  });

  it("PHASE-INVERTED stereo cancels to ~0 — an EXPLICITLY ACCEPTED limitation (round 5 P2)", () => {
    const l = new Float32Array([0.5, 0.5]);
    const r = new Float32Array([-0.5, -0.5]);
    const mono = toMono([l, r]);
    for (const s of mono) expect(Math.abs(s)).toBeLessThan(1e-12);
  });

  it("throws on more than 2 channels (import caps at 2)", () => {
    expect(() => toMono([new Float32Array(1), new Float32Array(1), new Float32Array(1)])).toThrow(/channel/);
  });

  it("stereo-derived feature frame count equals the mono reference's exactly", () => {
    const ref = new Float32Array(8192);
    const bare = computeLogMel(ref, preproc.sr, preproc);
    const st = computeLogMel(toMono([ref, ref]), preproc.sr, preproc);
    expect(st.length).toBe(bare.length);
    expect(Array.from(toMono([ref, ref]))).toEqual(Array.from(ref));
  });
});

describe("B7 analysis sample-rate contract: toAnalysisPcm (round 3 P1-1)", () => {
  it("direct-copy path when the decoded rate already matches (no OfflineAudioContext)", async () => {
    const raw = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const decoded = fakeAudioBuffer([raw], 22050);
    const out = await toAnalysisPcm(decoded as never, 22050);
    expect(out.sampleRate).toBe(22050);
    expect(out.channels.length).toBe(1);
    expect(Array.from(out.channels[0]!)).toEqual(Array.from(raw));
    expect((decoded as unknown as { copyCalls: number }).copyCalls).toBe(1);
  });

  it("resamples a 44 100 buffer through OfflineAudioContext to 22 050", async () => {
    const input = new Float32Array(4410); // 0.1 s @ 44.1 kHz
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 10);
    const decoded = fakeAudioBuffer([input], 44100);
    const created: Array<{ length: number; rate: number; channels: number }> = [];
    const prior = (globalThis as Record<string, unknown>).OfflineAudioContext;
    class FakeOfflineAudioContext {
      destination = { connect: () => {}, disconnect: () => {} };
      sampleRate: number;
      constructor(channels: number, length: number, rate: number) {
        created.push({ channels, length, rate });
        this.sampleRate = rate;
      }
      createBufferSource() {
        return { buffer: null as unknown, connect: () => {}, start: () => {} };
      }
      startRendering() {
        return Promise.resolve({
          sampleRate: 22050,
          numberOfChannels: 1,
          length: 2205,
          copyFromChannel(d: Float32Array, c: number, off = 0) {
            for (let i = 0; i < d.length; i++) d[i] = Math.sin((off + i) / 5);
            void c;
          },
        });
      }
    }
    (globalThis as Record<string, unknown>).OfflineAudioContext = FakeOfflineAudioContext;
    try {
      const out = await toAnalysisPcm(decoded as never, 22050);
      expect(created).toHaveLength(1);
      expect(created[0]!.rate).toBe(22050);
      expect(created[0]!.length).toBe(Math.ceil((4410 * 22050) / 44100));
      expect(out.sampleRate).toBe(22050);
      expect(out.channels[0]!.length).toBe(2205);
      expect(Number.isFinite(out.channels[0]![10]!)).toBe(true);
    } finally {
      if (prior === undefined) delete (globalThis as Record<string, unknown>).OfflineAudioContext;
      else (globalThis as Record<string, unknown>).OfflineAudioContext = prior;
    }
  });
});

// ------------------------------------------------------------------ helpers
function decodeWavMono(buf: Uint8Array): Float32Array {
  // Minimal RIFF walker: find the `fmt ` + `data` chunks (never assume a 44-byte header).
  const ascii = (start: number, end: number) => new TextDecoder("ascii").decode(buf.subarray(start, end));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let pos = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Uint8Array | null = null;
  while (pos + 8 <= buf.length) {
    const id = ascii(pos, pos + 4);
    const size = view.getUint32(pos + 4, true);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === "fmt ") {
      fmt = {
        audioFormat: view.getUint16(pos + 8, true),
        channels: view.getUint16(pos + 10, true),
        sampleRate: view.getUint32(pos + 12, true),
        bits: view.getUint16(pos + 22, true),
      };
    } else if (id === "data") {
      data = new Uint8Array(body);
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data chunk");
  expect(fmt.sampleRate).toBe(22050); // parity test asserts input sampleRate === preproc.sr (round 3)
  expect(fmt.channels).toBe(1);
  expect(fmt.bits).toBe(16);
  const n = data.length / 2;
  const out = new Float32Array(n);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}

function fakeAudioBuffer(channels: Float32Array[], sampleRate: number): unknown {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    copyCalls: 0,
    copyFromChannel(dest: Float32Array, channel: number, offset = 0) {
      (this as { copyCalls: number }).copyCalls++;
      dest.set(channels[channel]!.subarray(offset, offset + dest.length));
    },
    getChannelData(channel: number) {
      return channels[channel]!;
    },
  };
}
