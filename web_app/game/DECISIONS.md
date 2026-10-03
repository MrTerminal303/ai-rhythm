# DECISIONS.md

One line per decision: `D# — date — decision — why`.

- D1 — 2026-10-03 — W1 renderer is raw WebGL2 (code-drawn lanes/receptors/hit line/pooled notes), NOT PixiJS v8 (PLAN Q19/§5.1). — W1 spec §2.11 mandates a WebGL2 context owned by the engine with no Canvas 2D fallback; PixiJS stays a W2+ evaluation, revisit before W2 rendering work.
- D2 — 2026-10-03 — Good score weight = 0.5 (W1 spec §2.4), not 0.40 (PLAN §7.3). — the W1 spec is authoritative for W1; re-evaluate with the rest of scoring in W2.
- D3 — 2026-10-03 — `JUDGE_WINDOWS`/`SCORE_WEIGHTS` live in `packages/shared/src/constants.ts`, not `apps/web/src/shared/constants.ts` as the spec's §2.5.2 comment shows. — PLAN §20.3: `packages/shared` is the single source of truth; the worker (W4) imports the same constants.
- D4 — 2026-10-03 — Pulse schema = §12.1 shape `{t, s, k?}` plus optional `durationMs` (zod default 80); fixture writes `durationMs: 80` explicitly. — spec §2.2 requires `pulse.durationMs = 80` while §12.1 canonical pulses have no such field; optional+default satisfies both without breaking canonical consumers.
- D5 — 2026-10-03 — Node 22+ required repo-wide (`engines` in workspace root; CI already pins 22). Smoke script uses the native global `WebSocket` client (stable since Node 21/22) — **no `ws` dependency**.
- D6 — 2026-10-03 — `/health` 60 s cache = in-module TTL state (a single `{ expires }` object, not a `Map` — one entry needs no key space), lightweight per spec §2.10, not the Cache API. — simplest thing that satisfies "lightweight cached health"; isolate-local is acceptable for a health probe.
- D7 — 2026-10-03 — W1 does not create/wire Supabase (spec §2.13); the Supabase project is an environment prerequisite only.
- D8 — 2026-10-03 — `packageManager` pinned to `pnpm@12.8.1+sha512.f64ba907507f5ceafe06c8d38e6052d0179444580ec1279ddd5bfc11cb48aa8a2644b66598e07e761da84872a9fc57d5f902b87fa49d024198d558612aabbe45` (resolved by `corepack use pnpm@latest` on 2026-10-03). — later machines install that exact version via corepack, not "latest"; the resolved exact version is the pin.
- D9 — 2026-10-03 — Deps added to `@airhythm/shared`: `zod`, `typescript`, `vitest` (caret ranges for now). — PLAN §5.1 stack-sanctioned deps for the shared package (schema validation, strict typecheck, unit tests); A5.5's exactness sweep later strips manifests to exact versions.
