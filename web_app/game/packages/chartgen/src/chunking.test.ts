import { FluxChunker, streamChunks, type ChunkPort } from "./chunking.js";
import { analyzeWhole, CHUNK_FEATURE_TOL } from "./reference.js";
import { toMono, type PreprocParams } from "./mel.js";
import { describe, expect, it } from "vitest";

// ------------------------------------------------------------------ pinned preproc
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
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded multi-tone signal (deterministic — no Math.random, no wall clock). */
function multiTone(seconds: number, sampleRate: number, seed: number): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rng = mulberry32(seed);
  const nTones = 3 + Math.floor(rng() * 4);
  const tones: { freq: number; amp: number; phase: number }[] = [];
  for (let i = 0; i < nTones; i++) {
    tones.push({ freq: 80 + rng() * 2000, amp: 0.1 + rng() * 0.4, phase: rng() * Math.PI * 2 });
  }
  const nOnsets = 2 + Math.floor(rng() * 4);
  const onsets: number[] = [];
  for (let i = 0; i < nOnsets; i++) onsets.push(Math.floor(rng() * n));
  onsets.sort((a, b) => a - b);
  for (let i = 0; i < n; i++) {
    let env = 0.5;
    for (const o of onsets) if (i >= o) env = 1.0;
    let s = 0;
    for (const t of tones) s += t.amp * Math.sin((2 * Math.PI * t.freq * i) / sampleRate + t.phase);
    out[i] = env * s * 0.5;
  }
  return out;
}

// ------------------------------------------------------------------ chunked runner
/** Run the chunker over `chunkSec`-s chunks (optional 100-sample boundary shift). */
function runChunked(samples: Float32Array, chunkSec: number, shift = 0): Float32Array {
  const chunker = new FluxChunker(PREPROC);
  const chunkLen = Math.round(chunkSec * PREPROC.sr) + (shift === 0 ? 0 : 100);
  const frames: Float32Array[] = [];
  let cursor = 0;
  while (cursor < samples.length) {
    const len = Math.min(chunkLen, samples.length - cursor);
    const mono = toMono([samples.slice(cursor, cursor + len)]);
    const batch = chunker.consume(mono, cursor);
    frames.push(...batch.frames);
    cursor += len;
  }
  const flushBatch = chunker.flush(samples.length);
  frames.push(...flushBatch.frames);
  const out = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) out[i] = frames[i]![0] ?? 0;
  return out;
}

// ------------------------------------------------------------------ tests
describe("B8a chunking: chunked ≡ whole (review P0 — the continuity contract)", () => {
  // 10 s + 30.7 s (odd length) seeded multi-tone; chunk sizes {5 s, 7.3 s
  // (lands mid-window), 30 s} AND a 100-sample boundary shift → within
  // CHUNK_FEATURE_TOL. Frame counts identical.
  const durations = [10, 30.7];
  const chunkSizes = [5, 7.3, 30];

  for (const dur of durations) {
    for (const size of chunkSizes) {
      for (const shift of [0, 100]) {
        it(`chunked (${size} s${shift ? " +100-sample shift" : ""}) ≡ whole for ${dur} s within ${CHUNK_FEATURE_TOL}`, () => {
          const samples = multiTone(dur, PREPROC.sr, 42 + Math.round(dur * 100) + (shift ? 7 : 0));
          const whole = analyzeWhole(samples, PREPROC.sr, PREPROC).flux;
          const chunked = runChunked(samples, size, shift);
          expect(chunked.length).toBe(whole.length); // frame counts identical
          let maxDiff = 0;
          for (let i = 0; i < whole.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs(chunked[i]! - whole[i]!));
          }
          expect(maxDiff).toBeLessThanOrEqual(CHUNK_FEATURE_TOL);
        });
      }
    }
  }

  it("chunked via the pure handler (ruling c — fake Worker, no `new Worker`) ≡ whole", async () => {
    const { createAnalysisWorkerHandler } = await import("./analysis.worker.js");
    const samples = multiTone(10, PREPROC.sr, 99);
    const whole = analyzeWhole(samples, PREPROC.sr, PREPROC).flux;
    const handler = createAnalysisWorkerHandler(PREPROC);
    const chunkLen = Math.round(5 * PREPROC.sr);
    let cursor = 0;
    while (cursor < samples.length) {
      const len = Math.min(chunkLen, samples.length - cursor);
      handler.handle({
        type: "chunk",
        startFrame: cursor,
        sampleRate: PREPROC.sr,
        channelCount: 1,
        channels: [samples.slice(cursor, cursor + len)],
      });
      cursor += len;
    }
    const doneMsg = handler.handle({ type: "flush" }).find((m) => m.type === "done") as {
      flux: Float32Array;
    };
    expect(doneMsg.flux.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(Math.abs(doneMsg.flux[i]! - whole[i]!)).toBeLessThanOrEqual(CHUNK_FEATURE_TOL);
    }
  });

  it("a chunk shorter than one window (7.3 s boundary lands mid-window) emits no duplicate frames", () => {
    // 7.3 s @ 22050 = 160935 samples. The 100-sample boundary shift lands
    // mid-window (n_fft 2048 spans 92.9 ms) — the chunker's fLow/fHigh math
    // must not double-emit or skip a frame at the seam.
    const samples = multiTone(20, PREPROC.sr, 123);
    const whole = analyzeWhole(samples, PREPROC.sr, PREPROC).flux;
    const chunked = runChunked(samples, 7.3, 100);
    expect(chunked.length).toBe(whole.length);
  });
});

// ------------------------------------------------------------------ backpressure
// The ack-gated sender keeps AT MOST ONE outstanding un-acked chunk (review P0).
// A fake Worker that withholds `ack` must STALL the sender — it can never queue
// a second chunk, which is what enforces the ≤ 30 s residency bound end-to-end.
//
// Design: the fake mirrors the real Worker's protocol. Each inbound `post`
// that is a `chunk` is consumed by a `FluxChunker` (as the real handler does);
// the outbound `features`/`ack`/`done` messages are delivered through the
// single `onMessage` callback registered by `streamChunks` — EXACTLY the
// shape of `Worker.postMessage` → `onmessage`. `withholdAck` lets the test
// control when each `ack` is released.

interface FakeWorker {
  port: ChunkPort;
  releaseAck: () => void;
  chunksSeen: () => number;
  flushSeen: () => boolean;
}

function makeFakeWorker(samples: Float32Array, withholdAck: boolean): FakeWorker {
  const chunker = new FluxChunker(PREPROC);
  let registeredCb: ((m: { type: string; [k: string]: unknown }) => void) | null = null;
  let chunks = 0;
  let flushed = false;
  let pendingAck: number | null = null;
  // The real handler (`analysis.worker.ts`) ACCUMULATES every emitted frame
  // (from both chunk consumes AND flush) and flattens it into `done.flux` —
  // the fake mirrors that, not just the flush tail.
  const fluxRows: Float32Array[] = [];

  const port: ChunkPort = {
    post(msg) {
      if (msg.type === "chunk") {
        chunks++;
        const m = msg as unknown as { startFrame: number; channels: Float32Array[] };
        const batch = chunker.consume(toMono(m.channels), m.startFrame);
        if (batch.frames.length > 0) {
          fluxRows.push(...batch.frames);
          registeredCb?.({ type: "features", frames: batch.frames, startFrame: batch.firstFrame });
        }
        if (withholdAck) {
          pendingAck = m.startFrame; // the test calls `releaseAck` to post it
        } else {
          registeredCb?.({ type: "ack", startFrame: m.startFrame });
        }
      } else if (msg.type === "flush") {
        flushed = true;
        const batch = chunker.flush(samples.length);
        if (batch.frames.length > 0) fluxRows.push(...batch.frames);
        const flat = new Float32Array(fluxRows.length);
        for (let i = 0; i < fluxRows.length; i++) flat[i] = fluxRows[i]![0] ?? 0;
        registeredCb?.({ type: "done", flux: flat });
      }
    },
    onMessage(cb) {
      registeredCb = cb as (m: { type: string; [k: string]: unknown }) => void;
      return () => {
        if (registeredCb === cb) registeredCb = null;
      };
    },
  };

  return {
    port,
    releaseAck: () => {
      if (pendingAck === null) return;
      const s = pendingAck;
      pendingAck = null;
      registeredCb?.({ type: "ack", startFrame: s });
    },
    chunksSeen: () => chunks,
    flushSeen: () => flushed,
  };
}

describe("B8a backpressure (review P0): at most ONE outstanding un-acked chunk", () => {
  it("a fake worker withholding `ack` STALLS the sender (outstanding ≤ 1 across the stream)", async () => {
    const samples = multiTone(5, PREPROC.sr, 5);
    const fake = makeFakeWorker(samples, true);
    let done: Float32Array | null = null;

    const promise = streamChunks(
      (async function* () {
        for (let s = 0; s < 5; s++) {
          yield {
            startFrame: s * PREPROC.sr,
            sampleRate: PREPROC.sr,
            channelCount: 1,
            channels: [samples.slice(s * PREPROC.sr, (s + 1) * PREPROC.sr)],
          };
        }
      })(),
      fake.port,
      { onDone: (m) => (done = m.flux) },
    );

    // The sender posts chunk 1, then STALLS on its `ack` (withheld).
    await new Promise((r) => setTimeout(r, 25));
    expect(fake.chunksSeen()).toBe(1); // chunk 2 is NOT queued while `ack` #1 is withheld
    expect(fake.flushSeen()).toBe(false);

    // Release `ack` #1 → the sender posts chunk 2 (and stalls again).
    fake.releaseAck();
    await new Promise((r) => setTimeout(r, 25));
    expect(fake.chunksSeen()).toBe(2);
    expect(fake.flushSeen()).toBe(false);

    // Drain the remaining `ack`s — each release lets exactly ONE more chunk flow.
    for (let i = 0; i < 3; i++) {
      fake.releaseAck();
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fake.chunksSeen()).toBe(5);

    // The last chunk's `ack` is released → the sender posts `flush`; the fake
    // answers with `done` through the registered callback.
    const result = await promise;
    expect(fake.flushSeen()).toBe(true);
    expect(result.maxOutstanding).toBeLessThanOrEqual(1); // the invariant, whole stream
    expect(done).not.toBeNull(); // the `done` flux reached the sender's callback
  }, 20000);

  it("a well-behaved worker: `maxOutstanding` stays ≤ 1 across the whole stream", async () => {
    const samples = multiTone(3, PREPROC.sr, 8);
    const fake = makeFakeWorker(samples, false);
    let seenDone: Float32Array | null = null;

    const result = await streamChunks(
      (async function* () {
        for (let s = 0; s < 3; s++) {
          yield {
            startFrame: s * PREPROC.sr,
            sampleRate: PREPROC.sr,
            channelCount: 1,
            channels: [samples.slice(s * PREPROC.sr, (s + 1) * PREPROC.sr)],
          };
        }
      })(),
      fake.port,
      { onDone: (m) => (seenDone = m.flux) },
    );
    expect(fake.chunksSeen()).toBe(3);
    expect(fake.flushSeen()).toBe(true);
    expect(seenDone).not.toBeNull();
    expect(result.maxOutstanding).toBeLessThanOrEqual(1);
    // Cross-check: the `done` flux from the well-behaved worker ≡ `analyzeWhole`.
    const whole = analyzeWhole(samples, PREPROC.sr, PREPROC).flux;
    expect(seenDone!.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(Math.abs(seenDone![i]! - whole[i]!)).toBeLessThanOrEqual(CHUNK_FEATURE_TOL);
    }
  }, 20000);
});
