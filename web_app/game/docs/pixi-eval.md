# PixiJS evaluation (W2 T19 — decision-only spike)

**Verdict: adopt pre-W7.** Both criteria met: pixi p95 ≤ current WebGL2 p95 (tie at the vsync
ceiling) and filter coverage ≥ the §6.3 checklist with 1 custom shader (≤ 2 allowed). Per operator
ruling there is **no adoption in W2** — migration is scheduled as a pre-W7 task (DECISIONS D18).

## Bench numbers (2026-10-07)

| Bench | p95 frame interval (rAF) | Window | Notes |
|---|---|---|---|
| Pixi v8.22.0 scratch page (`/dev-pixi-bench`) | **16.70 ms** (n = 1805) | 30 s | 200 tinted rounded-rect sprites scrolling downward, 4 lanes, `preference: "webgl"` |
| Current WebGL2 (`/play?chart=benchmark`) | **16.70 ms** | full 178 s chart (+3 s countdown) | `[perf]` console report: `p95RenderDurationMs 0.20`, `p95UpdateDurationMs 3.0`, `pass: true` |

**Methodology:** same machine, same browser tab size (viewport), both in `next dev` (webpack),
driven through Playwright MCP. Machine: 550-160l, Intel Core i3-6100 @ 3.70 GHz, 16 GB RAM,
Windows 10 Pro. Both figures are p95 of `requestAnimationFrame` frame intervals (the WebGL2 side
is the existing `PerfMonitor.p95FrameIntervalMs()`; the pixi side is the bench page's own rAF loop
per the T19 brief).

**Caveats (dev mode):** both runs are dev-mode (`next dev`, unminified) — numbers are for
comparison against each other, not as production budgets. Both p95s land exactly on the 60 Hz
vsync ceiling (16.70 ms), so the honest reading is *neither renderer drops >5% of frames at this
load* — the bench is vsync-bound and does not measure headroom beyond 60 FPS. The windows differ
(30 s vs 178 s) and this is a single run each; a margin-scrubbing difference would need repeated
runs to resolve. Samples for the WebGL2 run: the nested `samples` object printed collapsed in
console; at 60 Hz over 178 s ≈ 10.7 k frames.

## Filter-coverage checklist (spec §6.3 toolkit)

Checked statically against the installed spike pins: `pixi.js@8.22.0`, `pixi-filters@6.1.5`.

| Checklist item | Mapping | Call |
|---|---|---|
| `AdvancedBloomFilter` | `pixi-filters/advanced-bloom` → `AdvancedBloomFilter` | available |
| `RGBSplitFilter` | `pixi-filters/rgb-split` → `RGBSplitFilter` | available |
| `BlurFilter` | pixi.js core `filters/defaults/blur` | available |
| `ColorMatrixFilter` invert | pixi.js core `ColorMatrixFilter.negative(multiply)` inverts RGB, preserves alpha (direct `matrix` set for an exact invert if ever needed) | available |
| noise / fog | pixi.js core `NoiseFilter` (intensity + seed); `pixi-filters/simplex-noise` as the richer variant — fog is a noise overlay + alpha, same mechanism | available |
| scanline | no scanline filter in pixi-filters 6.1.5 (only `CRTFilter`, a curvature+scanline composite that is not a plain scanline overlay) → custom `Filter.from` GLSL fragment (~15 lines, per `pixijs-filters` skill) | **custom-code needed** |

**Coverage: 5 of 6 available out-of-the-box; 1 custom shader (scanline). Criterion was ≥ checklist
with ≤ 2 custom shaders — met.**

## Migration estimate

**`renderer-webgl.ts` (~170 lines, code-drawn quads) → Pixi scene graph:**

- Constructor / GL program / vertex-buffer plumbing → `new Application()` + `await app.init({ resizeTo: window, preference: "webgl" })`. The custom vertex+fragment shader pair, `quad()` packing, buffer uploads, and blend setup are all deleted — pixi batches sprites itself.
- Notes + hold bodies: `Sprite` (W2 atlas, 9-sliced per T21–T24) with `sprite.tint = --you`; lane panels / receptors / hit line: `Graphics` rects (§6.5.1 keeps them code-drawn — Graphics *is* code-drawn).
- `noteY()` math, scroll constant, culling bounds: unchanged (pure function, already test-pinned by `engine-render.test.ts`).
- Resize: `resizeTo: window` replaces the manual `resize()` + `u_res` uniform handling (dpr handled by `resolution`/`autoDensity`).
- `dispose()` → `app.destroy({ removeView: true, releaseGlobalResources: true })`.
- Estimate: **1–2 days** for the port + re-wiring renderer contract tests and the e2e screenshot path. Risk is low: the renderer is a leaf behind the `Renderer` interface; engine, judging, and clock code do not touch WebGL.

**Editor (W7):** a pixi display tree gives inspectable nodes, z-order/layers, and transform tools
for free; the code-drawn-quad path would require custom hit-testing and redraw plumbing for every
editor affordance. Editor work is *cheaper* on pixi — this is the main long-term win the adoption
buys.

## What was run

- Spike install: `pnpm --filter @airhythm/web add --save-exact pixi.js@8.22.0 pixi-filters@6.1.5`
- Scratch bench page `apps/web/src/app/dev-pixi-bench/page.tsx` (deleted before commit).
- `pnpm --filter @airhythm/web dev` → Playwright MCP: `/dev-pixi-bench` (30 s), `/play?chart=benchmark` (full run, `[perf]` console report).
- Spike deps removed in Step 4; `pnpm-lock.yaml` verified pixi-free.

Related: DECISIONS D18; spec §6.1 (E4).
