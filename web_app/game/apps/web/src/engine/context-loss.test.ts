// A7 (W3 T10): WebGL context-loss boundary — the thin attachContextHandlers path.
// The renderer's GL listener registration + once-only onContextLost + initGL rebuild-on-restore
// is covered here; the page-level pause-path (D7 ordering, score/position preservation) is
// proven by e2e/w3-context-loss.spec.ts against a real browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { WebGLRenderer } from "./renderer-webgl.js";

const chart: Beatmap = {
  version: 1,
  meta: { title: "t", artist: "a", creator: "c", difficulty: "d", tags: [], previewMs: 0 },
  song: { songKey: "file:test", durationMs: 30_000, audioOffsetMs: 0 },
  timing: [{ t: 0, bpm: 120, meter: 4 }],
  keys: 4,
  notes: [{ id: 0, t: 1000, lane: 0, type: "tap" }],
  pulses: [{ t: 0, s: 1, durationMs: 80 }],
  gen: { source: "manual", timingSource: "manual" },
};

// Minimal WebGL2 stub — mirrors engine-render.test.ts's makeFakeGL, plus a createBuffer
// spy so the restore test can assert GL was re-initialized. The canvas stub records the
// A7 lifecycle handlers (webglcontextlost/restored dispatch on the CANVAS element).
function makeFakeGL(createBufferSpy: ReturnType<typeof vi.fn>): WebGL2RenderingContext {
  const noop = () => undefined;
  return {
    createShader: () => ({}), shaderSource: noop, compileShader: noop,
    getShaderParameter: () => true, getShaderInfoLog: () => null,
    createProgram: () => ({}), attachShader: noop, linkProgram: noop,
    getProgramParameter: () => true, getProgramInfoLog: () => null,
    createBuffer: createBufferSpy,
    bindBuffer: noop, bufferData: noop, bufferSubData: noop,
    createTexture: () => ({}), bindTexture: noop, activeTexture: noop,
    texImage2D: noop, texParameteri: noop,
    getAttribLocation: (_p: unknown, name: string) => (name === "a_pos" ? 0 : 1),
    getUniformLocation: () => ({}),
    enableVertexAttribArray: noop, disableVertexAttribArray: noop, vertexAttribPointer: noop,
    enable: noop, disable: noop, blendFunc: noop,
    useProgram: noop, uniform2f: noop, uniform1i: noop,
    viewport: noop, clearColor: noop, clear: noop, drawArrays: noop,
    deleteBuffer: noop, deleteProgram: noop, deleteTexture: noop,
    getExtension: () => null,
    // enums
    ARRAY_BUFFER: 34962, DYNAMIC_DRAW: 35044, FLOAT: 5126,
    BLEND: 3042, SRC_ALPHA: 770, ONE_MINUS_SRC_ALPHA: 771,
    COLOR_BUFFER_BIT: 16384, TRIANGLES: 4,
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713, LINK_STATUS: 35714,
    TEXTURE_2D: 3553, TEXTURE0: 33984,
    TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243,
    LINEAR: 9729, CLAMP_TO_EDGE: 33071,
  } as unknown as WebGL2RenderingContext;
}

type Handlers = Record<string, (e: { preventDefault(): void }) => void>;

function makeFakeCanvas(gl: WebGL2RenderingContext, handlers: Handlers): HTMLCanvasElement {
  return {
    getContext: (kind: string) => (kind === "webgl2" ? gl : null),
    addEventListener: (type: string, fn: (e: { preventDefault(): void }) => void) => { handlers[type] = fn; },
    removeEventListener: () => undefined,
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    dataset: {},
  } as unknown as HTMLCanvasElement;
}

// An atlas.json fetch that always fails (HTTP 500) — the shortest path to a COMMITTED
// non-null atlas verdict ("fallback"), the same seam atlas-fallback.test.ts drives. The stub
// honours `init.signal` so the renderer's 5 s AbortController bound can cancel it.
function failingAtlasFetch(): typeof fetch {
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return { ok: false, status: 500 } as Response;
  }) as unknown as typeof fetch;
}

describe("A7 renderer context-loss boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    // window stub: devicePixelRatio for resize(), plus setTimeout/clearTimeout for
    // loadAtlas()'s 5 s AbortController bound (the renderer calls them on `window`).
    vi.stubGlobal("window", {
      devicePixelRatio: 1,
      setTimeout: ((cb: Parameters<typeof setTimeout>[0], ms?: Parameters<typeof setTimeout>[1]) =>
        setTimeout(cb, ms)) as unknown as typeof setTimeout,
      clearTimeout: ((id?: unknown) => clearTimeout(id as Parameters<typeof clearTimeout>[0])) as unknown as typeof clearTimeout,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("contextlost: preventDefault called (restore allowed), onContextLost fired exactly once", () => {
    const handlers: Handlers = {};
    const gl = makeFakeGL(vi.fn(() => ({})));
    const onContextLost = vi.fn();
    new WebGLRenderer(makeFakeCanvas(gl, handlers), chart, { onContextLost });

    const ev = { preventDefault: vi.fn() };
    handlers["webglcontextlost"]?.(ev);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(onContextLost).toHaveBeenCalledTimes(1);
    // second contextlost event (browser can re-fire) — no stacking
    handlers["webglcontextlost"]?.(ev);
    expect(onContextLost).toHaveBeenCalledTimes(1);
  });

  it("contextrestored: initGL runs again (createBuffer count increases), onContextRestored fired", () => {
    const handlers: Handlers = {};
    const createBuffer = vi.fn(() => ({}));
    const gl = makeFakeGL(createBuffer);
    const onContextLost = vi.fn();
    const onContextRestored = vi.fn();
    const renderer = new WebGLRenderer(makeFakeCanvas(gl, handlers), chart, { onContextLost, onContextRestored });

    const afterCtor = createBuffer.mock.calls.length;
    expect(afterCtor).toBe(2); // solid + textured buffer at construction

    // drive the lost → restored lifecycle
    handlers["webglcontextlost"]?.({ preventDefault: vi.fn() });
    expect(onContextLost).toHaveBeenCalledTimes(1);
    handlers["webglcontextrestored"]?.({ preventDefault: () => undefined });
    expect(onContextRestored).toHaveBeenCalledTimes(1);
    expect(createBuffer.mock.calls.length).toBeGreaterThan(afterCtor); // GL rebuilt on restore
    renderer.dispose();
  });

  it("contextrestored: the fresh programs get u_res + viewport again (F3 — no black playfield)", () => {
    // F3 (final review): initGL() rebuilds the programs but does NOT re-set u_res or
    // gl.viewport — those live only in resize(). A fresh program's u_res defaults to (0,0),
    // and both shaders divide by it: every vertex clips to +-Inf and the playfield is BLACK.
    // The restore handler must therefore re-do the resize. This test FAILS without it.
    const handlers: Handlers = {};
    const gl = makeFakeGL(vi.fn(() => ({})));
    const uniform2f = vi.fn();
    const viewport = vi.fn();
    gl.uniform2f = uniform2f as unknown as typeof gl.uniform2f;
    gl.viewport = viewport as unknown as typeof gl.viewport;
    const renderer = new WebGLRenderer(makeFakeCanvas(gl, handlers), chart, {});

    const uniformAfterCtor = uniform2f.mock.calls.length;
    const viewportAfterCtor = viewport.mock.calls.length;
    expect(uniformAfterCtor).toBeGreaterThan(0); // the ctor's resize() set u_res
    expect(viewportAfterCtor).toBeGreaterThan(0); // ... and the viewport

    handlers["webglcontextlost"]?.({ preventDefault: vi.fn() });
    handlers["webglcontextrestored"]?.({ preventDefault: () => undefined });

    // the restore re-did BOTH — the count grew instead of staying at the ctor's value
    expect(uniform2f.mock.calls.length).toBeGreaterThan(uniformAfterCtor);
    expect(viewport.mock.calls.length).toBeGreaterThan(viewportAfterCtor);
    renderer.dispose();
  });

  it("contextrestored: the atlas verdict is cleared (atlasState reports null, not the stale one)", async () => {
    // F3 (final review): initGL() must clear _atlasState alongside the other atlas resets —
    // otherwise the seam reports "loaded" through the whole re-fetch window while the
    // renderer actually draws the code-drawn fallback.
    //
    // The verdict must be PRIMED to a real, COMMITTED non-null value first: the previous
    // version of this row asserted null before AND after the restore, so deleting
    // initGL()'s `this._atlasState = null` left it GREEN (it could not fail).
    const handlers: Handlers = {};
    const gl = makeFakeGL(vi.fn(() => ({})));
    vi.stubGlobal("fetch", failingAtlasFetch());
    const renderer = new WebGLRenderer(makeFakeCanvas(gl, handlers), chart, {});
    expect(renderer.atlasState).toBeNull(); // undecided before initAtlas settles

    // PRIME: an HTTP-500 atlas.json drives the renderer to the permanent "fallback" verdict.
    await expect(renderer.initAtlas()).resolves.toBe(false);
    expect(renderer.atlasState).toBe("fallback"); // the verdict the restore must clear

    handlers["webglcontextlost"]?.({ preventDefault: vi.fn() });
    handlers["webglcontextrestored"]?.({ preventDefault: () => undefined });
    expect(renderer.atlasState).toBeNull(); // the stale "fallback" verdict did NOT survive
    renderer.dispose();
  });
});
