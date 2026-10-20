import { parseBeatmap, type Beatmap } from "@airhythm/shared";
import { copySamplesForAnalysis, type CopySamplesSource } from "./audio-samples.js";
import { computeFlux } from "./flux.js";
import { toAnalysisPcm, type PreprocParams } from "./mel.js";
import { assignLanes, computeLaneSeed, enforceNoteDensity, mulberry32, selectDensity, type NoteDraft } from "./lane-assign.js";
import type { AnalysisWorkerInMessage, AnalysisWorkerOutMessage } from "./analysis.worker.js";
import type { BeatmapCandidate, ChartGenerator } from "./types.js";

/**
 * B8b (W3 T25) — `flux-v1`, the fallback chart generator: spectral-flux onsets
 * (T24 features) → adaptive peak-pick → density → lane assignment → beat
 * tracking → a schema-valid `BeatmapCandidate`.
 *
 * Decoupled from B7 (spec §4 B8): this module NEVER reads an ONNX result. Its
 * only dependency on the spike is the shared deterministic analysis layer
 * (framing/FFT/flux), which has no model in it.
 *
 * Division of labor (Round 10 P2-11 / Round 11 P1-15):
 * - The MAIN THREAD owns the `ChartGenerator` interface, chunk copying/streaming,
 *   progress forwarding, cancellation, the 20 s budget, and candidate validation
 *   (`parseBeatmap`).
 * - The WORKER owns onset detection, lane assignment, density selection and beat
 *   tracking. It posts the raw candidate (`generate-done`); the adapter validates.
 * - An `AudioBuffer` never crosses the Worker boundary: only owned `Float32Array`
 *   chunks do (D30/T24).
 */

// ------------------------------------------------------------------ constants
/** The pinned D25 preprocessing contract — the same values as `preproc.json`. */
export const PINNED_PREPROC: PreprocParams = {
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

/**
 * Peak-pick constants — pinned HERE and mirrored verbatim by
 * `models/spike/baseline_flux.py` (R13). These are the developer's baseline
 * peak-pick values (`airhythm/config.py` PEAK_PICK_PARAMS), applied to the
 * normalized spectral-flux envelope with librosa's `util.peak_pick` semantics.
 */
export const ONSET_PRE_MAX = 3;
export const ONSET_POST_MAX = 1;
export const ONSET_PRE_AVG = 15;
export const ONSET_POST_AVG = 15;
export const ONSET_DELTA = 0.02;
export const ONSET_WAIT = 3;

/** Envelope-normalization tiny term — `np.finfo(np.float32).tiny` (librosa.util.tiny). */
export const ENVELOPE_TINY = 2 ** -126;

/** Beat tracking (Q24): search range + the confidence below which we fall back to 120 BPM. */
export const BEAT_MIN_BPM = 60;
export const BEAT_MAX_BPM = 200;
export const BEAT_CONFIDENCE_MIN = 0.25;
export const BEAT_FALLBACK_BPM = 120;

/** Q10: a generation that exceeds this budget is surfaced as Retry/Cancel. */
export const FLUX_GENERATION_TIMEOUT_MS = 20_000;

/** Default density cap (PLAN §13.2 step 8). */
export const DEFAULT_TARGET_NPS = 7;

/** Hold probability + duration (the §13.4 hold row must be non-vacuous). */
export const HOLD_PROBABILITY = 0.15;
export const HOLD_DURATION_MS = 300;

/** Fraction of onsets promoted to chords (Q27 clamps any chord to 2). */
export const CHORD_PROBABILITY = 0.2;

/** Deterministic onset tolerance for the parity/beat-grid assertions (frames ≈ 10 ms). */
export const FLUX_ONSET_TOL_MS = 30;

// ------------------------------------------------------------------ types
/** One detected onset (ms + normalized envelope confidence). */
export interface Onset {
  tMs: number;
  confidence: number;
}

/**
 * Adapter instrumentation (tests only). Reports the ADAPTER's own view of the
 * chunk stream — the fake Worker port cannot see what the adapter retains.
 */
export interface GenerateProbe {
  /** The adapter's outstanding-chunk count changed (0 or 1 — never more). */
  onPosted?: (outstanding: number) => void;
  /** The adapter released its held chunk (settle: cancel / error / done). */
  onReleased?: () => void;
  /**
   * The adapter's streaming loop EXITED. Without the ack-waiter drain the loop
   * stays parked at the gate forever (the suspended `for await` never resumes),
   * so this never fires on a cancel that lands mid-stream.
   */
  onStreamEnd?: () => void;
}

export interface GenerateOptions {
  audioHash: string;
  targetNps?: number;
  density?: number;
  onProgress?: (p: GenerateProgress) => void;
  signal?: AbortSignal;
  /** Q10 budget override (ms). Defaults to `FLUX_GENERATION_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Test-only instrumentation of the adapter's own chunk accounting. */
  probe?: GenerateProbe;
}

/** The resolved option record sent to the Worker (`seed` = laneSeed). */
export interface ResolvedGenerateOptions {
  audioHash: string;
  targetNps: number;
  density: number;
  seed: number;
}

export interface GenerateProgress {
  startFrame: number;
  processedFrames: number;
  /** 0..100 — derived from processedFrames for the UI. */
  pct: number;
}

/** Worker → main progress (frozen Round-11 payload — no extra fields). */
export type FluxV1OutMessage =
  | { type: "generate-progress"; startFrame: number; processedFrames: number }
  | { type: "generate-done"; candidate: BeatmapCandidate; elapsedMs: number }
  | { type: "generate-error"; code: FluxWorkerErrorCode; message?: string };

/**
 * Main → Worker (frozen Round-11 table).
 *
 * `audioChunks` is declared by the frozen table but is EMPTY here: the table's
 * own note says chunks are streamed via the T24 chunk protocol (`chunk`/`ack`),
 * which is the only path that can carry the ≤30 s residency + single-outstanding
 * backpressure contract. `signal` is likewise not wire-representable; the
 * `generate-cancel` message IS its wire form.
 */
export type FluxV1InMessage =
  | {
      type: "generate-request";
      audioChunks: Float32Array[];
      sampleRate: number;
      channelCount: number;
      startFrame: number;
      options: ResolvedGenerateOptions;
    }
  | { type: "generate-cancel"; requestId: string };

/**
 * The frozen Round-11 WIRE error codes (worker → main). `timeout` is NOT a wire
 * code — it is produced adapter-side by the Q10 budget (see `FluxGenerateErrorCode`).
 */
export type FluxWorkerErrorCode = "cancelled" | "internal" | "validation";

/** Every code a `FluxGenerateError` can carry — the wire set plus adapter-side `timeout`. */
export type FluxGenerateErrorCode = FluxWorkerErrorCode | "timeout";

/** Structured generator failure — the adapter rejects with THIS, never a bare Error. */
export class FluxGenerateError extends Error {
  constructor(
    readonly code: FluxGenerateErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "FluxGenerateError";
  }
}

/** The Worker-port abstraction the adapter drives (a real Worker or a test fake). */
export interface FluxWorkerPort {
  post(msg: FluxV1InMessage | AnalysisWorkerInMessage, transfer?: Transferable[]): void;
  onMessage(cb: (msg: FluxV1OutMessage | AnalysisWorkerOutMessage) => void): () => void;
  terminate?(): void;
}

/**
 * Reject a malformed chunk BEFORE any down-mix (T24 R16, mirrored into the
 * flux-v1 Worker): `channelCount` must match `channels.length`, and every
 * channel must carry the SAME length. `toMono` reads `right[i]` up to
 * `first.length`; a short channel yields `undefined` → NaN, which `chunkFrame`
 * silently turns into 0 — plausibly shaped but wrong flux, with no error.
 */
export function validateFluxChannels(channels: Float32Array[], channelCount: number): void {
  if (channelCount !== channels.length) {
    throw new Error(`flux-v1 worker: channelCount ${channelCount} != channels.length ${channels.length}`);
  }
  const first = channels[0]?.length ?? 0;
  for (let ch = 0; ch < channels.length; ch++) {
    if (channels[ch]!.length !== first) {
      throw new Error(`flux-v1 worker: channel ${ch} length ${channels[ch]!.length} != channel 0 length ${first}`);
    }
  }
}

// ------------------------------------------------------------------ onsets
/**
 * Normalize an envelope to `[0, 1)`:
 *
 *   `out[i] = (x[i] − min(x)) / (range + ε)`, `range = max(x) − min(x)`
 *
 * The minimum maps to exactly 0 and the maximum maps to just under 1 (never
 * exactly 1). `ε` is RELATIVE — `range * (1 + Number.EPSILON)` — because the
 * `librosa`/Python formulation adds an ABSOLUTE `tiny` (`np.finfo(float32).tiny`
 * ≈ 1.18e-38) to the max; in float64 such an addend is far below the ULP of a
 * normal range and vanishes, so the peak would land on exactly 1.0. Scaling the
 * range by one epsilon instead keeps the peak strictly below 1 while leaving
 * every other value unchanged to within one ULP.
 *
 * This is the same normalization `airhythm/baseline.py:normalize_envelope`
 * performs, to the last ULP: the Python side divides by a float32 `max + tiny`
 * and so can yield exactly 1.0 for the peak, while this side yields
 * `1 / (1 + Number.EPSILON)` ≈ 0.9999999999999997.
 *
 * The degenerate all-equal envelope (`range === 0`) divides by `ENVELOPE_TINY`
 * so the result is 0 rather than NaN.
 *
 * Returns a Float64Array (JS numbers — all subsequent math is float64).
 */
export function normalizeEnvelope(x: Float32Array | Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  // "max strictly < 1": a float32 `tiny` addend vanishes in float64 (the peak
  // would round to exactly 1.0), so the guard is RELATIVE. ENVELOPE_TINY still
  // guards the degenerate all-equal (range 0) case.
  const scale = range === 0 ? ENVELOPE_TINY : range * (1 + Number.EPSILON);
  for (let i = 0; i < n; i++) out[i] = (x[i]! - min) / scale;
  return out;
}

/**
 * `librosa.util.peak_pick` semantics, verbatim:
 *   x[i] ≥ delta
 *   x[i] == max(x[i−pre_max … i+post_max])
 *   x[i] ≥ mean(x[i−pre_avg … i+post_avg]) + delta
 *   i − last_onset ≥ wait
 * Window edges clamp to the array bounds (librosa's behavior).
 */
export function peakPick(x: ArrayLike<number>): number[] {
  const n = x.length;
  const picked: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    if (v < ONSET_DELTA) continue;
    let localMax = -Infinity;
    for (let j = Math.max(0, i - ONSET_PRE_MAX); j <= Math.min(n - 1, i + ONSET_POST_MAX); j++) {
      if (x[j]! > localMax) localMax = x[j]!;
    }
    if (v !== localMax) continue;
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - ONSET_PRE_AVG); j <= Math.min(n - 1, i + ONSET_POST_AVG); j++) {
      sum += x[j]!;
      count++;
    }
    if (v < sum / count + ONSET_DELTA) continue;
    if (i - last < ONSET_WAIT) continue;
    picked.push(i);
    last = i;
  }
  return picked;
}

/** Convert a flux frame index to ms — PLAN §13.1: `round(frame × hop / sr × 1000)`. */
export function frameToMs(frame: number, sampleRate: number, hop: number): number {
  return Math.round((frame * hop * 1000) / sampleRate);
}

/** Peak-pick the flux curve into onsets (ms + normalized confidence). */
export function onsetsFromFlux(flux: Float32Array, sampleRate: number, hop: number): Onset[] {
  const env = normalizeEnvelope(flux);
  return peakPick(env).map((f) => ({ tMs: frameToMs(f, sampleRate, hop), confidence: env[f]! }));
}

/** Convenience whole-buffer path (Vitest rows / offline): mono → flux → onsets. */
export function detectOnsets(mono: Float32Array, sampleRate = PINNED_PREPROC.sr): Onset[] {
  if (sampleRate !== PINNED_PREPROC.sr) {
    throw new Error(`detectOnsets: sampleRate ${sampleRate} !== pinned ${PINNED_PREPROC.sr}`);
  }
  return onsetsFromFlux(computeFlux(mono, PINNED_PREPROC), sampleRate, PINNED_PREPROC.hop);
}

// ------------------------------------------------------------------ beat tracking (Q24)
export interface BeatInfo {
  bpm: number;
  confidence: number;
  timingSource: "detected" | "manual";
}

/**
 * Tempogram on the onset curve: normalized autocorrelation of the envelope over
 * lags corresponding to 60–200 BPM. Low confidence (or a silent curve) falls back
 * to a constant 120 BPM with `gen.timingSource = "manual"` (Q24).
 */
export function detectBeat(flux: Float32Array, sampleRate = PINNED_PREPROC.sr, hop = PINNED_PREPROC.hop): BeatInfo {
  const env = normalizeEnvelope(flux);
  const n = env.length;
  const manual: BeatInfo = { bpm: BEAT_FALLBACK_BPM, confidence: 0, timingSource: "manual" };
  if (n < 2) return manual;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i]!;
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const d = env[i]! - mean;
    energy += d * d;
  }
  if (energy <= 1e-12) return manual;
  const fps = sampleRate / hop;
  const lagMin = Math.max(1, Math.floor((fps * 60) / BEAT_MAX_BPM));
  const lagMax = Math.min(n - 1, Math.ceil((fps * 60) / BEAT_MIN_BPM));
  let best = 0;
  let bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += (env[i]! - mean) * (env[i + lag]! - mean);
    const score = acc / energy;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || best < BEAT_CONFIDENCE_MIN) return { ...manual, confidence: best };
  const bpm = Math.round(((60 * fps) / bestLag) * 10) / 10;
  return { bpm, confidence: best, timingSource: "detected" };
}

// ------------------------------------------------------------------ candidate assembly
export interface AudioMetaForGeneration {
  sampleRate: number;
  durationMs: number;
}

/**
 * The WORKER-side generation core: onsets → density → lane assignment → beat
 * tracking → a raw `BeatmapCandidate`. Synchronous and deterministic (the PRNG
 * is seeded from `options.seed`; no wall clock, no `Math.random`).
 *
 * `flux` is the flat frame-major T24 flux sequence for the whole track.
 */
export function generateCandidateFromFlux(
  flux: Float32Array,
  meta: AudioMetaForGeneration,
  options: ResolvedGenerateOptions,
): BeatmapCandidate {
  const sampleRate = meta.sampleRate;
  const e = PINNED_PREPROC;
  const onsets = onsetsFromFlux(flux, sampleRate, e.hop);
  const beat = detectBeat(flux, sampleRate, e.hop);

  const rng = mulberry32(options.seed);
  const kept = selectDensity(onsets, options.targetNps);
  let drafts: NoteDraft[] = assignLanes(kept, rng, {
    chordProbability: CHORD_PROBABILITY,
    holdProbability: HOLD_PROBABILITY,
    holdDurationMs: HOLD_DURATION_MS,
    durationMs: meta.durationMs,
  });
  drafts = enforceNoteDensity(drafts, options.targetNps);

  const chart = assembleChart(drafts, meta, options, beat);
  return {
    chart,
    generatorId: "flux-v1",
    generatorVersion: "1",
    audioHash: options.audioHash,
    seed: options.seed,
    targetNps: options.targetNps,
    density: options.density,
    timingSource: beat.timingSource,
  };
}

/** Convenience whole-buffer path (Vitest rows): mono → flux → candidate. */
export function generateCandidate(
  mono: Float32Array,
  meta: AudioMetaForGeneration,
  options: ResolvedGenerateOptions,
): BeatmapCandidate {
  if (meta.sampleRate !== PINNED_PREPROC.sr) {
    throw new Error(`generateCandidate: sampleRate ${meta.sampleRate} !== pinned ${PINNED_PREPROC.sr}`);
  }
  return generateCandidateFromFlux(computeFlux(mono, PINNED_PREPROC), meta, options);
}

function assembleChart(
  drafts: NoteDraft[],
  meta: AudioMetaForGeneration,
  options: ResolvedGenerateOptions,
  beat: BeatInfo,
): Beatmap {
  const durationMs = Math.max(1, Math.round(meta.durationMs));
  const notes = [...drafts]
    .sort((a, b) => a.t - b.t || a.lane - b.lane)
    .map((n) => {
      const t = Math.min(durationMs, Math.max(0, Math.round(n.t)));
      const holdFits = n.type === "hold" && n.d !== undefined && t + n.d <= durationMs;
      return holdFits
        ? { id: 0, t, lane: n.lane, type: "hold" as const, d: n.d! }
        : { id: 0, t, lane: n.lane, type: "tap" as const };
    })
    .map((n, i) => ({ ...n, id: i }));
  const chart: Beatmap = {
    version: 1,
    meta: {
      title: "Generated chart",
      artist: "flux-v1",
      creator: "flux-v1",
      difficulty: "auto",
      tags: ["flux-v1"],
      previewMs: 0,
    },
    song: {
      songKey: `file:${options.audioHash}`,
      durationMs,
      audioOffsetMs: 0,
    },
    timing: [{ t: 0, bpm: beat.bpm, meter: 4 }],
    keys: 4,
    notes,
    pulses: [],
    gen: { source: "ai", model: "flux-v1", timingSource: beat.timingSource },
  };
  return parseBeatmap(chart); // the core validates too — the adapter re-validates at its boundary
}

// ------------------------------------------------------------------ main-thread adapter
/**
 * Generate a chart through an injected Worker port. This is the whole
 * `ChartGenerator` body except for the real-`Worker` construction, so Vitest can
 * drive it with a fake (the R14/T24 rule: no `new Worker` in unit tests).
 *
 * Contract (frozen Round-11):
 *   1. cancel: `AbortSignal` → `generate-cancel` → worker replies
 *      `generate-error { code: "cancelled" }` → reject (worker terminated).
 *   2. error delivery: a worker `generate-error` rejects with the SAME structured
 *      code — never a generic exception.
 *   3. no chunk loss: at most one chunk is ever outstanding; on cancel the loop
 *      returns and drops its held chunk (nothing is queued).
 */
export async function generateWithPort(
  audio: AudioBuffer,
  opts: GenerateOptions,
  port: FluxWorkerPort,
): Promise<BeatmapCandidate> {
  const targetNps = opts.targetNps ?? DEFAULT_TARGET_NPS;
  const density = opts.density ?? 0;
  const seed = await computeLaneSeed(opts.audioHash, { targetNps, density });
  const options: ResolvedGenerateOptions = { audioHash: opts.audioHash, targetNps, density, seed };
  const requestId = crypto.randomUUID();

  // Rate contract: the analysis layer runs at the pinned 22050 Hz. A decoded buffer at
  // another rate is resampled on the MAIN thread (toAnalysisPcm) before any chunk exists.
  const pcm = audio.sampleRate === PINNED_PREPROC.sr ? null : await toAnalysisPcm(audio, PINNED_PREPROC.sr);
  const source: CopySamplesSource =
    pcm === null
      ? audio
      : {
          sampleRate: pcm.sampleRate,
          numberOfChannels: pcm.channels.length,
          length: pcm.channels[0]?.length ?? 0,
          copyFromChannel(dest: Float32Array, channel: number, offset = 0): void {
            dest.set(pcm.channels[channel]!.subarray(offset, offset + dest.length), 0);
          },
        };
  const sampleRate = pcm?.sampleRate ?? audio.sampleRate;
  const totalSamples = source.length;
  const durationMs = Math.max(1, Math.round((totalSamples * 1000) / sampleRate));

  return new Promise<BeatmapCandidate>((resolve, reject) => {
    let settled = false;
    let acksSeen = 0;
    let posted = 0;
    const ackWaiters: Array<() => void> = [];
    let abortHandler: (() => void) | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    /** The ADAPTER's own outstanding count (posted − acked). Never exceeds 1. */
    const outstanding = (): number => posted - acksSeen;

    const cleanup = (): void => {
      off();
      if (deadline !== null) clearTimeout(deadline);
      if (abortHandler !== null) opts.signal?.removeEventListener("abort", abortHandler);
      // Drain every pending ack waiter: the sender may be parked at the ack gate
      // (awaiting an ack that will never come). Without this the suspended
      // `for await` frame never resumes, so the un-transferred next chunk is
      // retained and the held chunk is never released (contract 3).
      const waiters = ackWaiters.splice(0, ackWaiters.length);
      for (const release of waiters) release();
      // The held chunk (posted, never acked) is dropped here: the adapter keeps
      // no pending chunk buffers after settle.
      if (outstanding() > 0) {
        posted = acksSeen;
        opts.probe?.onReleased?.();
        opts.probe?.onPosted?.(0);
      }
      port.terminate?.();
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const cancel = (code: FluxGenerateErrorCode, message?: string): void => {
      if (settled) return;
      // Claim the settlement BEFORE posting: the Worker's `generate-error` reply
      // can arrive synchronously (a fake port) and must NOT preempt the adapter's
      // own reason — e.g. the Q10 budget's `timeout` must not be reported as the
      // worker's `cancelled`.
      settled = true;
      port.post({ type: "generate-cancel", requestId });
      cleanup();
      reject(new FluxGenerateError(code, message));
    };

    const off = port.onMessage((msg) => {
      switch (msg.type) {
        case "ack":
          acksSeen++;
          ackWaiters.shift()?.();
          return;
        case "generate-progress": {
          const processedFrames = (msg as { processedFrames: number }).processedFrames;
          const pct = totalSamples === 0 ? 100 : Math.min(100, (processedFrames / totalSamples) * 100);
          opts.onProgress?.({ startFrame: (msg as { startFrame: number }).startFrame, processedFrames, pct });
          return;
        }
        case "generate-done": {
          const candidate = (msg as { candidate: BeatmapCandidate }).candidate;
          try {
            parseBeatmap(candidate.chart); // the adapter owns the validation boundary
            finish(() => resolve(candidate));
          } catch (err) {
            finish(() =>
              reject(new FluxGenerateError("validation", err instanceof Error ? err.message : String(err))),
            );
          }
          return;
        }
        case "generate-error": {
          const m = msg as { code: FluxWorkerErrorCode; message?: string };
          finish(() => reject(new FluxGenerateError(m.code, m.message)));
          return;
        }
        default:
          return; // T24 features/done are the analysis stream's, not this contract's
      }
    });

    // Q10: over the budget → Retry/Cancel in the UI (structured `timeout`, never a
    // silent generator switch — flux-v1 is the only generator and stays the one used).
    const timeoutMs = opts.timeoutMs ?? FLUX_GENERATION_TIMEOUT_MS;
    deadline = setTimeout(() => cancel("timeout", `generation exceeded ${timeoutMs} ms`), timeoutMs);
    if (opts.signal) {
      abortHandler = () => cancel("cancelled", "aborted");
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener("abort", abortHandler, { once: true });
    }
    if (settled) return;

    port.post({
      type: "generate-request",
      audioChunks: [], // streamed via the T24 chunk protocol (see FluxV1InMessage)
      sampleRate,
      channelCount: source.numberOfChannels,
      startFrame: 0,
      options,
    });

    void (async () => {
      try {
        let cursor = 0;
        // Ack-gated stream mirroring `streamChunks`: at most ONE chunk outstanding.
        // (It is inlined rather than reused because the Round-11 cancel contract needs
        // an abort-aware gate; the T24 sender is deliberately left unchanged.)
        for await (const chunk of copySamplesForAnalysis(source)) {
          if (settled) break;
          if (chunk.startFrame !== cursor) {
            throw new Error(`flux-v1: chunk startFrame ${chunk.startFrame} != expected ${cursor}`);
          }
          if (posted > 0) {
            const target = posted; // wait for the ack of the previously posted chunk
            await new Promise<void>((release) => {
              if (settled) return release();
              if (acksSeen >= target) return release();
              ackWaiters.push(release);
            });
          }
          if (settled) break;
          posted++;
          opts.probe?.onPosted?.(outstanding());
          cursor += chunk.channels[0]?.length ?? 0;
          port.post(
            {
              type: "chunk",
              startFrame: chunk.startFrame,
              sampleRate: chunk.sampleRate,
              channelCount: chunk.channelCount,
              channels: chunk.channels,
            },
            chunk.channels.map((c) => c.buffer),
          );
        }
        // Cancelled mid-stream: the held chunk was already dropped by `cleanup`
        // (the adapter holds no pending chunk buffers after settle — contract 3),
        // and no `flush` is posted to a worker that is being torn down.
        if (settled) return;
        port.post({ type: "flush" });
      } catch (err) {
        finish(() =>
          reject(new FluxGenerateError("internal", err instanceof Error ? err.message : String(err))),
        );
      } finally {
        // The streaming loop EXITED. This only fires when the parked sender was
        // actually unwound — without the ack-waiter drain the loop stays suspended
        // at the gate forever and this never runs.
        opts.probe?.onStreamEnd?.();
      }
    })();
  });
}

/** The real Worker port (browser only — never constructed in unit tests). */
export function createFluxV1WorkerPort(): FluxWorkerPort {
  const worker = new Worker(new URL("./flux-v1.worker.js", import.meta.url), { type: "module" });
  return {
    post: (msg, transfer) => worker.postMessage(msg, transfer ?? []),
    onMessage: (cb) => {
      const handler = (e: MessageEvent): void => cb(e.data);
      worker.addEventListener("message", handler);
      return () => worker.removeEventListener("message", handler);
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Build a `ChartGenerator` over an injected Worker port factory — the seam the
 * unit test uses to drive the PUBLIC `ChartGenerator` surface (production uses
 * `createFluxV1WorkerPort`).
 */
export function createFluxV1Generator(
  createPort: () => FluxWorkerPort = createFluxV1WorkerPort,
): ChartGenerator {
  return {
    id: "flux-v1",
    generate(audio, opts) {
      return generateWithPort(
        audio,
        {
          ...opts,
          // R17: `ChartGenerator.onProgress` is `(p: number)` (percent); the internal
          // `GenerateOptions.onProgress` is `(p: GenerateProgress)`. Map at this boundary.
          onProgress: opts.onProgress ? (p) => opts.onProgress!(p.pct) : undefined,
        },
        createPort(),
      );
    },
  };
}

/** The frozen `ChartGenerator`. The Worker owns the heavy computation. */
export const fluxV1: ChartGenerator = createFluxV1Generator();
