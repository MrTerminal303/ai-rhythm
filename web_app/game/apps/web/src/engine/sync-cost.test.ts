import { describe, expect, it } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { GameEngine } from "./engine.js";
import { PerformanceClock } from "./clock.js";
import type { Renderer } from "./types.js";

function chartOf(n: number): Beatmap {
  return {
    version: 1,
    meta: { title: "t", artist: "a", creator: "c", difficulty: "d", tags: [], previewMs: 0 },
    song: { songKey: "file:test", durationMs: 60_000, audioOffsetMs: 0 },
    timing: [{ t: 0, bpm: 120, meter: 4 }],
    keys: 4,
    pulses: [],
    notes: Array.from({ length: n }, (_, i) => ({ id: i, t: 1000 + i * 100, lane: i % 4, type: "tap" as const })),
    gen: { source: "manual", timingSource: "manual" },
  } as never;
}

class FakeTime {
  t = 0;
  nowMs() { return this.t; }
}

const noopRenderer: Renderer = { render() {}, dispose() {} };

function setup(chart: Beatmap) {
  const src = new FakeTime();
  const clock = new PerformanceClock(src);
  const engine = new GameEngine({ chart, clock, renderer: noopRenderer });
  clock.start(0);
  return { src, engine };
}

describe("A3 fix 1 — per-frame sync cost proportional to CHANGED notes (not notes×targets)", () => {
  it("construction performs zero recomputes; one expired note costs exactly one recompute", () => {
    const chart = chartOf(100);
    const { src, engine } = setup(chart);
    expect(engine.noteStateRecomputes).toBe(0);
    // advance past note 0's deadline only (t=1000, window 110 → 1110+) via fake clock
    src.t = 1200;
    engine.update();
    expect(engine.noteStateRecomputes).toBe(1); // NOT 100 notes × 100 targets = 10 000
  });

  it("a judge recomputes only the judged note", () => {
    const chart = chartOf(100);
    const { engine } = setup(chart);
    engine.judge(0, 1000); // note 0 at t=1000
    expect(engine.noteStateRecomputes).toBe(1);
  });

  it("hold head+tail resolve to two target mutations (one per target, note-derived state tracks both)", () => {
    // other notes far in the future so the release-time expiry sweep marks nothing besides note 0
    const chart = chartOf(10);
    const notes = chart.notes.map((n, i) =>
      i === 0 ? { ...n, type: "hold" as const, d: 500 } : { ...n, t: 100_000 + i * 100 },
    );
    const { engine } = setup({ ...chart, notes });
    engine.judge(0, 1000);   // head → 1 recompute
    engine.release(0, 1500); // tail → 1 recompute
    // 2 targets on this note ⇒ 2 recomputes; still O(changed targets), not O(all notes)
    expect(engine.noteStateRecomputes).toBe(2);
    // derived per-note state: both targets hit → note is "hit"
    expect(engine.noteStates()[0]).toBe("hit");
  });

  it("noteStates accessor reflects derived state (behaviour parity with old syncStates)", () => {
    const chart = chartOf(2);
    const { engine } = setup(chart);
    expect(engine.noteStates()[0]).toBe("pending");
    engine.judge(0, 1000);
    expect(engine.noteStates()[0]).toBe("hit");
    expect(engine.noteStates()[1]).toBe("pending");
  });
});
