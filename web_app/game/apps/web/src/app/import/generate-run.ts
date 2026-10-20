// apps/web/src/app/import/generate-run.ts
//
// W3 T25b fix r1 — the app's own call into the `flux-v1` generator, with the
// Q10 budget as an APP-owned knob.
//
// Why this is not just `fluxV1.generate(buffer, { audioHash, onProgress, signal })`:
// `ChartGenerator.generate`'s option type does NOT declare `timeoutMs`, but
// `createFluxV1Generator` forwards EVERY option it is handed to
// `generateWithPort`, whose `GenerateOptions` DOES declare `timeoutMs` (25a
// exported it for exactly this purpose). The Q10 budget therefore has to travel
// through the option bag, and the bag is widened HERE, explicitly, rather than
// with a cast at the call site.
//
// This is still ONE runtime path: `fluxV1` is `createFluxV1Generator()`, i.e.
// `generateWithPort(audio, opts, createFluxV1WorkerPort())` — the same adapter,
// the same Worker, the same validation boundary. The wrapper only adds the
// budget and the percentage mapping the app needs.

import { fluxV1, type BeatmapCandidate } from "@airhythm/chartgen";

/** The options the app drives a generation with. */
export interface RunGenerateOptions {
  audioHash: string;
  /** The Q10 budget in ms — the generator rejects with a `timeout` code past it. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Progress in PERCENTAGES (0–100) — the app's rendering unit. */
  onProgress?: (pct: number) => void;
}

/** The option bag `fluxV1.generate` accepts, widened with the Q10 budget. */
type GeneratorOptions = Parameters<typeof fluxV1.generate>[1] & { timeoutMs: number };

/**
 * Run the `flux-v1` generator under a caller-supplied budget.
 *
 * The candidate's chart is NOT canonicalized here: canonicalization is a
 * WEB-STORE rule and belongs at the store boundary (see `generate-boundary.ts`).
 */
export async function runFluxV1(
  audio: AudioBuffer,
  opts: RunGenerateOptions,
): Promise<BeatmapCandidate> {
  const generatorOptions: GeneratorOptions = {
    audioHash: opts.audioHash,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onProgress: opts.onProgress,
  };
  return fluxV1.generate(audio, generatorOptions);
}
