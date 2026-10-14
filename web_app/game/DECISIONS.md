# DECISIONS.md

One line per decision: `D# — date — decision — why`.

- D1 — 2026-10-03 — W1 renderer is raw WebGL2 (code-drawn lanes/receptors/hit line/pooled notes), NOT PixiJS v8 (PLAN Q19/§5.1). — W1 spec §2.11 mandates a WebGL2 context owned by the engine with no Canvas 2D fallback; PixiJS stays a W2+ evaluation, revisit before W2 rendering work.
- D2 — 2026-10-03 — Good score weight = 0.5 (W1 spec §2.4), not 0.40 (PLAN §7.3). — the W1 spec is authoritative for W1; re-evaluate with the rest of scoring in W2.
- D3 — 2026-10-03 — `JUDGE_WINDOWS`/`SCORE_WEIGHTS` live in `packages/shared/src/constants.ts`, not `apps/web/src/shared/constants.ts` as the spec's §2.5.2 comment shows. — PLAN §20.3: `packages/shared` is the single source of truth; the worker (W4) imports the same constants.
- D4 — 2026-10-03 — Pulse schema = §12.1 shape `{t, s, k?}` plus optional `durationMs` (zod default 80); fixture writes `durationMs: 80` explicitly. — spec §2.2 requires `pulse.durationMs = 80` while §12.1 canonical pulses have no such field; optional+default satisfies both without breaking canonical consumers.
- D5 — 2026-10-03 — Node 22+ required repo-wide (`engines` in workspace root; CI already pins 22). Smoke script uses the native global `WebSocket` client (stable since Node 21/22) — **no `ws` dependency**.
- D6 — 2026-10-03 — `/health` 60 s cache = in-module TTL state (a single `{ expires }` object, not a `Map` — one entry needs no key space), lightweight per spec §2.10, not the Cache API. — simplest thing that satisfies "lightweight cached health"; isolate-local is acceptable for a health probe.
- D7 — 2026-10-03 — W1 does not create/wire Supabase (spec §2.13); the Supabase project is an environment prerequisite only.
- D8 — 2026-10-03 (full version table resolved 2026-10-04) — **Dependency freeze**: every registry dependency in the workspace is pinned to an exact version (no `^`, `~`, `@latest`); `packageManager` pinned to `pnpm@12.8.1+sha512.f64ba907507f5ceafe06c8d38e6052d0179444580ec1279ddd5bfc11cb48aa8a2644b66598e07e761da84872a9fc57d5f902b87fa49d024198d558612aabbe45` (resolved by `corepack use pnpm@latest` on 2026-10-03); grouped justification for the PLAN §5.1 stack-sanctioned deps: `@airhythm/shared` — `zod`, `typescript`, `vitest` — is the sanctioned shared-package stack (schema validation, strict typecheck, unit tests); dependency build scripts approved via `allowBuilds` in `pnpm-workspace.yaml` (`esbuild`, `workerd` — only what the workspace needs, no blanket allow). — later machines install that exact pnpm via corepack, not "latest"; this entry is the version record for the freeze — after A5.5 no task may add, remove, or change any dependency version (B6 runs `playwright install chromium` only, never `pnpm add`).

  | Scope | Package | Exact version |
  | --- | --- | --- |
  | pnpm | `packageManager` (pnpm) | 12.8.1 (sha512 pin in root `package.json`) |
  | shared | zod | 4.6.5 |
  | shared | typescript | 7.0.2 |
  | shared | vitest | 5.0.3 |
  | web | next | 15.5.27 |
  | web | react (peer pair) | 19.3.0 |
  | web | react-dom (peer pair) | 19.3.0 |
  | web | tailwindcss | 4.3.3 |
  | web | @tailwindcss/postcss | 4.3.3 |
  | web | postcss | 8.5.28 |
  | web | @types/node | 26.6.4 |
  | web | @types/react | 19.3.0 |
  | web | @types/react-dom | 19.3.0 |
  | web | vitest | 5.0.3 |
  | web | jsdom | 30.1.1 |
  | web | @testing-library/react | 16.3.3 |
  | web | @testing-library/dom | 10.4.2 |
  | web | typescript | 6.0.3 |
  | worker | wrangler | 4.147.0 |
  | worker | @cloudflare/workers-types | 5.20261003.1 |
  | worker | vitest | 5.0.3 |
  | worker | typescript | 7.0.2 |
  | tooling | @playwright/test | 1.63.0 (in-plan pin; re-confirmed as registry `latest` 2026-10-05 — user ruling: latest playwright for automated tests; supersedes A5.5 pin) |
  | tooling | vercel | 62.2.0 |

  **EOL caveat:** Next 15 reaches EOL **2026-10-21** — accepted risk for W1 only. **W2+ must upgrade to Next 16** (required; do not drop this line when planning W2).
- D9 — 2026-10-05 — Playwright browser pair for B6 e2e: `@playwright/test` **1.63.0** (registry `latest` on 2026-10-05, same as the A5.5 pin) installs Chromium **v1243** — Chrome for Testing 153.0.8010.12 (+ headless shell v1243, ffmpeg v1011, winldd v1007), from `playwright install --dry-run chromium`. — exact package↔browser revision record so CI and local installs match; B6's `playwright install chromium` runs against the package's own revision (no 1234/1243 mismatch).
- D10 — 2026-10-05 — Vitest config renamed `.ts` → `.mjs`. — silences Node 22 ESM loader warning; config content unchanged. status: accepted.
- D11 — 2026-10-05 — Vercel deploy shape: CLI upload rooted at `web_app/game` via the pinned `vercel` binary, `rootDirectory: apps/web` (relative to the upload root); git integration disconnected — CLI-only deploys. — matches C2's verified deploy; upload-root cwd must stay the workspace root (pnpm exec chdirs break it). status: accepted.
- D12 — 2026-10-05 — CI actions bumped to node24 majors: `checkout@v5`, `setup-node@v5`, `pnpm/action-setup@v5`, `upload-artifact@v6`. — user ruling against GitHub's node20 action runtime deprecation. status: accepted.
- D13 — 2026-10-05 — HUD state `activeLane` → `activeLanes: number[]`. — user-reported chord-highlight defect (chords share one lane slot and overwrite each other); spec only mandates key-label feedback. status: accepted.
- D14 — 2026-10-05 — `@playwright/test@latest` resolves to **1.63.0** (registry has no newer stable) — version bump was a no-op; D8's tooling row amended with the "latest playwright" user ruling. — records the ruling and keeps the D8 table truthful. status: accepted.
- D15 — 2026-10-06 — Next.js 15.5.27 → 16.3.8 exact pin (Active LTS at 2026-10-06 review; re-verified at install — 16.3.8 is the newest stable 16.x on npm). Resolved: next=16.3.8, react=19.3.0, react-dom=19.3.0, @types/react=19.3.0, @types/react-dom=19.3.0, @types/node=26.6.4. Migrations: audit found no `next lint` script, no middleware.ts, no async request API (params/cookies/headers) call sites in `src/app`. One incompatibility: Turbopack is the Next 16 default but does not support webpack-only `experimental.extensionAlias`, which this repo relies on for ESM-style `./x.js` specifiers over `.ts` sources (`packages/shared/src/index.ts`, `src/engine/*`, `src/ui/*`); `dev`/`build` scripts pinned to `--webpack` (official Next 16 opt-out) — documented ceiling: revisit Turbopack when import specifiers can be rewritten (outside task file scope). `next-env.d.ts` regenerated by Next 16 build. Verified: `pnpm -r typecheck && pnpm -r test && pnpm --filter @airhythm/web build`, Playwright e2e, `scripts/smoke.mjs`, and Vercel production deploy (build log: `Next.js 16.3.8 (webpack)`). Browser floor: Chrome/Edge/Firefox 111, Safari 16.4. — spec §3.1 (E3); amends D8 table (web/next row: 15.5.27 → 16.3.8). status: accepted.
- D16 — 2026-10-06 — SCORE_WEIGHTS.good = 0.40 (PLAN §7.3 supersedes W1 spec 0.5, resolving D2); combo bonus = floor(base × (1 + 0.05 × maxCombo/totalTargets)), score cap 1,050,000, accuracy untouched. — PLAN §7.3. status: accepted.
- D17 — 2026-10-06 — New W2 deps (exact pins): fflate@0.8.3 (beatmap-formats, .osz extraction with during-inflation limits), pngjs@7.0.0 (packages/assets atlas, added in T21 per Global Constraints pin). pixi.js/pixi-filters are spike-only, never merged (spec §8). D8 freeze lifted for W2 per operator ruling. status: accepted.
- D18 — 2026-10-07 — PixiJS evaluation verdict: adopt pre-W7. Pixi p95 16.70 ms vs WebGL2 16.70 ms (dev mode, W1 benchmark, same machine); filter coverage: 5/6 checklist items available in pixi-filters v6.1.5 / pixi.js 8.22.0 (AdvancedBloom, RGBSplit, Blur, ColorMatrix invert, noise/fog), scanline = 1 custom GLSL filter (≤2 allowed); migration estimate: ~1–2 days to port renderer-webgl.ts to a Pixi scene graph (noteY math unchanged; code-drawn quads → sprites/Graphics) + W7 editor gains display-tree tooling. Migration is scheduled pre-W7 per operator ruling; no adoption in W2. Spike deps removed (lockfile clean). — spec §6.1 (E4, decision-only per operator). status: accepted.
- D19 — 2026-10-07 — Kenney kit: UI Pack (standard) + Particle Pack + Pattern Pack 2, all CC0, sources in assets/src/. Early style check (T23) is the swap gate. — spec §6.2/§11.1. status: accepted.
- D20 — 2026-10-14 — A14 keep-alive: daily GitHub Actions cron (17 4 * * *) issues a named-table PostgREST read `GET /rest/v1/keepalive?select=*&limit=1` against a dedicated single-row `public.keepalive` table with a permissive RLS SELECT (migration web_app/supabase/migrations/20261012_keepalive.sql). Credentials: publishable key (`sb_publishable_…`, GitHub secret SUPABASE_PUBLISHABLE_KEY — Supabase docs: safe to expose online; least privilege under the table's policy). **No secret-key fallback exists (round 4): a wrong/missing publishable key fails the run visibly; the remedy is fixing the key/grants — never escalating to a project-wide RLS-bypassing credential for a single-row read**; never the legacy `service_role` JWT (deprecated end-2026). REST root `/rest/v1/` is OpenAPI introspection and does not reset the pause timer — premise re-verified against Supabase "Project Pausing" docs + community evidence 2025–2026. Claims are observational: a few DB requests/day are "typically" enough but immunity is not guaranteed. Green = workflow_dispatch 2xx AND a ~10-day no-warning-email window. Escalation if a warning still arrives: UPSERT mutation ping (community-verified pattern). **Round 11 P1-14/P2-25: a paid Supabase Pro upgrade is a FUTURE OPTION OUTSIDE W3 — it CANNOT satisfy A14's W3 acceptance criteria (C2, $0 infrastructure, no payment card). If the UPSERT escalation also fails to prevent the warning, A14 is documented as INCOMPLETE (carry-over to W4) and W3 floor completion is not affected by A14 (the one A-row permitted to lag). The Pro-upgrade path is recorded here for W4+ planning only, never as a W3 green condition.** — spec §3 A14, §8 default 4 (supersedes Q14's 3-day cadence; PLAN §5.2 "every 3 days" row). status: accepted.
