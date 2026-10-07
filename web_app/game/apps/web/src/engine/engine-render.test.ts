import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { GameEngine } from "./engine.js";
import { PerformanceClock } from "./clock.js";
import { noteY, WebGLRenderer } from "./renderer-webgl.js";
import type { GameSnapshot, NoteState, Renderer } from "./types.js";

const chart: Beatmap = {
  version: 1,
  meta: { title: "t", artist: "a", creator: "c", difficulty: "d", tags: [], previewMs: 0 },
  song: { songKey: "file:test", durationMs: 30_000, audioOffsetMs: 0 },
  timing: [{ t: 0, bpm: 120, meter: 4 }],
  keys: 4,
  notes: [
    { id: 0, t: 1000, lane: 0, type: "tap" },
    { id: 1, t: 2000, lane: 2, type: "tap" },
  ],
  pulses: [{ t: 0, s: 1, durationMs: 80 }],
  gen: { source: "manual", timingSource: "manual" },
};

class FakeTime {
  t = 0;
  calls = 0;
  nowMs() { this.calls++; return this.t; }
}
class SpyRenderer implements Renderer {
  calls: { time: number; states: readonly NoteState[] }[] = [];
  render(chartTimeMs: number, noteStates: readonly NoteState[]): void {
    // capture the states AS RENDERED — a snapshot assertion alone can't tell
    // "expire → render → emit" from "render → expire → emit"
    this.calls.push({ time: chartTimeMs, states: [...noteStates] });
  }
  dispose(): void {}
}

function makeEngine() {
  const src = new FakeTime();
  const clock = new PerformanceClock(src);
  const renderer = new SpyRenderer();
  const engine = new GameEngine({ chart, clock, renderer });
  return { src, clock, renderer, engine };
}

describe("GameEngine update ordering (§2.9)", () => {
  it("reads clock once per update and renders with that chartTime", () => {
    const { src, clock, renderer, engine } = makeEngine();
    clock.start(0); // start() itself reads the clock once
    const callsAfterStart = src.calls;
    src.t = 500;
    engine.update();
    expect(renderer.calls.map((c) => c.time)).toEqual([500]);
    expect(engine.snapshot().chartTimeMs).toBe(500);
    expect(src.calls).toBe(callsAfterStart + 1); // exactly ONE clock read inside update()
  });

  it("expires pending notes at chartTime > t + 110 BEFORE render (sweep, no input)", () => {
    const { src, clock, renderer, engine } = makeEngine();
    clock.start(0);
    src.t = 1111; // note 0 at t=1000 → 1000+110=1110, 1111 > 1110
    const snap = engine.update();
    // renderer already saw the expired state — pins expire → render, not just expire → emit
    expect(renderer.calls[0]?.states[0]).toBe("missed");
    expect(renderer.calls[0]?.states[1]).toBe("pending");
    expect(snap.noteStates[0]).toBe("missed");
    expect(snap.noteStates[1]).toBe("pending");
    expect(snap.events).toEqual([{ type: "miss", lane: 0, chartTime: 1111 }]);
    expect(snap.score).toBe(0);
    expect(snap.combo).toBe(0);
  });

  it("does not expire at exactly t + 110", () => {
    const { src, clock, engine } = makeEngine();
    clock.start(0);
    src.t = 1110;
    const snap = engine.update();
    expect(snap.noteStates[0]).toBe("pending");
  });

  it("no duplicate miss: second update +50ms after expiry re-emits nothing (pending guard)", () => {
    const { src, clock, engine } = makeEngine();
    clock.start(0);
    src.t = 1111; // note0 (t=1000) expires: 1111 > 1000 + 110
    const first = engine.update();
    expect(first.events).toEqual([{ type: "miss", lane: 0, chartTime: 1111 }]);
    expect(first.noteStates).toEqual(["missed", "pending"]);
    expect(first.frozen).toBe(false);
    src.t = 1161; // +50ms — guard must skip the already-missed note0, no re-emission
    const second = engine.update();
    expect(second.events).toEqual([]);
    expect(second.noteStates).toEqual(["missed", "pending"]);
    expect(second.frozen).toBe(false);
  });

  it("emits a NEW snapshot each update; previous stays intact (§2.7)", () => {
    const { src, clock, engine } = makeEngine();
    clock.start(0);
    src.t = 100;
    engine.update();
    const first = engine.snapshot();
    const savedBefore = structuredClone(first);
    src.t = 200;
    engine.update();
    expect(engine.previousSnapshot()).toEqual(savedBefore);
    expect(engine.snapshot()).not.toBe(first);
  });

  it("computes endTimeMs = max(t) + 110 for non-empty charts", () => {
    const { engine } = makeEngine();
    expect(engine.snapshot().endTimeMs).toBe(2000 + 110);
  });
});

describe("renderer position rule (§2.8)", () => {
  it("noteY = hitLineY - (note.t - chartTime) * scrollPxPerMs", () => {
    // renderer-webgl.ts computes y through this exported helper, so the test pins
    // the real production math (not a re-implementation in the test)
    expect(noteY(1000, 0, 800, 0.5)).toBe(300); // 1 s ahead → 800 − 1000·0.5 = 300, above the hit line
    expect(noteY(1000, 1000, 800, 0.5)).toBe(800); // exactly at the hit line
    expect(noteY(1000, 2000, 800, 0.5)).toBe(1300); // 1 s past → 800 − (−1000)·0.5 = 1300, below the hit line
  });
});

it("Review Focus #4: judging again never mutates an earlier snapshot", () => {
  const { engine } = makeEngine(); // notes at 1000 (lane 0) and 2000 (lane 2)
  engine.judge(0, 1000);           // snapshot A: note0 hit
  const snapA = engine.snapshot();
  const savedA = structuredClone(snapA);
  engine.judge(2, 2000);           // snapshot B: note1 hit
  const snapB = engine.snapshot();
  expect(snapB).not.toBe(snapA);
  expect(snapA).toEqual(savedA);       // old snapshot contents untouched
  expect(engine.previousSnapshot()).toBe(snapA); // rotation order
});

// ---- W2 T22: atlas-textured note path vs code-drawn fallback ----

const ATLAS_JSON = {
  meta: { size: { width: 1796, height: 1282 }, generator: "test" },
  frames: {
    "ui/button_rectangle_flat": { x: 257, y: 1026, w: 192, h: 64 },
    "ui/slide_horizontal_grey_section_wide": { x: 643, y: 1026, w: 32, h: 16 },
  },
};

// hold (body + head) AND tap in view at chartTime 1000 — exercises both frame paths
const atlasChart: Beatmap = {
  ...chart,
  notes: [
    { id: 0, t: 1000, lane: 0, type: "hold", d: 500 },
    { id: 1, t: 2000, lane: 2, type: "tap" },
  ],
};

// WebGL2 stub: noop methods + opaque constants — enough for construction and one render();
// correctness of GPU-side behavior is the B6/visual e2e's job, not this unit's
function makeFakeGL(): WebGL2RenderingContext {
  const noop = () => undefined;
  return {
    createShader: () => ({}), shaderSource: noop, compileShader: noop,
    getShaderParameter: () => true, getShaderInfoLog: () => null,
    createProgram: () => ({}), attachShader: noop, linkProgram: noop,
    getProgramParameter: () => true, getProgramInfoLog: () => null,
    createBuffer: () => ({}), bindBuffer: noop, bufferData: noop, bufferSubData: noop,
    createTexture: () => ({}), bindTexture: noop, activeTexture: noop,
    texImage2D: noop, texParameteri: noop, pixelStorei: noop,
    getAttribLocation: (_p: unknown, name: string) => (name === "a_pos" ? 0 : 1),
    getUniformLocation: () => ({}),
    enableVertexAttribArray: noop, disableVertexAttribArray: noop, vertexAttribPointer: noop,
    enable: noop, disable: noop, blendFunc: noop,
    useProgram: noop, uniform2f: noop, uniform1i: noop,
    viewport: noop, clearColor: noop, clear: noop, drawArrays: noop,
    deleteBuffer: noop, deleteProgram: noop, deleteTexture: noop,
    // enums (opaque tokens for the noop calls above)
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
  const gl = makeFakeGL();
  return {
    getContext: (kind: string) => (kind === "webgl2" ? gl : null),
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    dataset: {},
  } as unknown as HTMLCanvasElement;
}

function stubAtlasFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/atlas/atlas.json")) return { ok: true, json: async () => ATLAS_JSON };
    if (url.endsWith("/atlas/sprites.png")) return { ok: true, blob: async () => ({}) };
    return { ok: false, status: 404 };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1796, height: 1282, close: () => undefined })));
  return fetchMock;
}

describe("atlas-textured note path (W2 T22)", () => {
  beforeEach(() => {
    // node env: no DOM — the renderer reads --you via getComputedStyle and dpr via window
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    vi.stubGlobal("window", { devicePixelRatio: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("without atlas: code-drawn fallback only (no textured draw)", () => {
    const renderer = new WebGLRenderer(makeFakeCanvas(), atlasChart);
    renderer.render(1000, ["pending", "pending"]);
    expect(renderer.drawCounts.solid).toBeGreaterThan(0); // lanes/receptors/hit line + notes
    expect(renderer.drawCounts.textured).toBe(0);
    renderer.dispose();
  });

  it("initAtlas success: notes switch to the textured batch; lanes/hit line stay code-drawn", async () => {
    stubAtlasFetch();
    const renderer = new WebGLRenderer(makeFakeCanvas(), atlasChart);
    expect(await renderer.initAtlas()).toBe(true);
    renderer.render(1000, ["pending", "pending"]);
    expect(renderer.drawCounts.textured).toBe(1); // single batched textured draw (one bind)
    expect(renderer.drawCounts.solid).toBe(1); // lanes/receptors/hit line still code-drawn
    renderer.dispose();
  });

  it("initAtlas is idempotent: concurrent + late calls share one load (one fetch per asset)", async () => {
    const fetchMock = stubAtlasFetch();
    const renderer = new WebGLRenderer(makeFakeCanvas(), atlasChart);
    const first = renderer.initAtlas();
    const second = renderer.initAtlas();
    expect(second).toBe(first); // race guard: second call returns the in-flight promise
    expect(await first).toBe(true);
    expect(await renderer.initAtlas()).toBe(true); // settled call: same result, no reload
    expect(fetchMock).toHaveBeenCalledTimes(2); // atlas.json + sprites.png — exactly one load
    renderer.dispose();
  });

  it("initAtlas failure resolves false (never rejects) and gameplay stays code-drawn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const renderer = new WebGLRenderer(makeFakeCanvas(), atlasChart);
    expect(await renderer.initAtlas()).toBe(false);
    expect(await renderer.initAtlas()).toBe(false); // idempotent after settle
    renderer.render(1000, ["pending", "pending"]);
    expect(renderer.drawCounts.textured).toBe(0);
    expect(renderer.drawCounts.solid).toBeGreaterThan(0);
    renderer.dispose();
  });
});
