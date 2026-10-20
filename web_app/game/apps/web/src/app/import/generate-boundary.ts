// apps/web/src/app/import/generate-boundary.ts
//
// W3 T25b fix r1 — the ONE boundary a generated chart crosses before it is
// stored, extracted as a pure function so it can be unit-tested.
//
// The bug this fixes: `page.tsx` handed `candidate.chart` straight to
// `importChartWithAudio`, which only `parseBeatmap`s. `assembleChart` (in
// `packages/chartgen/src/flux-v1.ts`) emits notes with NO `tier`, while every
// IMPORTED row carries `tier: "primary"` (canonical.ts fills it). The two
// origins therefore produced DIFFERENT chartJson shapes — and so different
// chartHash conventions — which breaks cross-origin dedupe and any comparison
// between an imported and a generated row.
//
// The fix belongs AT THE BOUNDARY, not in the generator: emitting `tier` from
// `assembleChart` would put a web-store rule inside the pure package (R24
// rules against it). `canonicalizeBeatmap` is the shared normalizer that
// already fills `tier`, and the import path already uses it — so the generate
// path now uses the SAME normalizer.

import { canonicalizeBeatmap, type Beatmap } from "@airhythm/shared";

/**
 * The chart a generated candidate is stored as: the canonical form every
 * imported row is stored as, so both origins share one shape and one hash
 * convention. `canonicalizeBeatmap` validates, sorts and re-ids, and fills
 * `tier: "primary"` on every note.
 */
export function canonicalizeGeneratedChart(chart: unknown): Beatmap {
  return canonicalizeBeatmap(chart);
}
