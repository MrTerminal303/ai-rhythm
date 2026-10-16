// apps/web/src/chart-source.ts
// W3 T15 (A5): /play's chart + audio source precedence, declared ONCE (the page and the ordering
// unit test in chart-source.test.ts both read these functions).
//
// Chart source precedence:   libraryChartId (T19) > chart=benchmark > ?import (until T20) > default w1
// Audio source precedence:   libraryChartId stored bytes (T19) > fixtureAudio (T15) > click track
//
// Separate parameters for separate identities (review P0 — one param never carries two meanings):
//   ?libraryChartId=<chartId> persisted library chart + its stored audio (T19 adds the row here)
//   ?chart=benchmark          the W1 benchmark chart (existing semantics, unchanged)
//   ?fixtureAudio=<name>      ONLY /songs/<name>.webm audio, paired with a chart from another
//                             source (A5 claim 2: long.webm + the long.osu chart seeded into the
//                             ?import sessionStorage path; A6: benchmark chart + long audio)
//   ?import                   the W2 sessionStorage chart path (sessionStorage key "w2-import"),
//                             which stores no audio — it always pairs with the click track.
//
// `?fixture=<name>` (the self-consistent /songs/<name>.{osu,webm} pair) is NOT part of this
// contract: it was never wired, no W3 consumer reads it, and the T15 brief's Step-3 row declaring it
// is superseded — see D33 in DECISIONS.md for the ruling and the authoritative scheme.
//
// The fixtureAudio row exists ONLY in dev/E2E builds (`fixtureEnabled`): a production build cannot
// select it, so no fetcher outside the bundled assets is reachable from the public deploy.
export type ChartSource = { kind: "benchmark" } | { kind: "import" } | { kind: "default" };

export type AudioSource = { kind: "fixture"; name: string } | { kind: "clickTrack" };

export interface SourceParams {
  benchmark: boolean;
  fixtureAudio: string | null;
  importRequested: boolean;
}

export function resolveChartSource(p: SourceParams): ChartSource {
  if (p.benchmark) return { kind: "benchmark" };
  if (p.importRequested) return { kind: "import" };
  return { kind: "default" };
}

export function resolveAudioSource(p: SourceParams, opts: { fixtureEnabled: boolean }): AudioSource {
  if (opts.fixtureEnabled && p.fixtureAudio !== null) return { kind: "fixture", name: p.fixtureAudio };
  return { kind: "clickTrack" };
}

/** /songs/<name>.webm is only ever joined from a validated name — never a traversal. */
export function isSafeFixtureName(name: string): boolean {
  return /^[a-z0-9-]+$/i.test(name);
}
