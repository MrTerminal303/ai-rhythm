import { describe, expect, it } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { GameEngine } from "./engine/engine.js";
import { PerformanceClock } from "./engine/clock.js";
import { SnapshotStore } from "./ui/snapshot-store.js";
import type { NoteState, Renderer } from "./engine/types.js";

const chart: Beatmap = {
  version: 1,
  meta: { title: "t", artist: "a", creator: "c", difficulty: "d", tags: [], previewMs: 0 },
  song: { songKey: "file:t", durationMs: 10_000, audioOffsetMs: 0 },
  timing: [{ t: 0, bpm: 120, meter: 4 }],
  keys: 4,
  notes: [{ id: 0, t: 1000, lane: 0, type: "tap" }], // endTime = 1110
  pulses: [],
  gen: { source: "manual", timingSource: "manual" },
};
class FakeTime {
  t = 0;
  nowMs() { return this.t; }
}
class Spy implements Renderer {
  last: readonly NoteState[] = [];
  render(_t: number, states: readonly NoteState[]): void { this.last = [...states]; }
  dispose(): void {}
}

describe("integration invariants (each arrow pinned once)", () => {
  it("clock → engine → renderer → snapshot → store", () => {
    const src = new FakeTime();
    const clock = new PerformanceClock(src);
    const renderer = new Spy();
    const store = new SnapshotStore();
    const engine = new GameEngine({ chart, clock, renderer });
    clock.start(0);
    src.t = 1111; // past miss window
    store.set(engine.update());
    expect(renderer.last[0]).toBe("missed"); // engine → renderer (expired BEFORE render)
    expect(store.getSnapshot()?.noteStates[0]).toBe("missed"); // engine → snapshot → store
  });

  it("judge → snapshot (keydown path)", () => {
    const src = new FakeTime();
    const clock = new PerformanceClock(src);
    const store = new SnapshotStore();
    const engine = new GameEngine({ chart, clock, renderer: new Spy() });
    clock.start(0);
    engine.judge(0, 1000);
    store.set(engine.snapshot());
    expect(store.getSnapshot()?.noteStates[0]).toBe("hit");
    expect(store.getSnapshot()?.combo).toBe(1);
  });

  it("endTime → freeze (update() is the sole transition)", () => {
    const src = new FakeTime();
    const clock = new PerformanceClock(src);
    const store = new SnapshotStore();
    const engine = new GameEngine({ chart, clock, renderer: new Spy() });
    clock.start(0);
    src.t = 1111;
    store.set(engine.update());
    expect(engine.isFrozen()).toBe(true);
    expect(store.getSnapshot()?.frozen).toBe(true);
  });
});