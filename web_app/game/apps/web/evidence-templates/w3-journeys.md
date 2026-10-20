# W3 — §7 full-workflow journeys checklist (T26)

Fill this in when exercising journeys 1–4. Every row needs an OBSERVED result, not an
expected one. A row that was not exercised is marked `not run` — never `pass`.
Screenshots land in `e2e/screenshots/` (gitignored) — list the file name that was produced.

Command that produced the run:

```
pnpm --filter @airhythm/web exec playwright test w3-journey
```

## Environment

- Build: Playwright `webServer` (`pnpm build && pnpm start`, production CSP, `NEXT_PUBLIC_E2E=1`)
- Browser + platform: _<chrome version / windows 10 pro 19045>_
- Supabase configured: yes/no — journey 4 requires yes (otherwise it SKIPS and prints why)

## Journey 1 — import (`e2e/w3-journey-import.spec.ts`)

| # | Assertion | Observed |
|---|-----------|----------|
| 1 | Real `short.osu` + `short.webm` imported; `import-done` shown | ___ |
| 2 | `charts` row exists with real metadata (title `short`, difficulty `W3 Fix`, 71 notes, NPS > 0) | ___ |
| 3 | `audioAssets` row exists for the chart's `audioHash` | ___ |
| 4 | `audioHash ≠ chartHash` | ___ |
| 5 | Consistency walk: no chart whose `audioHash` has no audio row | ___ |
| Screenshot | `w3-journey-1-import.png` | ___ |

## Journey 2 — library (`e2e/w3-journey-library.spec.ts`)

| # | Assertion | Observed |
|---|-----------|----------|
| 1 | After reload, `/library` lists the song with real metadata | ___ |
| 2 | Negative control: master volume 0 → `__w2.analyserRms()` < 0.001 on every sample | ___ |
| 3 | Playing: `__w2.analyserRms()` > 0.01 on 10 consecutive frame samples (pre-DAC tap) | ___ |
| 4 | Playing: \|chartTime − playbackPosition\| ≤ 10 ms on every sample | ___ |
| 5 | Song ends → `results-overlay` visible with score + rank | ___ |
| 6 | Back to library → the row is still there | ___ |
| Screenshot | `w3-journey-2-library.png`, `w3-journey-2-playing.png`, `w3-journey-2-results.png` | ___ |

Scope note (record truthfully): this is **audio-path + real-browser workflow verification**
(the analyser is pre-DAC). It is NOT physical-audibility verification — acoustic
certification needs the loopback method, deferred to W11 (spec §7).

## Journey 3 — persistence (`e2e/w3-journey-persistence.spec.ts`)

Mechanism (Round 11 P1-16): `browserContext.storageState({ indexedDB: true })` carried into a
BRAND-NEW `browser.newContext()`. Two isolated contexts do NOT share IndexedDB.

| # | Assertion | Observed |
|---|-----------|----------|
| 1 | Phase 1 DB name list contains `duelbeat-library` | ___ |
| 2 | Phase 2 (new context) DB name list contains `duelbeat-library` (same DB) | ___ |
| 3 | Chart still stored with the same `audioHash`; consistency walk clean | ___ |
| 4 | Still playable: analyser RMS > 0.01 on 10 samples in the restored context | ___ |
| 5 | Variant (a): corrupted audio bytes → `unplayable-badge`, Play `aria-disabled` | ___ |
| 6 | Variant (a): delete removes the row from the store | ___ |
| 7 | Variant (b): forced quota → `import-error` "Storage full …" | ___ |
| 8 | Variant (b): no partial chart/audio record survives | ___ |
| Screenshot | `w3-journey-3-restored-context.png`, `w3-journey-3-damaged.png`, `w3-journey-3-quota.png` | ___ |

## Journey 4 — auth (`e2e/w3-journey-auth.spec.ts`, env-gated)

Requires `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (configured
build), a test project with email confirmation DISABLED, and the migration applied.
Without them the suite SKIPS and prints every case that did not run — never a pass.

| # | Assertion | Observed |
|---|-----------|----------|
| 1 | Guest run completes → `results-overlay`, zero `*.supabase.co` requests | ___ |
| 2 | Before login: `runs` for the chart hash SNAPSHOTTED (authenticated REST read) — `rows` is append-only, so the proof is the snapshot, not an empty table | ___ |
| 3 | `/auth` sign-in → `auth-signed-in` visible | ___ |
| 4 | Pre-login local settings edit appears in `profiles.settings` (login trigger) — matched by the envelope's `writeId` | ___ |
| 5 | New signed-in run → exactly ONE row in `runs` for that chart hash (`rowsBefore.length + 1`) | ___ |
| 6 | Guest-era window → ZERO NEW rows for the same chart hash in the guest `played_at` window (Review Focus 4) | ___ |
| Screenshot | `w3-journey-4-guest-results.png` | ___ |
| Run status | pass / skip (reason printed) / not run | ___ |
