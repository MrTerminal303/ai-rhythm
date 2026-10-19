import { chunkFrame, createFluxWindowState, type FluxWindowState } from "./flux.js";
import type { PreprocParams } from "./mel.js";

/**
 * Chunk-boundary continuity state machine (D30) + the ack-gated main-thread sender.
 *
 * Worker side (`FluxChunker`): carries an `n_fft`-sample tail across chunk
 * boundaries so spectral-flux framing is identical to a continuous stream —
 * the emitted frame sequence equals the whole-buffer reference within
 * `CHUNK_FEATURE_TOL` (see `reference.ts`) regardless of chunk size or boundary
 * placement. The prior-magnitude state needed for the half-wave rectified first
 * difference is ALSO carried (in `FluxWindowState`) — flux frame `f` depends on
 * frame `f-1`, so both the tail (window input) and the previous magnitude
 * spectrum (flux input) survive a boundary.
 *
 * Main side (`streamChunks`): the sender keeps AT MOST ONE outstanding un-acked
 * chunk (review P0 backpressure). It posts a chunk, blocks on its `ack`, then
 * posts the next. A Worker that withholds `ack` STALLS the sender — it can
 * never queue a second chunk, which is what enforces the ≤ 30 s residency
 * bound end-to-end.
 */

// --------------------------------------------------------------------------- framing math
// n_fft = 2p (p = center pad = n_fft/2). A flux frame `f` reads absolute samples
// `[f*hop - p, f*hop + p)` (identical to `computeLogMel`'s center padding).
// Chunk `k` covers absolute `[s, e)`; its local buffer is `[s - nFft, e)` —
// the retained tail plus the chunk's own samples, so local index 0 ↔ absolute
// `s - 2p`. A frame is emitted by chunk `k` iff its window fits that local
// buffer (window end ≤ e), which (given contiguous chunks) reduces to:
// fLow = lastEmitted + 1, fHigh = floor((e - p) / hop). The two
// meet exactly at chunk boundaries (a boundary falling on a hop multiple is
// emitted ONCE, by the chunk that owns its window end) — no duplicates, no gaps.

export interface FluxFrameBatch {
  /** One `Float32Array(1)` row per flux frame (the protocol layout). */
  frames: Float32Array[];
  /** Absolute stream frame index of `frames[0]` (`-1` when empty). */
  firstFrame: number;
}

export class FluxChunker {
  private tail: Float32Array;
  private expectedStart = 0;
  private emitted = 0;
  private readonly state: FluxWindowState;

  constructor(private readonly preproc: PreprocParams) {
    this.tail = new Float32Array(preproc.n_fft); // zeros = zero-pad at stream start
    this.state = createFluxWindowState(preproc);
  }

  /** Frames emitted so far (the next `consume` starts here — contiguous framing). */
  get framesEmitted(): number {
    return this.emitted;
  }

  /**
   * Consume one chunk of MONO samples starting at absolute `startFrame`.
   * Returns the flux frames this chunk owns (empty for a short chunk that
   * completes no full window — the tail still carries, framing is preserved).
   */
  consume(mono: Float32Array, startFrame: number): FluxFrameBatch {
    if (startFrame !== this.expectedStart) {
      throw new Error(`FluxChunker: chunk start ${startFrame} != expected ${this.expectedStart}`);
    }
    const nFft = this.preproc.n_fft;
    const hop = this.preproc.hop;
    const pad = nFft / 2;
    const s = startFrame;
    const e = s + mono.length;

    // Local buffer = retained tail + this chunk (absolute range [s - nFft, e)).
    const buf = new Float32Array(nFft + mono.length);
    buf.set(this.tail, 0);
    buf.set(mono, nFft);

    const fLow = this.emitted;
    const fHigh = Math.floor((e - pad) / hop);
    if (fHigh < fLow) {
      // No complete window fits this chunk yet — carry the tail, emit nothing.
      this.tail.set(buf.slice(buf.length - nFft));
      this.expectedStart = e;
      return { frames: [], firstFrame: -1 };
    }
    const frames = this.runFrames(buf, nFft, s, fLow, fHigh);
    this.tail.set(buf.slice(buf.length - nFft));
    this.expectedStart = e;
    return { frames, firstFrame: frames.length > 0 ? fLow : -1 };
  }

  /** End of stream: zero-pad past the last sample, emit the remaining frames. */
  flush(totalSamples: number): FluxFrameBatch {
    const nFft = this.preproc.n_fft;
    const hop = this.preproc.hop;
    const pad = nFft / 2;
    const fHigh = Math.floor(totalSamples / hop); // frameCount(total, hop) - 1
    const fLow = this.emitted;
    if (fHigh < fLow) return { frames: [], firstFrame: -1 };

    const s = totalSamples; // local origin = s - nFft (the retained tail)
    const needed = Math.max(0, fHigh * hop + pad - s); // zero-pad beyond the tail
    const buf = new Float32Array(nFft + Math.max(0, needed));
    buf.set(this.tail, 0);
    const frames = this.runFrames(buf, nFft, s, fLow, fHigh);
    this.expectedStart = -1; // stream finished
    return { frames, firstFrame: frames.length > 0 ? fLow : -1 };
  }

  /** Shared window/FFT/magnitude/flux loop over a local buffer. */
  private runFrames(buf: Float32Array, nFft: number, localOrigin: number, fLow: number, fHigh: number): Float32Array[] {
    const hop = this.preproc.hop;
    const pad = nFft / 2;
    const frames: Float32Array[] = [];
    for (let f = fLow; f <= fHigh; f++) {
      // Local origin = local index 0 ↔ absolute s - 2*pad, so the local start
      // of frame f (absolute f*hop - pad) is f*hop + pad - localOrigin.
      const local = f * hop + pad - localOrigin;
      const value = chunkFrame(buf, local, this.state);
      frames.push(new Float32Array([value]));
      this.emitted = f + 1;
    }
    return frames;
  }
}

// --------------------------------------------------------------------------- sender
/** Worker-port abstraction — a real `Worker` adapter and the test fake both fit this. */
export interface ChunkPort {
  post(msg: { type: string; [k: string]: unknown }, transfer?: Transferable[]): void;
  /**
   * Register an outbound-message callback (Worker → main). Returns an
   * unsubscribe function. In the real `Worker` adapter this is the
   * `onmessage` wiring; in the test fake it's a direct callback slot.
   */
  onMessage(cb: (msg: { type: string; [k: string]: unknown }) => void): () => void;
}

export interface ChunkIterableItem {
  startFrame: number;
  sampleRate: number;
  channelCount: number;
  channels: Float32Array[];
}

export interface StreamCallbacks {
  onFeatures?: (m: { frames: Float32Array[]; startFrame: number }) => void;
  onDone?: (m: { flux: Float32Array }) => void;
}

export interface StreamResult {
  /** Max outstanding (posted-but-un-acked) chunks — MUST be ≤ 1 (review P0). */
  maxOutstanding: number;
}

/**
 * Drive a chunk iterable through the ack-gated protocol: post a chunk, wait
 * for its `ack`, post the next. At most ONE chunk is ever outstanding; a
 * Worker that withholds `ack` stalls this loop rather than queueing buffers.
 *
 * Lost-wakeup-safe: an `ack` that arrives BEFORE the sender registers its
 * waiter (a synchronous Worker answers inside `post`) is absorbed into a
 * counter; `awaitAck` returns instantly when the counter is positive,
 * otherwise it queues exactly one waiter. Same shape for `done`.
 *
 * Brief contract: only chunk TRANSFERS are ack-gated — a chunk is released
 * by the gate, and an earlier released chunk is NEVER re-held by a later
 * ack. The last chunk's ack is not awaited before posting `flush`; the
 * worker's own FIFO guarantees it consumed the last chunk by the time it
 * handles `flush`, and the counter absorbs any in-flight ack.
 *
 * `outstanding` = chunks transferred, not yet released. Each gate releases
 * exactly one (the most-recently-posted — FIFO — chunk), so `outstanding`
 * never exceeds 1 at any instant.
 */
export async function streamChunks(
  iter: AsyncIterable<ChunkIterableItem>,
  port: ChunkPort,
  cbs: StreamCallbacks = {},
): Promise<StreamResult> {
  let outstanding = 0;
  let maxOutstanding = 0;
  // Delivered-ack counter + pending gates. An `ack` that lands with no gate
  // waiting is absorbed into `acksSeen` (no lost wakeup); a gate wakes ONLY
  // the single pending waiter for ITS OWN ack, so a fast worker's absorbed
  // acks can never nudge the sender more than one step ahead — `outstanding`
  // stays ≤ 1 at every instant (the review-P0 invariant this gate enforces).
  let acksSeen = 0;
  const ackWaiters: Array<{ release: () => void; ackIndex: number }> = [];
  let doneWaiters: Array<() => void> = [];
  let doneReceived = false;
  const off = port.onMessage((m) => {
    if (m.type === "ack") {
      acksSeen++;
      // Wake ONLY the gate waiting for this specific ack (FIFO — one ack per
      // consumed chunk). No matching pending gate → absorbed; the loop's next
      // gate resolves instantly against the counter instead of advancing.
      for (const w of ackWaiters) if (w.ackIndex === acksSeen - 1) w.release();
    } else if (m.type === "features") {
      const fm = m as unknown as { frames: Float32Array[]; startFrame: number };
      cbs.onFeatures?.(fm);
    } else if (m.type === "done") {
      cbs.onDone?.(m as unknown as { flux: Float32Array });
      doneReceived = true;
      const waiters = doneWaiters;
      doneWaiters = [];
      for (const w of waiters) w();
    }
  });
  /**
   * Gate before posting chunk `i` (i ≥ 1): wait for the predecessor chunk's
   * `ack` — the (i-1)-th delivered ack, strict FIFO order. Resolves instantly
   * when `acksSeen` already covers it (an early/absorbed ack); otherwise
   * queues the pending waiter, woken ONLY by the matching ack delivery. Each
   * gate consumes exactly ONE ack, so two chunks can never be outstanding
   * without two acks having been delivered.
   */
  const gate = (i: number) =>
    new Promise<void>((release) => {
      if (acksSeen >= i) return release();
      ackWaiters.push({ release, ackIndex: i - 1 });
    });

  try {
    let cursor = 0; // absolute sample offset of the next chunk
    let posted = 0; // chunks transferred so far
    for await (const chunk of iter) {
      if (cursor !== chunk.startFrame) {
        throw new Error(`streamChunks: chunk startFrame ${chunk.startFrame} != expected ${cursor} (D30 contiguous chunks)`);
      }
      if (posted > 0) {
        await gate(posted);
        outstanding--; // the predecessor chunk is released
      }
      posted++;
      outstanding++;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
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
    // Brief contract: only chunk TRANSFERS are ack-gated — the LAST chunk's
    // ack is NOT awaited before posting `flush` (absorbed into the counter;
    // the worker's own FIFO guarantees it consumed the last chunk by the
    // time it handles `flush`).
    port.post({ type: "flush" });
    await new Promise<void>((r) => {
      if (doneReceived) r();
      else doneWaiters.push(r);
    });
  } finally {
    off();
  }
  return { maxOutstanding };
}
