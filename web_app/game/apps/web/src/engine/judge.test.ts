import { describe, expect, it } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { GameEngine } from "./engine.js";
import { PerformanceClock } from "./clock.js";
import type { Renderer } from "./types.js";

const mk = (notes: Beatmap["notes"], durationMs = 30_000): Beatmap => ({
  version: 1,
  meta: { title: "t", artist: "a", creator: "c", difficulty: "d", tags: [], previewMs: 0 },
  song: { songKey: "file:test", durationMs, audioOffsetMs: 0 },
  timing: [{ t: 0, bpm: 120, meter: 4 }],
  keys: 4,
  notes,
  pulses: [],
  gen: { source: "manual", timingSource: "manual" },
});

class FakeTime {
  t = 0;
  nowMs() { return this.t; }
}
const noopRenderer: Renderer = { render: () => {}, dispose: () => {} };

function setup(notes: Beatmap["notes"], deviceCalibrationOffsetMs?: number) {
  const src = new FakeTime();
  const clock = new PerformanceClock(src);
  const engine = new GameEngine({ chart: mk(notes), clock, renderer: noopRenderer, deviceCalibrationOffsetMs });
  clock.start(0);
  return { src, clock, engine };
}

describe("engine.judge (§2.3)", () => {
  it("wrong-lane press does NOT judge the note", () => {
    const { engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }]);
    engine.judge(1, 1000);
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    expect(engine.snapshot().score).toBe(0);
  });

  it("at t = note.t + 111 the note is expired first: missed, no candidate, no score", () => {
    const { engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }]);
    engine.judge(0, 1111);
    const snap = engine.snapshot();
    expect(snap.noteStates[0]).toBe("missed");
    expect(snap.score).toBe(0);
    expect(snap.combo).toBe(0);
    expect(snap.events.some((e) => e.type === "miss")).toBe(true);
    expect(snap.events.some((e) => e.type === "hit")).toBe(false);
  });

  it("at exactly t + 110 the note is still judgeable (good boundary)", () => {
    const { engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }]);
    engine.judge(0, 1110);
    const snap = engine.snapshot();
    expect(snap.noteStates[0]).toBe("hit");
    expect(snap.events).toEqual([{ type: "hit", grade: "good", lane: 0, dt: 110, noteId: 0 }]);
    expect(snap.combo).toBe(1);
    expect(snap.score).toBe(Math.floor(1_000_000 * 0.4 * 1.05)); // good 0.40, combo 1/1 → +5% (D16)
  });

  it("two taps same t on different lanes both judged", () => {
    const { engine } = setup([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      { id: 1, t: 1000, lane: 2, type: "tap" },
    ]);
    engine.judge(0, 1000);
    engine.judge(2, 1000);
    const snap = engine.snapshot();
    expect(snap.noteStates).toEqual(["hit", "hit"]);
    expect(snap.combo).toBe(2);
    expect(snap.score).toBe(1_050_000); // both perfect, maxCombo 2/2 → +5% (D16)
  });

  it("picks nearest pending tap by |dt|; drops |dt| > 110", () => {
    // id0 must be a FUTURE note beyond the window: a past note at chartTime 1040 would be
    // consumed by expiry-first (spec §2.3 step 2) and never reach the step-4 discard branch
    const { engine } = setup([
      { id: 0, t: 1300, lane: 0, type: "tap" },
      { id: 1, t: 1050, lane: 0, type: "tap" },
    ]);
    engine.judge(0, 1060); // |dt| to id0 = 240 (>110, dropped), to id1 = 10
    const snap = engine.snapshot();
    expect(snap.noteStates).toEqual(["pending", "hit"]);
    expect(snap.events).toContainEqual({ type: "hit", grade: "perfect", lane: 0, dt: 10, noteId: 1 });
  });

  it("tie-break: same |dt| chooses lower noteId", () => {
    const { engine } = setup([
      { id: 5, t: 1000, lane: 0, type: "tap" },
      { id: 9, t: 1040, lane: 0, type: "tap" },
    ]);
    engine.judge(0, 1020); // dt = -20 to id5, +20 to id9
    expect(engine.snapshot().events[0]).toMatchObject({ noteId: 5, grade: "perfect" });
  });

  it("hit combo accumulates; miss resets it; score floors per formula", () => {
    const { engine } = setup([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      { id: 1, t: 2000, lane: 0, type: "tap" },
      { id: 2, t: 3000, lane: 0, type: "tap" },
    ]);
    engine.judge(0, 1000); // perfect
    engine.judge(0, 2070); // great (dt=70)
    engine.judge(0, 4000); // id2 expired during judge (4000 > 3110) → miss
    const snap = engine.snapshot();
    expect(snap.combo).toBe(0);
    // sumWeights = 1 + 0.75 + 0 = 1.75; total = 3; maxCombo = 2 →
    // base 583333.33 × (1 + 0.05×2/3) = 602777.77… → 602777 (D16)
    expect(snap.score).toBe(602_777);
    expect(snap.accuracy).toBeCloseTo(1.75 / 3, 6);
  });

  it("engine passes maxCombo into score (bonus grows with combo)", () => {
    const { engine } = setup([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      { id: 1, t: 2000, lane: 0, type: "tap" },
    ]);
    engine.judge(0, 1000); // perfect
    engine.judge(0, 2000); // perfect
    // 2-note chart, both Perfect: totalTargets=2, maxCombo=2 → floor(1e6 * 1.0 * 1.05) = 1_050_000
    expect(engine.snapshot().score).toBe(1_050_000);
  });

  it("render-loop sweep and input expiry agree; no duplicate miss events", () => {
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }]);
    src.t = 1111;
    expect(engine.update().noteStates[0]).toBe("missed");
    // engine is now frozen (chartTime > endTimeMs); further update() throws
    expect(engine.isFrozen()).toBe(true);
    expect(engine.snapshot().events).toEqual([{ type: "miss", lane: 0, chartTime: 1111 }]);
  });
});

describe("deviceCalibrationOffsetMs (W2 T9)", () => {
  it("applies deviceCalibrationOffsetMs to dt (positive = late input)", () => {
    // note at t=1000, inputMs=1050: calib=50 → dt=0 (Perfect); calib=0 → dt=50 (Great)
    const { engine: calibrated } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }], 50);
    calibrated.judge(0, 1050);
    expect(calibrated.snapshot().events[0]).toMatchObject({ type: "hit", grade: "perfect", dt: 0 });

    const { engine: uncalibrated } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }]);
    uncalibrated.judge(0, 1050);
    expect(uncalibrated.snapshot().events[0]).toMatchObject({ type: "hit", grade: "great", dt: 50 });
  });

  it("auto-miss expiry uses render chartTime, NOT calibration", () => {
    // calib=100: if expiry wrongly subtracted calibration, 1111-100=1011 would never exceed t+110
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }], 100);
    src.t = 1110;
    engine.update(); // exactly t+110: still judgeable (boundary unchanged)
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    src.t = 1111;
    engine.update(); // past t+110: missed, same as calib=0
    expect(engine.snapshot().noteStates[0]).toBe("missed");
    expect(engine.snapshot().events).toEqual([{ type: "miss", lane: 0, chartTime: 1111 }]);
  });
});
