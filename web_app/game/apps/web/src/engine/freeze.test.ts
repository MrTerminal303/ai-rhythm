import { describe, expect, it } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { GameEngine } from "./engine.js";
import { PerformanceClock } from "./clock.js";
import type { Renderer } from "./types.js";

class FakeTime {
  t = 0;
  nowMs() { return this.t; }
}
const noopRenderer: Renderer = { render: () => {}, dispose: () => {} };

function mkChart(notes: Beatmap["notes"], durationMs = 30_000): Beatmap {
  return {
    version: 1,
    meta: { title: "t", artist: "a", creator: "c", difficulty: "d", tags: [], previewMs: 0 },
    song: { songKey: "file:test", durationMs, audioOffsetMs: 0 },
    timing: [{ t: 0, bpm: 120, meter: 4 }],
    keys: 4, notes, pulses: [],
    gen: { source: "manual", timingSource: "manual" },
  };
}

function setup(notes: Beatmap["notes"], durationMs = 30_000) {
  const src = new FakeTime();
  const clock = new PerformanceClock(src);
  const engine = new GameEngine({ chart: mkChart(notes, durationMs), clock, renderer: noopRenderer });
  clock.start(0);
  return { src, engine };
}

describe("chart end + freeze ordering (§2.9)", () => {
  it("endTime = max(t) + 110; empty chart uses song.durationMs", () => {
    const a = setup([{ id: 0, t: 5000, lane: 0, type: "tap" }]);
    expect(a.engine.snapshot().endTimeMs).toBe(5110);
    const b = setup([], 12_345);
    expect(b.engine.snapshot().endTimeMs).toBe(12_345);
  });

  it("Review Focus #3: NOT frozen at chartTime === endTime; frozen at +1ms with last note already missed", () => {
    const { src, engine } = setup([{ id: 0, t: 5000, lane: 0, type: "tap" }]); // endTime 5110
    src.t = 5110;
    let snap = engine.update();
    expect(snap.frozen).toBe(false);
    expect(engine.isFrozen()).toBe(false);
    expect(snap.noteStates[0]).toBe("pending"); // dt = 110 still judgeable
    src.t = 5111;
    snap = engine.update();
    expect(snap.frozen).toBe(true);
    expect(snap.noteStates[0]).toBe("missed"); // expiry ran BEFORE freeze in same update
    expect(snap.events).toEqual([{ type: "miss", lane: 0, chartTime: 5111 }]);
  });

  it("documented exception: judge() in the boundary→next-update window cannot score", () => {
    const { engine } = setup([{ id: 0, t: 5000, lane: 0, type: "tap" }]); // endTime 5110
    // no update() has run since chartTime crossed endTime: isFrozen() still false,
    // but every note is past t+110, so judge's own expiry sweep resolves it before matching
    expect(engine.isFrozen()).toBe(false);
    engine.judge(0, 5111);
    const snap = engine.snapshot();
    expect(snap.noteStates[0]).toBe("missed");
    expect(snap.score).toBe(0);
    expect(snap.combo).toBe(0);
  });

  it("Review Focus #2: empty chart freezes only after song.durationMs; score/accuracy stay 0", () => {
    const { src, engine } = setup([], 10_000);
    src.t = 10_000;
    expect(engine.update().frozen).toBe(false);
    expect(engine.update().score).toBe(0);
    expect(engine.update().accuracy).toBe(0);
    src.t = 10_001;
    const snap = engine.update();
    expect(snap.frozen).toBe(true);
    expect(snap.score).toBe(0);
    expect(Number.isNaN(snap.accuracy)).toBe(false);
  });

  it("post-freeze: update() throws, judge() throws, score/combo/accuracy unchanged", () => {
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }]);
    engine.judge(0, 1000); // perfect: score 1000000, combo 1
    const before = engine.snapshot();
    src.t = 5000;
    engine.update(); // freezes (endTime = 1110)
    const final = engine.snapshot();
    expect(final.frozen).toBe(true);
    expect(() => engine.update()).toThrow(/frozen/);
    expect(() => engine.judge(0, 5000)).toThrow(/frozen/);
    // final state matches: score/combo/accuracy unchanged by rejected calls
    expect(engine.snapshot()).toBe(final);
    expect(final.score).toBe(before.score);
    expect(final.combo).toBe(1);
    // GameSnapshot not mutated by attempted calls (§2.7 / B5 verify)
    const cloned = structuredClone(final);
    try { engine.judge(1, 5000); } catch { /* expected */ }
    try { engine.update(); } catch { /* expected */ }
    expect(final).toEqual(cloned);
  });

  it("final snapshot before freeze contains every resolved note (no pending leaks)", () => {
    const { src, engine } = setup([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      { id: 1, t: 2000, lane: 1, type: "tap" },
    ]);
    engine.judge(0, 1000);
    src.t = 2200;
    const snap = engine.update(); // endTime 2110 → frozen, note1 missed
    expect(snap.frozen).toBe(true);
    expect(snap.noteStates).toEqual(["hit", "missed"]);
  });
});