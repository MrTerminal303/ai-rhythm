import { FluxChunker } from "./chunking.js";
import { toMono, type PreprocParams } from "./mel.js";
import { analyzeWhole, flattenFluxRows } from "./reference.js";

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
 * `new Worker`). The browser-side bootstrap (`attachAnalysisWorker`) is a
 * thin exported function that e2e covers.
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
 * (no `new Worker`); the browser bootstrap `attachAnalysisWorker` wires it
 * to a real `Worker` instance.
 */
export function createAnalysisWorkerHandler(preproc: PreprocParams): AnalysisWorkerHandler {
  const chunker = new FluxChunker(preproc);
  let totalSamples = 0;
  let expectedStart = 0;
  let fluxRows: Float32Array[] = [];

  return {
    handle(msg: AnalysisWorkerInMessage): AnalysisWorkerOutMessage[] {
      if (msg.type === "chunk") {
        if (msg.startFrame !== expectedStart) {
          throw new Error(`analysis worker: chunk startFrame ${msg.startFrame} != expected ${expectedStart}`);
        }
        if (msg.sampleRate !== preproc.sr) {
          throw new Error(`analysis worker: sampleRate ${msg.sampleRate} !== preproc.sr ${preproc.sr}`);
        }
        const mono = toMono(msg.channels);
        const batch = chunker.consume(mono, msg.startFrame);
        totalSamples += mono.length;
        expectedStart += mono.length;
        if (batch.frames.length > 0) {
          fluxRows.push(...batch.frames);
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
          fluxRows.push(...batch.frames);
        }
        const out: AnalysisWorkerOutMessage[] = [];
        if (batch.frames.length > 0) {
          out.push({ type: "features", frames: batch.frames, startFrame: batch.firstFrame });
        }
        out.push({ type: "done", flux: flattenFluxRows(fluxRows) });
        return out;
      }

      // analyze-whole — reference mode (whole buffer, no chunking)
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

// ------------------------------------------------------------------ browser bootstrap
/**
 * The thin browser-side bootstrap (ruling c): wires a `Worker` instance to
 * the pure handler. Covered by e2e, not by the vitest unit suite. The
 * `Worker` is created by the caller (T25's `generate()` runs on the
 * Worker and loads `analysis.worker.ts` as its entry point).
 */
export function attachAnalysisWorker(
  preproc: PreprocParams,
  worker: Worker,
): void {
  // T25's Worker entry imports `createAnalysisWorkerHandler` from this module
  // and wires it to the `Worker`'s own `onmessage`/`postMessage`. This
  // bootstrap is the thin main-thread side: it provides the `Worker`'s
  // inbound `onmessage` + outbound `postMessage` with transfer lists.
  const handler = createAnalysisWorkerHandler(preproc);

  worker.onmessage = (ev: MessageEvent) => {
    const msgs = handler.handle(ev.data as AnalysisWorkerInMessage);
    for (const m of msgs) {
      const transferables = workerTransferables(m);
      worker.postMessage(m, transferables);
    }
  };
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

// ponytail: `AnalysisWorkerHandler`/`createAnalysisWorkerHandler`/
// `attachAnalysisWorker`/`workerTransferables` are the D30 frozen protocol.
// `chunkFrame`/`createFluxWindowState`/`FluxWindowState` are re-exported for
// the chunking test (boundary-shifted framing) but are NOT part of the
// frozen protocol — T25 does not import them. Upgrade path: if T25 needs
// a different framing shift, add a protocol message here, not a new export.
