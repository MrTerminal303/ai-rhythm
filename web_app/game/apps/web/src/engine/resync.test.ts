import { describe, expect, it } from "vitest";
import { ResyncController, RESYNC_TRANSITIONS } from "./resync.js";
import { GameEngine } from "./engine.js";
import type { Renderer } from "./types.js";
import { PerformanceClock } from "./clock.js";

const ALL_STATES = ["aligned", "resyncing", "recovery-paused"] as const;
const ALL_EVENTS = ["device-change", "alignment-ok", "alignment-lost", "interruption", "user-resume"] as const;

describe("A11 resync transition table", () => {
  it("every legal transition applies; every other pair throws (full matrix)", () => {
    for (const from of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const c = new ResyncController(from); // constructor accepts an initial state (tests); production starts "aligned"
        const expected = RESYNC_TRANSITIONS[from][event];
        if (expected === undefined) {
          expect(() => c.dispatch(event)).toThrow(/illegal resync transition/);
          expect(c.current).toBe(from); // failed dispatch changes nothing
        } else {
          expect(c.dispatch(event)).toBe(expected);
          expect(c.current).toBe(expected);
        }
      }
    }
  });
  it("interruption is represented as the recovery state from every state (never a silent no-op)", () => {
    for (const from of ALL_STATES) {
      const c = new ResyncController(from);
      expect(c.dispatch("interruption")).toBe("recovery-paused");
    }
  });
  it("device change never jumps alignment by itself — only via explicit verdicts", () => {
    const c = new ResyncController();
    expect(c.current).toBe("aligned");
    expect(c.dispatch("device-change")).toBe("resyncing");
    expect(c.dispatch("alignment-ok")).toBe("aligned"); // continuity held → nothing else happened
  });
});

describe("A11 judgement continuity: resync dispatches never touch engine state", () => {
  it("consumed targets stay consumed across a full device-change → recovery → resume cycle", () => {
    const chart = {
      song: { title: "t", artist: "a", audioOffsetMs: 0, durationMs: 60_000 },
      timing: [{ t: 0, bpm: 120, meter: 4 }], pulses: [],
      notes: [{ id: 0, t: 1000, lane: 0, type: "tap" }, { id: 1, t: 2000, lane: 0, type: "tap" }],
    } as never;
    const engine = new GameEngine({ chart, clock: new PerformanceClock(), renderer: { render() {}, dispose() {} } as Renderer });
    engine.judge(0, 1000);
    const before = engine.snapshot();
    expect(before.combo).toBe(1);
    const r = new ResyncController();
    r.dispatch("device-change");
    r.dispatch("alignment-lost");      // → recovery-paused (page pauses; engine untouched here)
    r.dispatch("user-resume");
    r.dispatch("alignment-ok");        // → aligned
    expect(engine.snapshot()).toBe(before); // IDENTICAL object — no re-emit, no replay, no jump
    // note 0 cannot be hit again; note 1 still pending
    expect(engine.noteStates()[0]).toBe("hit");
    engine.judge(0, 2000); // second tap on the consumed note's lane/window — only note 1 can match
    expect(engine.snapshot().combo).toBe(2);
    expect(engine.noteStates()[1]).toBe("hit");
  });
});
