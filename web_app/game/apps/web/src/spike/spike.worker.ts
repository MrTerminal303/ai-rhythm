// B7 spike worker (W3 T17). Runs mel + ORT-web inference OFF the main thread.
//
// PCM contract (the one T24 formalizes): the worker receives Float32Array channel
// arrays via transfer — never an AudioBuffer. The main thread has already resampled
// to preproc.sr (AudioContext({sampleRate:22050}) or toAnalysisPcm) and the worker
// ASSERTS it before computing (round 3 P1-1: a 48 kHz buffer would silently drift).
//
// Two message shapes:
//   { kind: "vectors", runs: [...] }   — commits, run every length on ONE session
//                                        (the dynamic-T proof), 3 warm-up + 5 measured
//   { kind: "benchmark", ... }         — chunk stream with single-outstanding-chunk ack
//
// onnxruntime-web is dynamic-imported per PLAN §13.3 (lazy) and its ~14 MB wasm is
// served from /ort/ (copied by scripts/copy-ort-wasm.mjs) — a same-origin fetch under
// the production CSP connect-src 'self' (D23).
import { computeLogMel, melFrameCount, toMelTensor, toMono, type PreprocParams } from "@airhythm/chartgen";

export type VectorSpec = {
  label: string;
  channels: Float32Array[];
  expectedMel: number[][] | null;
  expectedLogits: number[][][] | null;
};

export type VectorRequest = {
  kind: "vectors";
  id: number;
  sampleRate: number;
  preproc: PreprocParams;
  modelBytes: Uint8Array;
  warmup: number;
  measured: number;
  runs: VectorSpec[];
};

export type BenchmarkStart = {
  kind: "benchmark-start";
  id: number;
  sampleRate: number;
  preproc: PreprocParams;
  modelBytes: Uint8Array;
  warmup: number;
  measured: number;
};

export type BenchmarkChunk = { kind: "benchmark-chunk"; id: number; samples: Float32Array };
export type BenchmarkFinish = { kind: "benchmark-finish"; id: number };
export type SpikeRequest = VectorRequest | BenchmarkStart | BenchmarkChunk | BenchmarkFinish;

type OrtModule = typeof import("onnxruntime-web/wasm");
let ortPromise: Promise<OrtModule> | null = null;

function loadOrt(): Promise<OrtModule> {
  // `/wasm` is the pure-WASM build (no jsep/webgpu/webgl) — PLAN §13.3 + Q25 (WebGPU off).
  ortPromise ??= import("onnxruntime-web/wasm").then((ort) => {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    // Both the JS glue and the .wasm are served from /ort/ (copied by copy-ort-wasm.mjs);
    // naming them explicitly avoids ORT guessing a sibling path inside the bundle.
    ort.env.wasm.wasmPaths = {
      mjs: "/ort/ort-wasm-simd-threaded.mjs",
      wasm: "/ort/ort-wasm-simd-threaded.wasm",
    };
    return ort;
  });
  return ortPromise;
}

/** Accumulated benchmark state — one track at a time (single-outstanding-chunk). */
let bench: { id: number; chunks: Float32Array[]; total: number; spec: BenchmarkStart; session: unknown } | null = null;

self.onmessage = async (e: MessageEvent<SpikeRequest>) => {
  const req = e.data;
  try {
    if (req.kind === "vectors") await runVectors(req);
    else if (req.kind === "benchmark-start") await startBenchmark(req);
    else if (req.kind === "benchmark-chunk") await appendChunk(req);
    else await finishBenchmark(req);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// ------------------------------------------------------------- vector (parity) mode
async function runVectors(req: VectorRequest): Promise<void> {
  if (req.sampleRate !== req.preproc.sr) {
    throw new Error(`worker: sampleRate ${req.sampleRate} !== preproc.sr ${req.preproc.sr}`);
  }
  const ort = await loadOrt();
  // ONE session for every length — a graph with a hard-coded reshape target fails here.
  const session = await ort.InferenceSession.create(req.modelBytes, { executionProviders: ["wasm"] });

  const runs = [];
  for (const spec of req.runs) {
    const samples = toMono(spec.channels);
    const melRuns: number[] = [];
    const inferRuns: number[] = [];
    let mel: Float32Array | null = null;
    let logits: Float32Array | null = null;
    let frames = 0;

    const total = req.warmup + req.measured;
    for (let i = 0; i < total; i++) {
      const tMel = performance.now();
      const m = computeLogMel(samples, req.sampleRate, req.preproc);
      const melMs = performance.now() - tMel;
      const f = melFrameCount(m, req.preproc.n_mels);
      const tensor = new ort.Tensor("float32", toMelTensor(m, f, req.preproc.n_mels), [
        1,
        1,
        req.preproc.n_mels,
        f,
      ]);
      const tInfer = performance.now();
      const out = await session.run({ mel: tensor });
      const inferMs = performance.now() - tInfer;

      const value = out.onset_logits;
      if (!value) throw new Error("worker: model produced no `onset_logits` output");
      if (i === 0) {
        const dims = value.dims;
        if (dims.length !== 3 || dims[0] !== 1 || dims[2] !== 1 || dims[1] !== f) {
          throw new Error(`worker: unexpected output shape ${JSON.stringify(dims)} for T=${f}`);
        }
      }
      mel = m;
      logits = value.data as Float32Array;
      frames = f;
      if (i >= req.warmup) {
        melRuns.push(melMs);
        inferRuns.push(inferMs);
      }
    }

    runs.push({
      label: spec.label,
      frames,
      shape: `(1,1,${req.preproc.n_mels},${frames}) -> (1,${frames},1)`,
      melMae: melMaeOf(mel, spec.expectedMel, req.preproc.n_mels),
      logitsMaxDiff: maxAbsDiff(logits, spec.expectedLogits),
      melMs: median(melRuns),
      inferMs: median(inferRuns),
      melSpread: spread(melRuns),
      inferSpread: spread(inferRuns),
    });
  }
  (self as unknown as Worker).postMessage({ ok: true, id: req.id, kind: "vectors", runs });
}

// --------------------------------------------------------- benchmark (full) mode
async function startBenchmark(req: BenchmarkStart): Promise<void> {
  if (req.sampleRate !== req.preproc.sr) {
    throw new Error(`worker: sampleRate ${req.sampleRate} !== preproc.sr ${req.preproc.sr}`);
  }
  const ort = await loadOrt();
  const session = await ort.InferenceSession.create(req.modelBytes, { executionProviders: ["wasm"] });
  bench = { id: req.id, chunks: [], total: 0, spec: req, session };
  (self as unknown as Worker).postMessage({ ok: true, id: req.id, kind: "benchmark-ack", received: 0 });
}

async function appendChunk(req: BenchmarkChunk): Promise<void> {
  if (!bench || bench.id !== req.id) throw new Error("worker: benchmark chunk with no active start");
  bench.chunks.push(req.samples);
  bench.total += req.samples.length;
  // single-outstanding-chunk backpressure: the page posts the next chunk only after this ack
  (self as unknown as Worker).postMessage({ ok: true, id: req.id, kind: "benchmark-ack", received: bench.total });
}

async function finishBenchmark(req: BenchmarkFinish): Promise<void> {
  if (!bench || bench.id !== req.id) throw new Error("worker: benchmark finish with no active start");
  const { chunks, total, spec } = bench;
  const samples = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    samples.set(c, offset);
    offset += c.length;
  }
  const session = bench.session as { run: (f: Record<string, unknown>) => Promise<Record<string, { data: unknown }>> };
  bench = null;
  const ort = await loadOrt();

  const melRuns: number[] = [];
  const inferRuns: number[] = [];
  const totalRuns: number[] = [];
  let frames = 0;
  // D25: `warmup` discarded runs + `measured` timed runs. The timed window is the FULL
  // mel + inference pipeline on the whole track, so the median IS the §13.3 budget number.
  const measuredCount = Math.max(1, spec.measured);
  const warmupCount = Math.max(0, spec.warmup);
  for (let i = 0; i < warmupCount + measuredCount; i++) {
    const runStart = performance.now();
    const tMel = performance.now();
    const m = computeLogMel(samples, spec.sampleRate, spec.preproc);
    const melMs = performance.now() - tMel;
    const f = melFrameCount(m, spec.preproc.n_mels);
    const tensor = new ort.Tensor("float32", toMelTensor(m, f, spec.preproc.n_mels), [
      1,
      1,
      spec.preproc.n_mels,
      f,
    ]);
    const tInfer = performance.now();
    await session.run({ mel: tensor });
    const inferMs = performance.now() - tInfer;
    const totalMs = performance.now() - runStart;
    frames = f;
    if (i >= warmupCount) {
      melRuns.push(melMs);
      inferRuns.push(inferMs);
      totalRuns.push(totalMs);
    }
  }
  (self as unknown as Worker).postMessage({
    ok: true,
    id: req.id,
    kind: "benchmark",
    frames,
    samples: total,
    shape: `(1,1,${spec.preproc.n_mels},${frames}) -> (1,${frames},1)`,
    melMs: median(melRuns),
    inferMs: median(inferRuns),
    totalMs: median(totalRuns),
    melSpread: spread(melRuns),
    inferSpread: spread(inferRuns),
    totalSpread: spread(totalRuns),
  });
}

// ----------------------------------------------------------------------- helpers
function melMaeOf(mel: Float32Array | null, expected: number[][] | null, nMels: number): number | null {
  if (!mel || !expected) return null;
  let sum = 0;
  for (let f = 0; f < expected.length; f++) {
    for (let m = 0; m < nMels; m++) sum += Math.abs(mel[f * nMels + m]! - expected[f]![m]!);
  }
  return sum / (expected.length * nMels);
}

function maxAbsDiff(actual: Float32Array | null, expected: number[][][] | null): number | null {
  if (!actual || !expected) return null;
  let max = 0;
  let i = 0;
  for (const batch of expected) {
    for (const row of batch) {
      for (const v of row) max = Math.max(max, Math.abs(actual[i++]! - v));
    }
  }
  return max;
}

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function spread(xs: number[]): { min: number; max: number; p95: number } | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0]!, max: s[s.length - 1]!, p95: s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]! };
}
