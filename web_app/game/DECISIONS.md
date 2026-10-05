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
