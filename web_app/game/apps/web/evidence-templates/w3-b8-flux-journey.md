# W3 B8 — flux-v1 journey evidence template (T25)

Fill this in when exercising the B8 fallback-generator journey end to end. Every row needs an
OBSERVED result, not an expected one. A row that was not exercised is marked `not run` — never `pass`.

This template is committed; the filled report lives at `evidence/w3-b8-flux-journey.md` (gitignored).

Commands that produce the journey rows:

```bash
pnpm --filter @airhythm/web exec playwright test w3-flux-journey --project=chromium
```

## Environment

- Build: `pnpm --filter @airhythm/web build && pnpm start` (production CSP, `NEXT_PUBLIC_E2E=1`)
- Browser + platform: _<chromium version / windows 10 pro 19045>_
- Fixture under test: `apps/web/public/songs/long.webm` (240 s, 120 BPM, sha256 `da7810fe…02f`),
  pinned by `apps/web/src/song-fixtures.test.ts`
- Date / measurement window: _(fill)_

## Journey rows (spec §7 journey 6)

| # | Step | Observed | Artifact | Verdict |
|---|------|----------|----------|---------|
| 1 | `/import` → upload `long.webm` on `import-audio-input` (NO chart file) | `audio-selected` visible: ___ / `generate-button` enabled: ___ | — | _<pass/fail>_ |
| 2 | Click **Generate with flux-v1** | `generate-progress` visible with a `<progress value max=100>`: ___ | `w3-b8-flux-journey-01-generating.png` | _<pass/fail>_ |
| 3 | The run settles | `import-done` visible with the `?libraryChartId=` Play link: ___ / chart id: ___ | — | _<pass/fail>_ |
| 4 | `/library` lists the generated song | exactly one row with title "Generated chart": ___ / NPS: ___ / notes: ___ | `w3-b8-flux-journey-03-library.png` | _<pass/fail>_ |
| 5 | Play the generated chart | the stored chart plays (note count = the generated note count): ___ | — | _<pass/fail>_ |
| 6 | The run reaches the results screen | `results-overlay` visible with a non-empty `results-rank`: ___ | `w3-b8-flux-journey-02-results.png` | _<pass/fail>_ |
| 7 | Back out of the results screen | results link → landing `/`: ___ ; `/library` still lists the song: ___ | — | _<pass/fail>_ |
| 8 | `/import` → upload the SAME `long.webm` → Generate again | second chart id: ___ | — | _<pass/fail>_ |
| 9 | Seeded determinism | `audioHash` equal: ___ / `chartHash` equal: ___ / note count equal: ___ | — | _<pass/fail>_ |
| 10 | Q10: a generation over the budget | `generate-error` visible: ___ / `data-generator` = ___ (must be `flux-v1` — no silent switch) / `generate-retry` visible: ___ / `generate-cancel` visible: ___ | `w3-b8-flux-journey-04-q10-error.png` | _<pass/fail>_ |
| 11 | Q10: Retry starts another run | the run counter goes up by one: ___ / the retried run over-budgets again: ___ | — | _<pass/fail>_ |
| 12 | Q10: Cancel dismisses the failure | `generate-error` gone: ___ / `generate-button` enabled again: ___ | — | _<pass/fail>_ |

**Field compared in row 9:** the stored chart record's `audioHash` (the content address of the audio
asset) and `chartHash` (the canonical-chart digest — the byte-identical claim). The lane seed is
`SHA-256(canonical JSON({audioHash, generationOptions, generatorId, generatorVersion}))`, so the same
audio bytes + the same generation options must reproduce the same chart.

**Row 10–12 (Q10):** the over-budget path is reached with a TINY budget through the page's own
`__importTest.setTimeoutMs(ms)` e2e seam — the SAME option the app passes in production. A real
240 s track finishes well inside the 20 s budget, so the budget is the only honest way to observe
Retry / Cancel in a browser.

## Cross-implementation parity (cross-implementation PARITY, NOT onset accuracy)

| Field | Value |
|---|---|
| Reference generator | `models/spike/baseline_flux.py` (Python mirror of the TS onset core) |
| Reference file | `models/spike/testvectors/baseline_onsets.json` — **NOT generated on this machine** |
| Input | `models/spike/testvectors/input.wav` (22050 Hz mono 16-bit) |
| Row state in `packages/chartgen/src/flux-v1.test.ts` | _<pass / skipped-with-banner / fail>_ |
| F-score | _<fill>_ |

The parity row is a NOT-A-PASS skip until the operator runs `baseline_flux.py` on the D17-pinned
Python env (R13). A skip is never a pass.

## Known limitations / unverified rows

- _(fill: each unverifiable row with its exact reason — e.g. a build that cannot start on this
  machine, an environment-only observation, anything not exercised.)_
