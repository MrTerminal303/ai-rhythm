// packages/chartgen/src/types.ts
// R9 interface ownership (W3 T24): T24 DEFINES BOTH `ChartGenerator` and
// `BeatmapCandidate` in `packages/chartgen` and exports them. T25's brief
// claims they come from "PLAN §13.3", but that section defines NO TypeScript
// interface — the T25 lane-assign + density + beat-tracking run on the
// Worker and post `generate-done` with a `candidate: BeatmapCandidate`.

import type { Beatmap } from "@airhythm/shared";

/**
 * `BeatmapCandidate` — the pre-validation shape that T25's Worker produces
 * and T25's message contract names (`audioHash`, `options`, `seed`).
 *
 * Keep the metadata fields to the ones T25's message contract names; do not
 * invent extras. The `chart` field is the `Beatmap` shape (T25 validates it
 * against `beatmapSchema` before posting `generate-done`).
 */
export interface BeatmapCandidate {
  /** Pre-validation beatmap shape — T25 validates before publishing. */
  chart: Beatmap;
  generatorId: string;
  generatorVersion: string;
  audioHash: string;
  seed: number;
  targetNps: number;
  density: number;
  timingSource: "imported" | "detected" | "manual";
}

/**
 * `ChartGenerator` — the interface T25's flux-v1 implementation satisfies.
 * T24 only DEFINES it; the flux-v1 implementation is T25's.
 *
 * `generate` runs on the Worker (T25), streaming progress via `onProgress`;
 * the caller may abort via `signal`. The returned `BeatmapCandidate` is
 * posted as `generate-done` in T25's message contract.
 */
export interface ChartGenerator {
  id: string;
  generate(
    audio: AudioBuffer,
    opts: {
      audioHash: string;
      targetNps?: number;
      density?: number;
      onProgress?: (p: number) => void;
      signal?: AbortSignal;
    },
  ): Promise<BeatmapCandidate>;
}
