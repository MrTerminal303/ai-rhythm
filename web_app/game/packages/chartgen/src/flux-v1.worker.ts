import { FluxChunker } from "./chunking.js";
import {
  PINNED_PREPROC,
  generateCandidateFromFlux,
  validateFluxChannels,
  type FluxV1InMessage,
  type FluxV1OutMessage,
  type ResolvedGenerateOptions,
} from "./flux-v1.js";
import { toMono } from "./mel.js";

/**
 * flux-v1 Worker entry (R14/T24): the browser-side bootstrap that wires the
 * frozen Round-11 message contract to the pure generation core.
 *
 * `self.onmessage` receives `generate-request` (options up front), then the T24
 * `chunk` stream (one at a time — the main thread withholds the next chunk until
 * this worker's `ack`), then `flush`. Flux frames are accumulated as NUMBERS
 * (never row references, which are transferred/detached — T24 review r1).
 *
 * `generate-cancel` stops processing and replies `generate-error { code: "cancelled" }`.
 * Any exception is delivered as a structured `generate-error` (never thrown into
 * the void): the adapter always has a reply to settle on.
 *
 * Vitest never constructs this module's Worker; it drives `generateWithPort`
 * with a fake port instead. The browser bootstrap is e2e-gated.
 */

const post = (msg: FluxV1OutMessage, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(msg, transfer);
};

let request: { options: ResolvedGenerateOptions; sampleRate: number; channelCount: number; expectedStart: number } | null = null;
let chunker: FluxChunker | null = null;
let fluxValues: number[] = [];
let totalSamples = 0;
let cancelled = false;

self.onmessage = (e: MessageEvent<FluxV1InMessage | { type: "chunk" | "flush"; [k: string]: unknown }>): void => {
  const msg = e.data;
  try {
    if (cancelled) return;
    switch (msg.type) {
      case "generate-request": {
        const m = msg as Extract<FluxV1InMessage, { type: "generate-request" }>;
        if (m.sampleRate !== PINNED_PREPROC.sr) {
          throw new Error(`flux-v1 worker: sampleRate ${m.sampleRate} !== pinned ${PINNED_PREPROC.sr}`);
        }
        request = { options: m.options, sampleRate: m.sampleRate, channelCount: m.channelCount, expectedStart: m.startFrame };
        chunker = new FluxChunker(PINNED_PREPROC);
        fluxValues = [];
        totalSamples = 0;
        cancelled = false;
        return;
      }
      case "chunk": {
        if (!request || !chunker) throw new Error("flux-v1 worker: chunk with no active request");
        const m = msg as unknown as {
          startFrame: number;
          sampleRate: number;
          channelCount: number;
          channels: Float32Array[];
        };
        if (m.startFrame !== request.expectedStart) {
          throw new Error(`flux-v1 worker: chunk startFrame ${m.startFrame} != expected ${request.expectedStart}`);
        }
        // T24 R16: channelCount must match channels.length AND every channel must
        // carry the SAME length — `toMono` reads `right[i]` up to `first.length`;
        // a short channel yields `undefined` → NaN, which `chunkFrame` silently
        // turns into 0 (plausibly shaped but wrong flux, with no error).
        validateFluxChannels(m.channels, m.channelCount);
        const mono = toMono(m.channels);
        const batch = chunker.consume(mono, m.startFrame);
        for (const row of batch.frames) fluxValues.push(row[0] ?? 0);
        totalSamples += mono.length;
        request.expectedStart += mono.length;
        post({ type: "generate-progress", startFrame: m.startFrame, processedFrames: totalSamples });
        // Ack AFTER consuming — this is what gates the next chunk (T24 backpressure).
        (self as unknown as Worker).postMessage({ type: "ack", startFrame: m.startFrame });
        return;
      }
      case "flush": {
        if (!request || !chunker) throw new Error("flux-v1 worker: flush with no active request");
        const batch = chunker.flush(totalSamples);
        for (const row of batch.frames) fluxValues.push(row[0] ?? 0);
        const t0 = performance.now();
        const flux = Float32Array.from(fluxValues);
        const candidate = generateCandidateFromFlux(
          flux,
          { sampleRate: request.sampleRate, durationMs: (totalSamples * 1000) / request.sampleRate },
          request.options,
        );
        post({ type: "generate-done", candidate, elapsedMs: performance.now() - t0 });
        request = null;
        chunker = null;
        fluxValues = [];
        totalSamples = 0;
        return;
      }
      case "generate-cancel": {
        cancelled = true;
        request = null;
        chunker = null;
        fluxValues = [];
        post({ type: "generate-error", code: "cancelled" });
        return;
      }
      default:
        return;
    }
  } catch (err) {
    post({
      type: "generate-error",
      code: "internal",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
