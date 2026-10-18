# W3 A5 — three-claim multi-browser timing evidence (report template)

Committed template (W3 T15). **Fill a copy into the gitignored `evidence/w3-timing-report.md`** —
never edit this file to carry results. Every field below is either a measured value with its
provenance or the literal string `UNVERIFIED — <reason>`; no field is ever fabricated.

Commands that produce the claim-1/claim-2 rows:

```bash
pnpm -r test                                                       # claim 1 (Vitest, engine-agnostic)
pnpm --filter @airhythm/web exec playwright test w3-timing         # claim 2 + standing suite, 3 projects
```

## Environment

| Field | Value |
|---|---|
| Date / measurement window | _(fill)_ |
| Machine + CPU | _(fill)_ |
| RAM / heap (`NODE_OPTIONS`) | _(fill)_ |
| OS | _(fill)_ |
| Chromium / Firefox / WebKit builds | _(fill: `npx playwright --version` + each engine's reported version)_ |
| Commits (spec, app) | _(fill: the timing-spec commit and the app commit under test)_ |
| Fixture pair under test | `apps/web/public/songs/long.osu` (562 notes, 4K, 120 BPM) + `long.webm` (240 s), pinned by `apps/web/src/song-fixtures.test.ts` |

## Claim 1 — deterministic clock/judgement correctness

Unit matrix, `pnpm -r test` (Vitest is engine-agnostic: ONE suite is the claim-1 evidence for all
three engines — no per-browser duplication). Checklist rows and their owners:

| Checklist row | Owning test | Result |
|---|---|---|
| Both clock-pair sources | `apps/web/src/engine/time-math.test.ts` "A1 claim-1 matrix" (SAME INSTANT + 1 s-later, both sources), `clock-pair.test.ts` "D21 conversion semantics" | _(fill)_ |
| Simulated output delay (both latency components, independent) | `clock-pair.test.ts` "A1 contract (D21)" — baseLatency/outputLatency varied independently | _(fill)_ |
| Suspend/resume | `apps/web/src/engine/audio-clock.test.ts` "context suspension freezes chartTime in lockstep"; `time-math.test.ts` "suspend/resume continuity" | _(fill)_ |
| Tab visibility → pair re-sample | `clock-pair.test.ts` "W3 T15 claim-1 gap: a visibility transition re-samples the pair" (added by T15) + `time-math.test.ts` "visibility/device change only ever enter via pair re-sampling" | _(fill)_ |
| Device change | `apps/web/src/engine/device-change.test.ts` + `resync.test.ts` (transition table) | _(fill)_ |
| Calibration applied exactly once | `time-math.test.ts` "calibration applied exactly once: judgeDt subtracts it one time", `calibration-matrix.test.ts` | _(fill)_ |
| Per-engine (real browser) | `pnpm --filter @airhythm/web exec playwright test w3-clock-invariant` on chromium/firefox/webkit → the D21 final verdict, one block per engine | _(fill per engine)_ |

D21 final verdict per engine (the single computed outcome — `d21FinalVerdict()`):

| Engine | Precision | accept rate | maxAbsErrMs | verdict |
|---|---|---|---|---|
| chromium | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ |
| firefox | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ |
| webkit | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ |

Known environmental caveat (recorded at T2/T15 time, this machine): T2's real-input mapping test
observed ~13.4 ms > the frozen 5 ms budget → `mapping-error-fail`. That is an environment reading,
not a widened budget: a budget change is a new D21 revision with a fresh run.

W3 T20 (B3) rerun note (2026-10-18, same GPU-less machine): the D21 verdict is STILL `mapping-error-fail`
on this environment — repeated runs observed maxAbsErrMs 7.3–8.5 ms vs the frozen 5 ms budget
(round-8 cached-pair test, chromium). Same class as the recorded T2/T15 caveat: an environment
reading on the weak machine, NOT a regression introduced by T20 (T20 touched the /import flow and
the ?import branch only; the __w2 input-probe + pair-keeper paths are unchanged). A budget change
remains out of scope for T20 — it would be a new D21 revision with a fresh run.

## Claim 2 — real-browser integration (real song, scripted lane keys)

`pnpm --filter @airhythm/web exec playwright test w3-timing` — one line per engine project for the
claim-2 test, plus the standing suite (suspend/resume 1/5/20 s, tab hide, refresh mid-play).

| Engine | n (hits) | median dt (ms) | p95 dt (ms) | p95Abs (ms) | outliers (\|dt\|>110) | gate (median<40, p95Abs<110) |
|---|---|---|---|---|---|---|
| chromium | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ |
| firefox | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ |
| webkit | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ | _(fill)_ |

Standing suite rows: suspend/resume 1 s, 5 s, 20 s → `advanced` / `wallElapsed` / `bookkeeping`
per engine; tab hide → paused + frozen clock; refresh at ~30 s → reload to `idle`, chart intact.

**Automation-scheduling limitations (verbatim, mandatory):** hit-offset distributions under
automation mix input-scheduling jitter with clock error — integration evidence, not acoustic
certification.

Solo refresh mid-song: **deferred to W4** — resume-position depends on W4's server timeline
(no `serverSongMs` in solo). W3's evidence is the clean reload to `idle` with the chart intact.

## Claim 3 — audible-output synchronization

audible-output synchronization: **not acoustically certified in W3** — loopback method required
(W11); analyser taps prove pre-DAC signal flow only.

## Limitations and unverified rows

- _(fill: each unverifiable row with its exact reason — e.g. a WebKit build with no Web Audio API;
  weak-PC frame-time inflation; anything else observed.)_
