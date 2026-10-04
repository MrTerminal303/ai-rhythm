import { describe, expect, it } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { GameEngine } from "./engine.js";
import { PerformanceClock } from "./clock.js";
import { noteY } from "./renderer-webgl.js";
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
