import { describe, expect, it } from "vitest";
import { GameEngine } from "./engine.js";
import { SnapshotStore } from "../ui/snapshot-store.js";
import type { GameSnapshot, Renderer } from "./types.js";
import { PerformanceClock } from "./clock.js";

const noopRenderer: Renderer = { render() {}, dispose() {} };
const chart = {
  song: { title: "t", artist: "a", audioOffsetMs: 0, durationMs: 60_000 },
  timing: [{ t: 0, bpm: 120, meter: 4 }], pulses: [],
  notes: [{ id: 0, t: 1000, lane: 0, type: "tap" }, { id: 1, t: 2000, lane: 1, type: "tap" }],
} as never;

describe("A3 fix 2 — compact snapshot", () => {
  it("snapshot shape has no per-note array", () => {
    const engine = new GameEngine({ chart, clock: new PerformanceClock(), renderer: noopRenderer });
    // W3 T21: maxCombo + judgementCounts are additive scalar fields (NOT a per-note array).
    expect(Object.keys(engine.snapshot()).sort()).toEqual(
      ["accuracy", "chartTimeMs", "combo", "endTimeMs", "events", "frozen", "judgementCounts", "maxCombo", "score"],
    );
  });

  it("stable identity: unchanged state → same object; published change → new object", () => {
    // Fake clock (review P0: no emitForTest seam — drive identity through update() instead)
    let now = 0;
    const clock = { chartTimeMs: () => now } as never;
    const engine = new GameEngine({ chart, clock, renderer: noopRenderer });
    const first = engine.update();   // t=0, nothing expired → snapshot with events: []
    const again = engine.update();   // identical observable state
    expect(again).toBe(first);       // stable identity while unchanged (React infinite-render guard)
    engine.judge(0, 1000);
    const afterJudge = engine.snapshot();
    expect(afterJudge).not.toBe(first); // new identity when a published snapshot changes
    expect(afterJudge.combo).toBe(1);
  });

  it("a published judgement event does not linger once the next snapshot has no events", () => {
    let now = 0;
    const clock = { chartTimeMs: () => now } as never;
    const engine = new GameEngine({ chart, clock, renderer: noopRenderer });
    engine.judge(0, 1000); // emits at chartTime 1000 with events [hit]
    const withEvents = engine.snapshot();
    expect(withEvents.events).toHaveLength(1);
    now = 1000; // same chartTime as the judge emit; no new events (note1 at 2000 not yet due)
    const cleared = engine.update();
    expect(cleared.events).toEqual([]);   // flash cleared — events are observable-change semantics
    expect(cleared).not.toBe(withEvents); // publishing the cleared state requires a new identity
  });

  it("store subscribers never observe torn state (whole snapshots only)", () => {
    // Final review F28: the expected values come from the ENGINE (it computes score / combo /
    // maxCombo / judgementCounts), NOT from hand-written literals the store never computes.
    // A torn read (score from one emit, combo from another) would break the ordering below.
    const engine = new GameEngine({ chart, clock: new PerformanceClock(), renderer: noopRenderer });
    const store = new SnapshotStore();
    const observed: GameSnapshot[] = [];
    store.subscribe(() => {
      const s = store.getSnapshot();
      if (s) observed.push(s);
    });
    engine.judge(0, 1000); // hits note id 0 (t=1000, lane 0) → combo 1
    const afterFirstHit = engine.snapshot();
    store.set(afterFirstHit);
    engine.judge(1, 2000); // hits note id 1 (t=2000, lane 1) → combo 2
    const afterSecondHit = engine.snapshot();
    store.set(afterSecondHit);

    expect(observed.length).toBe(2);
    // every observed snapshot IS the exact object the engine published — no field mixing
    expect(observed[0]).toBe(afterFirstHit);
    expect(observed[1]).toBe(afterSecondHit);
    // the engine's own numbers move together: a torn read would pair them from different emits
    expect(observed[1]!.combo).toBeGreaterThan(observed[0]!.combo);
    expect(observed[1]!.score).toBeGreaterThan(observed[0]!.score);
    expect(observed[1]!.maxCombo).toBe(observed[1]!.combo);
    expect(observed[0]!.judgementCounts).toBe(afterFirstHit.judgementCounts);
  });

  it("store.set with the identical object notifies nothing (identity short-circuit already present)", () => {
    const store = new SnapshotStore();
    const snap = {
      chartTimeMs: 0 as never,
      score: 0,
      combo: 0,
      accuracy: 0,
      frozen: false,
      endTimeMs: 1,
      events: [],
      maxCombo: 0,
      judgementCounts: { perfect: 0, great: 0, good: 0, miss: 0 },
    };
    store.set(snap);
    let calls = 0;
    store.subscribe(() => calls++);
    store.set(snap);
    expect(calls).toBe(0);
  });
});
