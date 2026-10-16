# W3 A6 — full-frame perf certification protocol (FROZEN, declared before measurement)

Committed template (W3 T16). **Fill a copy into the gitignored `evidence/w3-perf-report.md`** —
never edit this file to carry results. Every field below is either a measured value with its
provenance or the literal string `UNVERIFIED — <reason>`; no field is ever fabricated.

**This protocol is declared and committed BEFORE any number is measured.** The gate, the window,
the tail statistics and the CI-vs-certification split are fixed here; a number measured under any
other protocol does not count, and widening the gate is never a silent fix — it is a DECISIONS entry
with justification plus a FRESH run (spec §9).

## Loaded artifacts (the frozen input pair)

| Field | Value |
|---|---|
| Chart | `apps/web/fixtures/w1-benchmark-chart.json` (the large W1 benchmark chart: 900 notes, `durationMs` 180 000; selected by `?chart=benchmark`) |
| Song (audio) | `apps/web/public/songs/long.webm` (240 s, mono Opus/WebM — committed T14 fixture; selected by `?fixtureAudio=long`) |
| URL under test | `/play?chart=benchmark&fixtureAudio=long` — the T15/D33 param scheme: chart source and audio source are SEPARATE params (no precedence ambiguity) |
| Build under test | the production build (Playwright `webServer` runs `pnpm build && pnpm start` with `NEXT_PUBLIC_E2E=1`) |

## Frozen measurement definitions

| Field | Value |
|---|---|
| Measurement window | frames after a **5 s warm-up** until **engine freeze** — the run's first 5 s are EXCLUDED from every reported interval statistic |
| Gate | **frame-interval p95 ≤ 16.7 ms** (`RENDER_BUDGET_MS`) over the **combined update+render loop** — NOT render-only (`renderPass` stays data) |
| Tail (all reported) | `tail: { over16_7Count, over16_7Share, p99FrameIntervalMs, maxFrameIntervalMs }` — count and share of intervals > 16.7 ms, p99, max |
| Allocation / memory | `heapUsedMB` at report time (A13: `performance.memory.usedJSHeapSize / 1048576`, `null` when unavailable) + the report's own frame counts (`samples`) |
| Browser | release **chromium**, **headed, with GPU** |
| Environment | OS, machine (CPU/RAM), browser build/version and the **filled evidence path** are recorded in the report |
| Completion | the report carries `completion: "natural" | "forced"`; only a **natural** run determines the verdict |

**Naming note (deliberate, do not "fix"):** the `PerfMonitor` helper returns the short generic shape
`{ count, share, maxMs }`; the serialized `[perf]` report renames those to the threshold-specific keys
`{ over16_7Count, over16_7Share, maxFrameIntervalMs }` and adds `p99FrameIntervalMs`. The helper is
generic against future budgets, the report is stable against threshold changes. The page hook performs
the mapping; the e2e type matches the REPORT shape, not the helper shape.

**Log contract:** the report is emitted exactly once per run as
`console.log("[perf] " + JSON.stringify(report))` — one serialized JSON string, identical for the
natural and forced paths, so `msg.text().replace("[perf] ", "")` is parseable. The frame loop does not
re-arm rAF after the freeze, and a `reportLogged` guard makes a stray second entry log nothing.

## CI vs certification (the split, stated so it is honest rather than hidden)

| Mode | How it runs | What it asserts |
|---|---|---|
| **CI (structure-only)** | default run: race the `[perf]` console event against a **160 s force-cap**; on timeout call `__w2.forcePerfReport()` (stops the loop, logs the current report with `completion: "forced"`) | STRUCTURE only: every field present, `samples.frames > 5000`, `completion` present, `inputLatencySamples ≥ 0` — **CI never asserts the p95 gate** (CI/this machine renders with software WebGL, where a p95 gate would measure the rasterizer, not the app) |
| **Certification** | `PERF_CERT=1`: wait for **NATURAL** freeze completion with a **300 s timeout** (240 s fixture + warm-up + decode headroom) — the force-cap path is NOT used | `report.completion === "natural"` asserted FIRST, then `p95FrameIntervalMs ≤ 16.7` and `report.pass === true` |

A forced report is a labeled, structurally-valid record of a run that did not reach its natural end;
it is EXCLUDED from the certification verdict and may never be substituted for one.

## Scope limits (stated, not implied)

- **One machine's result is not a universal guarantee.** The certification verdict is a
  single-machine, single-run observation under the protocol above; it does not certify other
  hardware, other browsers, or the deployed build. Re-certification on a new machine is a new run.
- Headless/software-WebGL environments cannot produce a certification verdict at all: their frame
  intervals measure the software rasterizer.
- Frame-interval p95 covers the combined update+render loop of the app's own frame callback. It is
  not a GPU-time measurement, not an input-to-photon measurement, and not an acoustic measurement
  (A5 claim 3 / W11 territory).

## Commands

```bash
pnpm --filter @airhythm/web exec playwright test w3-perf             # CI-shape: structure assertions
PERF_CERT=1 pnpm --filter @airhythm/web exec playwright test w3-perf # headed GPU machine: gate asserted
```
