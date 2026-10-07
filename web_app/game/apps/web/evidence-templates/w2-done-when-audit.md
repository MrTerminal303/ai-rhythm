# W2 done-when audit (spec §7 evidence table → actual repo evidence)

Filled by Task 24 from real repo artifacts. `PASS` = evidence exists and was verified
green in this run; `PENDING OPERATOR` = evidence row requires operator execution
(recording, matrix run, live production smoke) not yet performed; `FAIL` = broken.
No row is fabricated.

| # | Done-when item (spec §7) | Evidence artifact | Status |
|---|--------------------------|-------------------|--------|
| 1 | §7.1 formulas + required tests | Unit files `apps/web/src/engine/*.test.ts` (time-math, clock, clock-pair, judge, controller, audio-clock, pause-controller, freeze, release, server-time, device-change — 17 files / 135 tests green in gate); headless e2e `e2e/w2-sync.spec.ts` (chartTime ≡ playbackPosition invariant over ≥60 frames); deferred items explicitly listed below with W4/W5 owners | PASS |
| 2 | Notes sync ±10 ms | Layer 1 unit: `e2e/w2-sync.spec.ts` invariant test green; Layer 2 sampling e2e: same spec green in gate; Layer 3 operator slow-mo recording: `evidence-templates/w2-slowmo-procedure.md` written, execution PENDING OPERATOR; browser × device matrix: `evidence-templates/w2-browser-device-matrix.md` (rows empty, Status header PENDING OPERATOR); device-change smoke: `apps/web/src/engine/device-change.test.ts` green | PENDING OPERATOR (layers 1–2 PASS; layer 3 + matrix pending) |
| 3 | Calibration works | `apps/web/src/calibration-store.test.ts` — `computeCalibration` median-of-(input−beat) on synthetic taps incl. outlier-robustness case (green in gate); operator smoke on `/calibrate` PENDING OPERATOR (production smoke) | PENDING OPERATOR (unit PASS; live smoke pending) |
| 4 | Canonical beatmap + zod | Golden fixtures `packages/shared/fixtures/canonical/case-defaults.json`, `case-sort.json`, `case-timing-pulses.json` (bytes + SHA-256 via `hashBeatmap`); regression pin in `packages/shared/src/canonical.test.ts` (green in gate) | PASS |
| 5 | `.osu`/`.osz` importer (+ `.osu`, `.dbm.json` export) | `packages/beatmap-formats/src/osu-import.test.ts`, `osz-import.test.ts`, `roundtrip.test.ts` (import → canonical → export → import idempotence; dbm.json round-trip; rejection/warning fixtures); `/import` e2e `e2e/w2-import.spec.ts` plays an imported hold map (green in gate) | PASS |
| 6 | Kenney + style check + atlas + CSV/CI | Screenshot `web_app/game/evidence/task-style-check.png` (operator-judged verdict `PENDING OPERATOR` in `w2-style-check-report.md`); atlas budget check `pnpm build:atlas` exit 0 (27503 B / 409600 B); `pnpm check:assets` exit 0 (1724 files OK incl. `assets/ASSETS.csv`); CI `.github/workflows/web-game-ci.yml` present (remote run status = operator/CI view) | PENDING OPERATOR (style verdict pending; atlas/CSV checks PASS in local gate) |
| 7 | Next 16 (E3) | D15 entry in `web_app/game/DECISIONS.md` (next=16.3.8 pin, migrations, `--webpack` opt-out); green suite + deploy smoke recorded in D15; branch-wide gate re-run green below | PASS |
| 8 | Scoring re-eval (E2) | D16 entry (Good 0.40, combo bonus formula, cap 1,050,000); updated unit tests green in gate (`judge.test.ts`, scoring coverage in `apps/web` suite) | PASS |
| 9 | PixiJS eval (E4) | `docs/pixi-eval.md` + DECISIONS verdict D18 (adopt pre-W7, spike not merged) | PASS |

## Deferred list (verbatim, from Task 24 brief)

- Browser refresh 30 s / 6 min resume → W4/W5 (rooms required; solo refresh restarts song).
- `serverSongMs` realign ≤100 ms after suspension → W4 (needs server timeline); W2 proves ctx-lockstep instead (Step 1).
- Real ping loop / `start_at` scheduling → W4 (formulas pure-tested in T4).
- gzip transport envelope → W4/W9.

## Full gate (Task 24, order per brief)

Run from `web_app/game/` on branch `worktree-w2-web-app-sdd` @ `bb80ae3` + T24 changes:

```bash
pnpm -r typecheck && pnpm -r test && pnpm --filter @airhythm/web build && pnpm --filter @airhythm/web exec playwright test && pnpm build:atlas && pnpm check:assets
grep -c "^- D1[5-9]\|^- D20" DECISIONS.md
```

| Step | Command | Result |
|------|---------|--------|
| 1 | `pnpm -r typecheck` | PASS — all 5 packages Done (shared, assets, worker, web, beatmap-formats) |
| 2 | `pnpm -r test` | PASS — web 135/135 (21 files), beatmap-formats 45/45 (3 files), shared 41/41 |
| 3 | `pnpm --filter @airhythm/web build` | PASS — exit 0, Next.js 16.3.8 (webpack), 6/6 static pages, routes `/ /calibrate /import /play` |
| 4 | `pnpm --filter @airhythm/web exec playwright test` | PASS — exit 0, 5 passed (1.6m): w1-highway, w2-import, w2-style-check, w2-sync ×2 |
| 5 | `pnpm build:atlas` | PASS — exit 0, 27503 B / 409600 B (400 KB budget), 7 sprites |
| 6 | `pnpm check:assets` | PASS — exit 0, 1724 files OK |
| 7 | `grep -c "^- D1[5-9]\|^- D20" DECISIONS.md` | **5** — D15–D19 present; D20 ABSENT (no T23 style swap occurred) |

Final production smoke (Vercel deploy + live click-through of `/`, `/calibrate`,
`/import`, `/play` on the live URL): **PENDING OPERATOR** — deploy side effect outside
this worktree; operator-only per controller ruling.
