// A9 (W3 T13): atlas fetch timeout → permanent fallback.
// initAtlas() races a 5 s AbortController timeout per fetch; on timeout/error the renderer
// records a PERMANENT "fallback" atlasState (code-drawn path, set once per session, never
// retried) and resolves false instead of throwing into gameplay. The e2e (w3-affordances)
// forces a blocked atlas route in a real browser and asserts the highway still renders.
//
// Unit-test approach: the renderer calls `window.setTimeout`, so we install a window stub
// whose setTimeout/clearTimeout route through vitest's fake-timer clock (vi.useFakeTimers()
// patches globalThis.setTimeout). A hung fetch (rejects only on abort) + advanceTimersByTime
// (5000) drives the 5 s AbortController bound; the abort rejects the fetch and the renderer
// commits atlasState="fallback" and resolves false.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { WebGLRenderer } from "./renderer-webgl.js";

// same minimal chart as context-loss.test.ts
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

type AtlasState = "loaded" | "fallback";

type RendererWithAtlasSeam = WebGLRenderer & {
  /** A9: atlasState test seam — "loaded" only after a committed load, "fallback" permanent */
  atlasState: AtlasState;
};

function makeFakeGL(): WebGL2RenderingContext {
  const noop = () => undefined;
  return {
    createShader: () => ({}), shaderSource: noop, compileShader: noop,
    getShaderParameter: () => true, getShaderInfoLog: () => null,
    createProgram: () => ({}), attachShader: noop, linkProgram: noop,
    getProgramParameter: () => true, getProgramInfoLog: () => null,
    createBuffer: vi.fn(() => ({})),
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

function makeFakeCanvas(): HTMLCanvasElement {
  return {
    getContext: (kind: string) => (kind === "webgl2" ? makeFakeGL() : null),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    dataset: {},
  } as unknown as HTMLCanvasElement;
}

// window stub shared by all tests: the renderer's loadAtlas uses window.setTimeout/
// clearTimeout, so route them through the CURRENT globalThis versions (vitest's fake clock
// when vi.useFakeTimers() is active, the real ones otherwise).
// ponytail: the closure captures globalThis.setTimeout BY REFERENCE at call time — when
// fake timers are armed BEFORE the renderer's window.setTimeout runs, the fake clock wins;
// when real, the real timer wins. One stub covers both paths without re-installing.
function installWindowStub(): void {
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    setTimeout: ((cb: Parameters<typeof setTimeout>[0], ms?: Parameters<typeof setTimeout>[1]) =>
      setTimeout(cb, ms)) as unknown as typeof setTimeout,
    clearTimeout: ((id?: unknown) => clearTimeout(id as Parameters<typeof clearTimeout>[0])) as unknown as typeof clearTimeout,
  });
}

// A9 test seam (brief Step 1): construct with a stubbed global fetch that honors the
// AbortSignal — the injected fetch NEVER resolves until the renderer aborts it.
function makeRendererWithInjectedFetch(fetchImpl: typeof fetch): RendererWithAtlasSeam {
  installWindowStub();
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubGlobal("createImageBitmap", () => {
    throw new Error("createImageBitmap must not run on the timeout path");
  });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  return new WebGLRenderer(makeFakeCanvas(), chart, {}) as unknown as RendererWithAtlasSeam;
}

// A fetch that NEVER resolves unless the caller's signal aborts — models a hung/blocked
// atlas route. The renderer's 5 s AbortController bound is what unblocks it.
function abortingFetch() {
  return vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const s = init?.signal;
      if (!s) return; // no signal (shouldn't happen post-A9) → hang
      if (s.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      s.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  ) as unknown as typeof fetch;
}

const okJsonAtlas = () => ({
  meta: { size: { width: 100, height: 100 } },
  frames: {
    "ui/button_rectangle_flat": { x: 0, y: 0, w: 50, h: 50 },
    "ui/slide_horizontal_grey_section_wide": { x: 50, y: 0, w: 50, h: 50 },
  },
});

describe("A9 renderer atlas timeout + permanent fallback", () => {
  beforeEach(() => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    installWindowStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("atlas fetch timeout engages the permanent fallback, resolves false, no throw", async () => {
    const fetchMock = abortingFetch();
    vi.useFakeTimers(); // patch the fake clock BEFORE the window stub captures the fn refs
    const r = makeRendererWithInjectedFetch(fetchMock);
    const pending = r.initAtlas(); // arm the 5 s AbortController timer NOW
    vi.advanceTimersByTime(5000); // A9: the bound fires → fetch aborts → fallback committed
    await expect(pending).resolves.toBe(false);
    expect(r.atlasState).toBe("fallback");
  });

  it("fallback is permanent: a second initAtlas call never re-fetches", async () => {
    const fetchMock = abortingFetch();
    vi.useFakeTimers();
    const r = makeRendererWithInjectedFetch(fetchMock);
    const pending = r.initAtlas();
    vi.advanceTimersByTime(5000);
    await pending;
    const callsAfterFirst = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await r.initAtlas(); // concurrent/late callers get the settled promise
    expect((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(callsAfterFirst); // no retry per session
    expect(r.atlasState).toBe("fallback");
  });

  it("a failing atlas.json fetch (HTTP error) also engages the fallback, never throws", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return { ok: false, status: 500 } as Response;
    }) as unknown as typeof fetch;
    const r = makeRendererWithInjectedFetch(fetchMock);
    await expect(r.initAtlas()).resolves.toBe(false);
    expect(r.atlasState).toBe("fallback");
  });

  it("a successful atlas load commits atlasState to loaded (texture path active)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (String(url).endsWith("atlas.json")) {
        return { ok: true, status: 200, json: async () => okJsonAtlas() } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = makeRendererWithInjectedFetch(fetchMock);
    // the loaded path needs a working createImageBitmap — override the throwing stub
    vi.stubGlobal("createImageBitmap", async () => ({ close: () => undefined }));
    await expect(r.initAtlas()).resolves.toBe(true);
    expect(r.atlasState).toBe("loaded");
  });
});
