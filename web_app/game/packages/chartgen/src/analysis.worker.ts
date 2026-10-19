import { FluxChunker } from "./chunking.js";
import { toMono, type PreprocParams } from "./mel.js";
import { analyzeWhole } from "./reference.js";

/**
 * D30 frozen chunk rule (W3 T24) — the analysis-Worker protocol.
 *
 * The analysis Worker NEVER receives an `AudioBuffer`: `postMessage`/
 * `structuredClone` of an `AudioBuffer` throws `DataCloneError` (it is not
 * structured-cloneable, unlike `ArrayBuffer` — pinned in a real engine by
 * `e2e/w3-worker-contract.spec.ts`). The main thread extracts playback
 * samples via `copyFromChannel` into owned `Float32Array`s and transfers the
 * backing `ArrayBuffer`s in bounded chunks. The playback buffer is never
 * detached or mutated; the Worker's streaming protocol is the ONLY path
 * into the analysis layer.
 *
 * Backpressure (review P0): the Worker posts `{ type: "ack", startFrame }`
 * after fully consuming a chunk; the main-thread sender keeps AT MOST ONE
 * outstanding un-acked chunk (`streamChunks`). A Worker that withholds
 * `ack` STALLS the sender, enforcing the ≤ 30 s residency bound.
 *
 * Worker testability (ruling c): `createAnalysisWorkerHandler` is a PURE
 * protocol handler — `message in → messages out + state` — that vitest unit
 * tests drive directly with a fake "Worker" (in-memory object, no
 * `new Worker`). The handler accumulates flux as NUMBERS, never as row
 * references: the `features` rows are transferred (detached) by the caller,
 * so holding them would make `done.flux` read zeroes (T24 review r1).
 */

// ------------------------------------------------------------------ message types
/** Inbound Worker message (main → Worker). */
export type AnalysisWorkerInMessage =
  | {
      type: "chunk";
      startFrame: number;
      sampleRate: number;
      channelCount: number;
      channels: Float32Array[];
    }
  | { type: "flush" }
  | {
      type: "analyze-whole";
      sampleRate: number;
      channelCount: number;
      channels: Float32Array[];
    };

/** Outbound Worker message (Worker → main). */
export type AnalysisWorkerOutMessage =
  | { type: "features"; frames: Float32Array[]; startFrame: number }
  | { type: "ack"; startFrame: number }
  | { type: "done"; flux: Float32Array; mel?: Float32Array[] };

// ------------------------------------------------------------------ pure handler
/** Pure protocol handler: `message in → messages out + state` (ruling c). */
export interface AnalysisWorkerHandler {
  handle(msg: AnalysisWorkerInMessage): AnalysisWorkerOutMessage[];
}

/**
 * Create the pure protocol handler. Driven by vitest with a fake Worker
 * (no `new Worker`); T25's Worker entry wires it to a real `Worker`.
 */
export function createAnalysisWorkerHandler(preproc: PreprocParams): AnalysisWorkerHandler {
  const chunker = new FluxChunker(preproc);
  let totalSamples = 0;
  let expectedStart = 0;
  // Flux accumulated as NUMBERS: the per-frame rows handed to `features` are
  // transferred (their buffers detached) by the caller, so any row reference
  // held here would read as zeroes at flush time (T24 review r1, Critical 1).
  const fluxValues: number[] = [];

  return {
    handle(msg: AnalysisWorkerInMessage): AnalysisWorkerOutMessage[] {
      if (msg.type === "chunk") {
        if (msg.startFrame !== expectedStart) {
          throw new Error(`analysis worker: chunk startFrame ${msg.startFrame} != expected ${expectedStart}`);
        }
        if (msg.sampleRate !== preproc.sr) {
          throw new Error(`analysis worker: sampleRate ${msg.sampleRate} !== preproc.sr ${preproc.sr}`);
        }
        validateChannels(msg.channels, msg.channelCount);
        const mono = toMono(msg.channels);
        const batch = chunker.consume(mono, msg.startFrame);
        totalSamples += mono.length;
        expectedStart += mono.length;
        if (batch.frames.length > 0) {
          for (const row of batch.frames) fluxValues.push(row[0] ?? 0);
        }
        const out: AnalysisWorkerOutMessage[] = [];
        if (batch.frames.length > 0) {
          out.push({ type: "features", frames: batch.frames, startFrame: batch.firstFrame });
        }
        out.push({ type: "ack", startFrame: msg.startFrame });
        return out;
      }

      if (msg.type === "flush") {
        const batch = chunker.flush(totalSamples);
        if (batch.frames.length > 0) {
          for (const row of batch.frames) fluxValues.push(row[0] ?? 0);
        }
        const out: AnalysisWorkerOutMessage[] = [];
        if (batch.frames.length > 0) {
          out.push({ type: "features", frames: batch.frames, startFrame: batch.firstFrame });
        }
        out.push({ type: "done", flux: Float32Array.from(fluxValues) });
        return out;
      }

      // analyze-whole — reference mode (whole buffer, no chunking)
      validateChannels(msg.channels, msg.channelCount);
      const mono = toMono(msg.channels);
      const ref = analyzeWhole(mono, msg.sampleRate, preproc, true);
      return [
        {
          type: "done",
          flux: ref.flux,
          // `WholeReference.mel` is already per-frame rows — pass straight through.
          mel: ref.mel,
        },
      ];
    },
  };
}

/**
 * Reject a malformed chunk before any down-mix: `channelCount` must match
 * `channels.length`, and every channel must carry the SAME length (`toMono`
 * reads `right[i]` up to `first.length`; a short channel would yield
 * `undefined` → NaN, which `chunkFrame` silently turns into 0 — plausibly
 * shaped but wrong flux with no error). T24 review r1, R16.
 */
function validateChannels(channels: Float32Array[], channelCount: number): void {
  if (channelCount !== channels.length) {
    throw new Error(`analysis worker: channelCount ${channelCount} != channels.length ${channels.length}`);
  }
  const first = channels[0]?.length ?? 0;
  for (let ch = 0; ch < channels.length; ch++) {
    if (channels[ch]!.length !== first) {
      throw new Error(`analysis worker: channel ${ch} length ${channels[ch]!.length} != channel 0 length ${first}`);
    }
  }
}

/** Extract `Transferable`s from an outbound Worker message (D30 transfer list). */
export function workerTransferables(m: AnalysisWorkerOutMessage): Transferable[] {
  if (m.type === "features") return m.frames.map((f) => f.buffer);
  if (m.type === "done") {
    const t: Transferable[] = [m.flux.buffer];
    if (m.mel) t.push(...m.mel.map((row) => row.buffer));
    return t;
  }
  return [];
}

