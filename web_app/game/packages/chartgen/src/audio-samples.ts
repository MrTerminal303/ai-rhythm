/**
 * D30 frozen chunk rule — copy, not view (review P0).
 *
 * The analysis Worker NEVER receives an `AudioBuffer`: `postMessage` (and
 * `structuredClone`) of an `AudioBuffer` throws `DataCloneError` — it is not
 * structured-cloneable, unlike `ArrayBuffer` (pinned by the real-engine e2e
 * `e2e/w3-worker-contract.spec.ts`). The main thread therefore copies the
 * playback buffer out via `copyFromChannel` into owned `Float32Array`s and
 * transfers the backing `ArrayBuffer`s in bounded chunks. The playback buffer
 * is never detached, mutated, or read by the Worker.
 *
 * Residency bound: a chunk carries at most `maxSeconds` of samples resident in
 * the Worker at once (default 30 s). `maxSeconds` clamps the default DOWN to
 * a test-friendly bound; it is never raised above the default.
 *
 * This module is framing-agnostic — it copies, it does not frame. `chunking.ts`
 * owns the nFft/hop framing state and is the sole consumer of `PreprocParams`
 * in the copy path; `flux.ts` reuses mel.ts's FFT internals read-only.
 */

const DEFAULT_MAX_SECONDS = 30;
const MIN_MAX_SECONDS = 0.01;

/** One bounded chunk of the analysis stream — all channels + explicit framing. */
export interface AnalysisSampleChunk {
  /** Absolute sample offset of this chunk's first sample in the full stream. */
  startFrame: number;
  sampleRate: number;
  channelCount: number;
  /** Owned `Float32Array`s (one per channel) — the caller transfers `.buffer`. */
  channels: Float32Array[];
}

export interface CopySamplesOptions {
  /** Residency bound in seconds. Defaults to 30, clamped to `[0.01, 30]`. */
  maxSeconds?: number;
}

/**
 * The minimal `AudioBuffer` surface `copySamplesForAnalysis` consumes. A real
 * `AudioBuffer` satisfies this structurally; the unit test drives a fake (a
 * real `AudioBuffer` is not structured-cloneable — the D30 premise pinned by
 * the e2e, not by the Node test).
 */
export interface CopySamplesSource {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  copyFromChannel(dest: Float32Array, channel: number, offset?: number): void;
}

/**
 * Copy samples out of an `AudioBuffer` into owned `Float32Array` chunks. Each
 * chunk carries ALL channels + explicit `startFrame`/`sampleRate`/
 * `channelCount` — the D30 chunk contract.
 *
 * - **Copies, never slices**: each channel's range is `copyFromChannel`'d into
 *   a fresh `Float32Array` — the playback buffer's backing store is left
 *   intact (verified pre/post copy in `audio-samples.test.ts`).
 * - **Owns the `ArrayBuffer` it will transfer**: `channels[i].buffer` is a
 *   fresh allocation the caller posts into the Worker's transfer list.
 * - **Chunk size**: `Math.floor(maxSeconds * sampleRate)` samples per chunk
 *   (`maxSeconds` clamped to `[0.01, 30]`), so ≤ 30 s of samples are ever
 *   resident in the Worker at once.
 */
export async function* copySamplesForAnalysis(
  buffer: CopySamplesSource,
  opts?: CopySamplesOptions,
): AsyncGenerator<AnalysisSampleChunk> {
  const maxSeconds = clampMaxSeconds(opts?.maxSeconds);
  const { sampleRate, numberOfChannels: channelCount, length } = buffer;
  const chunkSamples = Math.max(1, Math.floor(maxSeconds * sampleRate));
  for (let startFrame = 0; startFrame < length; startFrame += chunkSamples) {
    const count = Math.min(chunkSamples, length - startFrame);
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < channelCount; ch++) {
      const out = new Float32Array(count);
      buffer.copyFromChannel(out, ch, startFrame);
      channels.push(out);
    }
    yield { startFrame, sampleRate, channelCount, channels };
  }
}

/** Clamp `maxSeconds` into `[MIN_MAX_SECONDS, DEFAULT_MAX_SECONDS]`. */
export function clampMaxSeconds(maxSeconds?: number): number {
  if (maxSeconds === undefined) return DEFAULT_MAX_SECONDS;
  return Math.min(Math.max(maxSeconds, MIN_MAX_SECONDS), DEFAULT_MAX_SECONDS);
}
