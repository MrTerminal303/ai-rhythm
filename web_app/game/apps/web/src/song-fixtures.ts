// Single source of truth for the §7 committed fixture songs (spec §7). The checksum-pinned unit
// fixtures (song-fixtures.test.ts) and the three-engine decode gate (e2e/w3-fixture-decode.spec.ts)
// both read this list, so the sha pins and the ±1 s nominal-duration assertion cannot drift apart.
// Kept as a plain module (not exported from the .test.ts) because a Playwright spec importing a
// vitest test file would execute its describe blocks in the Playwright process.
export const SONG_FIXTURES: readonly { file: string; sha256: string; nominalSec: number }[] = [
  { file: "short.webm", sha256: "2378b418be401fca1881b7eba25464c8ad9217ad5ca5bc6a31eed6bb3e38fed6", nominalSec: 30 },
  { file: "medium.webm", sha256: "d861c4416d72759f915b9da151b134a6a81382adb4df7f8e12e19c19cb38a465", nominalSec: 90 },
  { file: "long.webm", sha256: "da7810fe47e1014542e749bca6774eca07bc42efdc8f5ea07b11eb92b0b7022f", nominalSec: 240 },
];

/** Nominal duration (seconds) by fixture file — the decode gate's ±1 s band (spec §8 default 1). */
export const NOMINAL_SONG_SECONDS: Record<string, number> = Object.fromEntries(
  SONG_FIXTURES.map((s) => [s.file, s.nominalSec]),
);
