# LICENSES.md

## Generated first-party fixtures — CC0; own work, Q9-safe by construction

The §7 real-song fixtures (`apps/web/public/songs/*`) are **generated in-repo, not
retrieved from any external source**:

| File | Provenance | License |
| --- | --- | --- |
| `apps/web/public/songs/short.webm` | Generated: `apps/web/scripts/gen-audio-fixture.mjs --songs` (seeded 120 BPM PCM) + `encode-songs.mjs` (chromium `<audio>` captureStream → mono Opus MediaRecorder) | owned (CC0) |
| `apps/web/public/songs/medium.webm` | Generated: same as short.webm (seeded 120 BPM PCM) | owned (CC0) |
| `apps/web/public/songs/long.webm` | Generated: same as short.webm (seeded 120 BPM PCM, 240 s) | owned (CC0) |
| `apps/web/public/songs/short.osu` | Generated: `apps/web/scripts/gen-audio-fixture.mjs --songs` (deterministic 4K map, holds documented at t=3000 lane 1) | owned (CC0) |
| `apps/web/public/songs/long.osu` | Generated: `apps/web/scripts/gen-audio-fixture.mjs --songs` (deterministic 4K map) | owned (CC0) |

All notes/kicks/melodies are synthesized from a fixed in-file note table and a
seeded PRNG — no third-party audio, stems, or chart material is involved.
The WAV intermediates (`apps/web/public/songs/*.wav`) are gitignored build
artifacts, regenerated on demand, and carry the same owned/CC0 provenance.

Determinism contract: encoded `.webm` bytes are NOT bit-stable across runs
(MediaRecorder/Opus encoder version differences). `song-fixtures.test.ts` pins
SHA-256 per committed file; regenerating fixtures intentionally updates the pins.
