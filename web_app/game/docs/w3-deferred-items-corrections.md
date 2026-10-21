# W3 deferred items — tracked copy with the F33 corrections

Provenance: this file is a TRACKED copy of `deferred-items.md` §2 and §4 from the W3
final-review triage, carrying the eight F33 corrections plus the §5 T21 carry-over closure.
The source file lives at
`.superpowers/sdd/2026-10-12-web-app-week-3-design/deferred-items.md` — a path that is
GITIGNORED (root `.gitignore:6`), so the corrected triage could not travel with the code and
would have been lost when the workspace was deleted. This file is the travelling copy.

Every line citation below was re-verified against the tree at the W3 final-review fix wave
(commit `a1f40f0`, the worktree `worktree-w3-web-app-sdd`). The corrections applied here are
listed at the end of the file.

---

## 2. Deferred code minors (by task)

| Task | Item |
|---|---|
| T5 | hold-test `as never` readability |
| T6 | `invariants.test.ts` store-segment assertion reads the engine accessor, not the snapshot copy; `judge.test.ts` split update/`noteStates` read |
| T8 | positive `===` guards read `machine` while negative `!==` guards read `phaseRef` (equivalent only via `applyPhase` lockstep — a future `await` inside `applyPhase` could diverge them); `PLAY_TRANSITIONS` import exists only to satisfy the grep gate |
| T10 | e2e header comment says "short" fixture but the test uses `w1-chart`; atlas re-apply on context restore = accepted limitation. **CORRECTED (final review F33): the header's "the brief's 'short' hold fixture does not exist" claim was FALSE — `apps/web/public/songs/short.osu:99` carries a 1000 ms hold (osu! mania: `192,192,3000,128,0,4000` → x=192 → lane 1, t=3000 ms, type flag 128 = hold, endTime 4000 ms ⇒ d=1000 ms); the spec now states the REAL reason it uses a `w1-chart` tap (the hold is only reachable through the /import + `?libraryChartId=` path — `/play` loads `w1-chart.json`, whose 60 notes are ALL taps, and `short.osu` is only parsed by the /import upload flow). The remaining items (header wording, atlas re-apply limitation) stand as written.** |
| T12 | `frameIntervalsOver` field names hardcode 16.7 while the method takes `budgetMs`; **CORRECTED (final review F33): "pre-existing p95 direct + `RENDER_BUDGET_MS` tests dropped by the `perf.test.ts` rewrite" is STALE — both are present: the `describe("p95")` block at `apps/web/src/engine/perf.test.ts:7` and the `RENDER_BUDGET_MS` assertion at `:20`. Only the field-name hardcoding remains.** |
| T13 | results-overlay has no `completed→idle` UI affordance (`PLAY_TRANSITIONS` row unused — T21 fills overlay body); `atlasState` public getter wider than the brief's ask |
| T14 | stale pre-fix wording in `task-14-report.md` lines 14/47; **CORRECTED (final review F33): "new 3-engine config excluded from `tsconfig` include" is mis-scoped — the e2e SPECS are typechecked (`e2e/tsconfig.json`, `include: ["**/*.ts"]`, run by the app's `typecheck` script). TWO config files are outside every tsconfig include, not one: the standalone `apps/web/w3-fixture-decode.config.ts` AND `apps/web/playwright.config.ts` (the app's own `tsconfig.json` includes only `["next-env.d.ts", "src", ".next/types/**/*.ts"]`, and `e2e/tsconfig.json` resolves `**/*.ts` relative to `e2e/`).** |
| T16 | `apps/web/evidence-templates/w3-perf-protocol.md:27` says "intervals > 16.7 ms" — FROZEN; next amendment should write `≥16.75 raw / >16.7 quantized`. Warm-up exclusion gates frame intervals only, so `p95RenderDurationMs`/`p95UpdateDurationMs` include the first 5 s. |
| T17 | `z.config({jitless:true})` global (D34) — the eval-probe fix; verified via headed prod build (3 violations off → 0 on) |
| T18 | `userMessageForQuota` one-line indirection; `listCharts` stale-record consumer note; quota test could use `toBeInstanceOf`; state-flip paths (`loadVerifiedChart` / `Audio` / `listCharts` verifyAudio) have no direct unit test. **CORRECTED (final review F33): the quota row UNDERSTATES the gap — `apps/web/src/library/db.test.ts:146` matches the rejection with the regex `/Storage full\|LibraryQuota/`, so a plain `Error("Storage full")` (the WRONG type) passes the "library quota error" test: the ERROR TYPE is unasserted, not merely the assertion style. (`apps/web/src/library/db.ts:196` gates the conversion to `LibraryQuotaError` on the error's `name === "QuotaExceededError"`, not on its message.)** |
| T19 | pre-existing "Back to library" link in results-overlay points to `/`, not `/library` (`play/page.tsx:933`). **CORRECTED (final review F33): the line citation is WRONG — `play/page.tsx:933` is the device-toast container, not a link and not the canvas. In the current tree the canvas (`data-testid="highway"`) is at `play/page.tsx:912`; the library-error overlay's link is `<Link href="/library">` at `play/page.tsx:959` (CORRECT) and the results overlay's link is `<Link href="/">` at `play/page.tsx:1009` (the one this item is about).** |
| T20 | NaN-duration page-level cap is a no-op without an extra guard |
| T21 | `buildRunResult` omits `chartId`/`audioHash` (spec-legal); report nit — "noUncheckedIndexedAccess yields string" (it yields `string \| undefined`; code still correct). **CORRECTED (final review F33): "`last-run.ts` has no dedicated unit test" is STALE — `apps/web/src/ui/last-run.test.ts` exists (since T23) and pins the `mintRunId` fallback (the non-secure-origin path) at `:27-33`.** |
| T22 | M3 `loadEnvelopes` performs no shape validation (corrupt/remote `keybinds` can throw inside `startGame` and block play — the remote row is a T23 trust boundary); M4 `syncSettings` captures `local` once before the retry loop (concurrent same-tab edit can be clobbered on write-back); M5 `lanesToKeyMap` is last-wins on duplicate binds; M6 `/settings` may hydrate prerendered defaults against stored values; M7 `settings.ts` imports `SCROLL_PX_PER_MS` from `engine/renderer-webgl.js`, pulling the renderer into every settings consumer's bundle; DECISIONS.md:68 R5 wording ("dropped from DefaultSettings" — it was nested); a pre-fix persisted envelope keeps a stale `skills` on read-modify-write (zero gameplay effect) |
| T23 | `auth.test.ts` source-shape test resolves `src/auth/auth.ts` via `process.cwd()` — assumes vitest cwd = app root |
| T24 | dead exports `framesEmitted` / `fluxRows` + their false justification comment; weak `analysis.worker.test.ts:131-168` assertions (stereo downmix value never checked, mel rows never value-compared); `chunking.ts:237` cursor advances from `channels[0]` only; `audio-samples.ts:86-89` `clampMaxSeconds(NaN)`. **CORRECTED (final review F33): the `clampMaxSeconds(NaN)` row is WORSE and mis-described — it does NOT throw a `RangeError`. `Math.min(Math.max(NaN, 0.01), 30)` is `NaN`, so `Math.floor(NaN * sampleRate)` is `NaN` and `Math.max(1, NaN)` is `NaN`; the copy loop then runs ONCE with `count = Math.min(NaN, length) = NaN`, and `new Float32Array(NaN)` is a ZERO-LENGTH array — ONE silently EMPTY chunk (measured chunk lengths `[0]`, i.e. a silently empty analysis) instead of an error. (`packages/chartgen/src/audio-samples.ts:70-82`.)** |
| T25a | `selectDensity` ~2× slower at n=20000 (228 ms vs 120 ms) after confidence ordering; 2.74 s on a 3-min track vs the 20 s budget |
| T25b | `generate-boundary.test.ts:99` per-kind key-set comparison exercises only "tap" (committed fixture has no holds), so the "hold" branch is inert |

## 4. Operator-gated (cannot be closed on this machine)

1. **T1/A14 keepalive** — apply `web_app/supabase/migrations/20261012_keepalive.sql`, set GitHub secrets `SUPABASE_PROJECT_URL` + `SUPABASE_PUBLISHABLE_KEY`, dispatch the workflow, start + watch the ~10-day no-warning window.
2. **T2/T15 A1 claim-1** — real-browser evidence on a machine whose D21 mapping error is ≤ 5 ms (frozen budget exceeded here).
3. **T9** — post-deploy `curl -sI <prod>/ | grep -i content-security-policy` (headless CSP now GREEN locally after D34).
4. **T14** — webkit decode gate is RED by design here (Playwright webkit-2359 has no Web Audio API). **CORRECTED (final review F33): the CI claim is UNVERIFIED, not a guarantee — the gate ATTEMPTS on the Ubuntu runner (`.github/workflows/web-game-ci.yml` runs `pnpm --filter @airhythm/web e2e:fixture-decode` on `ubuntu-latest`, and `apps/web/w3-fixture-decode.config.ts` declares the third project); it is green only if that WebKit build has Web Audio + libopus.** `.webm`/Opus stays provisional per spec §8 default 1 until an operator runs the gate on WebKit with Web Audio + libopus.
5. **T15** — claim-2 ≥100-hit distribution on operator/CI engines (passes 4/4 alone here since the ANGLE launch args, fails at `workers: 2`).
6. **T23** — the RLS/grant contract has ZERO executed evidence (`rls.test.ts` skips with a NOT-a-pass banner, 10 unexecuted cases; no Supabase project here).
7. **T25** — `models/spike/baseline_flux.py` written but NOT RUN against the fixture (R13); `baseline_onsets.json` NOT generated, so the parity row skips with a banner. Operator must generate it with the D17-pinned env.
8. **C9 (4K)** — measured 7.5 fps at 3840×2160 on GPU-less hardware: C9 is unsatisfiable here. Operator has NOT authorised a spec amendment.
9. **T26 journey 4 (auth)** — skips with a printed reason unless `SUPABASE_TEST === "1"` **and** both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are set (`e2e/w3-journey-auth.spec.ts:31`). Naming only the URL understated the gate: the explicit `SUPABASE_TEST=1` opt-in was added by ruling R28 so an ordinary configured shell cannot trigger a SIGNUP with the fixed test password.

---

## Corrections applied in this file (F33)

| # | Item | Correction | Verified against |
|---|---|---|---|
| 1 | T10 | The "no hold fixture" claim was FALSE; `short.osu` carries a 1000 ms hold, and the real reason the spec uses a `w1-chart` tap is the /import + `?libraryChartId=` path. | `apps/web/public/songs/short.osu:99`; `apps/web/fixtures/w1-chart.json` (60 notes, all taps); `e2e/w3-context-loss.spec.ts:6-16` |
| 2 | T12 | The "p95 + `RENDER_BUDGET_MS` tests dropped" claim is STALE — both exist. | `apps/web/src/engine/perf.test.ts:7` and `:20` |
| 3 | T14 | The "config excluded from `tsconfig`" claim is mis-scoped: the e2e SPECS are typechecked. TWO configs are outside every tsconfig, not one — `apps/web/w3-fixture-decode.config.ts` AND `apps/web/playwright.config.ts`. | `e2e/tsconfig.json` (`include: ["**/*.ts"]`), `apps/web/tsconfig.json` (`include: ["next-env.d.ts", "src", ".next/types/**/*.ts"]`), `apps/web/package.json` `typecheck` script |
| 4 | T18 | The quota row understates: `db.test.ts:146` matches `/Storage full\|LibraryQuota/`, so a plain `Error("Storage full")` (the wrong TYPE) passes; the error type is unasserted. | `apps/web/src/library/db.test.ts:146`; `apps/web/src/library/db.ts:196` |
| 5 | T19 | The line citation is wrong: `:933` is the device-toast container. The canvas is `:912`; the library-error link is `<Link href="/library">` at `:959`; the results-overlay link is `<Link href="/">` at `:1009`. | `apps/web/src/app/play/page.tsx:912`, `:959`, `:1009` |
| 6 | T24 | The `clampMaxSeconds(NaN)` row is mis-described: no `RangeError` — ONE silently EMPTY chunk. | `packages/chartgen/src/audio-samples.ts:70-89` |
| 7 | T21 | "`last-run.ts` has no dedicated unit test" is STALE — `ui/last-run.test.ts` exists and pins the `mintRunId` fallback. | `apps/web/src/ui/last-run.test.ts:27-33` |
| 8 | §4 item 4 | The CI claim is UNVERIFIED, not a guarantee — the gate ATTEMPTS on the Ubuntu runner; it is green only if that WebKit build has Web Audio + libopus. | `.github/workflows/web-game-ci.yml`; `apps/web/w3-fixture-decode.config.ts`; `e2e/w3-fixture-decode.spec.ts:19,43` |
| 9 | §5 T21 carry-over (from `deferred-items.md` §5 — reproduced here so the closure travels) | The insecure-context publish fix is REAL and CLOSED: `mintRunId()` try/catches `crypto.randomUUID` and falls back to a Math.random UUIDv4 shape; the play page's publish is wrapped in its own try/catch; `ui/last-run.test.ts:27-33` pins the unavailable-`randomUUID` path. | `apps/web/src/ui/last-run.ts:54-64`; `apps/web/src/app/play/page.tsx:879-887`; `apps/web/src/ui/last-run.test.ts:27-33` |
