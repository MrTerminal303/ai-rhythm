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

  it("render expiry deadline extends by calibration: calib=100 → pending at t+111, missed at t+211", () => {
    // superseded brief text ("expiry stays uncalibrated"): a raw-only sweep at t+111 would
    // pre-empt the calibrated-perfect input (t+110+max(calib,0) = t+210 is the deadline)
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }], 100);
    src.t = 1111;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    src.t = 1211; // past t+210
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("missed");
    expect(engine.snapshot().events).toEqual([{ type: "miss", lane: 0, chartTime: 1211 }]);
  });

  it("render expiry: calib=150 → pending at t+111 and t+200, missed by t+261", () => {
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }], 150);
    src.t = 1111;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    expect(engine.isFrozen()).toBe(false);
    src.t = 1200;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    expect(engine.isFrozen()).toBe(false);
    src.t = 1261; // past t+110+150 = t+260
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("missed");
    expect(engine.isFrozen()).toBe(true);
  });

  it("render expiry: calib=0 → miss at t+111 exactly as before (bit-identical)", () => {
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }]);
    src.t = 1111;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("missed");
    expect(engine.snapshot().events).toEqual([{ type: "miss", lane: 0, chartTime: 1111 }]);
  });

  it("render expiry: calib=−150 → raw governs, no early expiry; missed by t+111", () => {
    // calibrated-only expiry would miss at chartTime ≥ t−40 (before the note's time)
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }], -150);
    src.t = 1000;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    src.t = 1111;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("missed");
  });

  it("freeze gate extends by calibration: calib=150 does not freeze before t+260", () => {
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }], 150);
    src.t = 1250; // raw past endTimeMs (t+110) but calibrated not
    engine.update();
    expect(engine.isFrozen()).toBe(false);
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    src.t = 1261;
    engine.update();
    expect(engine.isFrozen()).toBe(true);
    expect(engine.snapshot().noteStates[0]).toBe("missed");
  });

  it("judges a calibrated-perfect tap beyond the raw window (selection uses judgeDt)", () => {
    // raw distance 150 > 110: a raw pre-filter would drop this tap and auto-miss the note.
    // Real-play order: the render sweep runs first and must NOT expire the note pre-judge.
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }], 150);
    src.t = 1149;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    engine.judge(0, 1150);
    const snap = engine.snapshot();
    expect(snap.noteStates[0]).toBe("hit");
    expect(snap.events[0]).toMatchObject({ type: "hit", grade: "perfect", dt: 0 });
    expect(snap.events.some((e) => e.type === "miss")).toBe(false);
  });

  it("raw-coincident tap with negative calibration is NOT forced to a hit", () => {
    // raw distance 0 passes a raw pre-filter, but calibrated time = t+150 puts dt outside
    // the window: no hit event, no score, note stays pending; render sweep then misses it
    const { src, engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }], -150);
    engine.judge(0, 1000);
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    expect(engine.snapshot().events.some((e) => e.type === "hit")).toBe(false);
    expect(engine.snapshot().score).toBe(0);
    src.t = 1111;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("missed");
  });
});

// W2 T17: hold judging — head/tail targets, keyup, totalTargets (Review Focus 4+5)
// Snapshots carry per-call events only (§2.7); multi-step assertions read previousSnapshot().
describe("hold judging (W2 T17)", () => {
  const hold = (id: number, t: number, d: number, lane = 0): Beatmap["notes"][number] => ({
    id, t, lane, type: "hold", d,
  });

  it("head hit at keydown, tail hit at keyup within ±150 ms (d window)", () => {
    const { engine } = setup([hold(0, 1000, 500)]);
    engine.judge(0, 1010); // head Perfect (dt=10)
    const afterHead = engine.snapshot();
    expect(afterHead.events).toEqual([{ type: "hit", grade: "perfect", lane: 0, dt: 10, noteId: 0 }]);
    engine.release(0, 1495); // tail dt=-5 → Perfect
    const snap = engine.snapshot();
    expect(snap.events).toEqual([{ type: "hit", grade: "perfect", lane: 0, dt: -5, noteId: 0 }]);
    expect(engine.previousSnapshot()).toEqual(afterHead); // head event preserved in prev
    expect(snap.noteStates[0]).toBe("hit");
    expect(snap.combo).toBe(2);
    // totalTargets = 2 (head+tail); both perfect → accuracy 1, score floor(1e6×1.05)
    expect(snap.accuracy).toBe(1);
    expect(snap.score).toBe(1_050_000);
  });

  it("early release → tail Miss only; head stays hit", () => {
    const { engine } = setup([hold(0, 1000, 500)]);
    engine.judge(0, 1010); // head hit
    const afterHead = engine.snapshot();
    expect(afterHead.events).toEqual([{ type: "hit", grade: "perfect", lane: 0, dt: 10, noteId: 0 }]);
    engine.release(0, 1300); // dt = 1300-1500 = -200 < -150 → tail Miss
    const snap = engine.snapshot();
    expect(snap.events).toEqual([{ type: "miss", lane: 0, chartTime: 1300 }]);
    expect(engine.previousSnapshot()).toEqual(afterHead); // head hit unchanged
    expect(snap.combo).toBe(0); // combo resets on tail miss
    // second release: tail already missed → no pending tail → no new events
    engine.release(0, 1495);
    expect(engine.snapshot().events).toEqual([]);
  });

  it("missed head leaves tail pending and hittable (Review Focus 5)", () => {
    const { src, engine } = setup([hold(0, 1000, 500)]);
    src.t = 1111; // past head deadline t+110
    engine.update();
    expect(engine.snapshot().events).toEqual([{ type: "miss", lane: 0, chartTime: 1111 }]);
    // tail untouched — still hittable at its own deadline
    engine.release(0, 1495);
    const snap = engine.snapshot();
    expect(snap.events).toEqual([{ type: "hit", grade: "perfect", lane: 0, dt: -5, noteId: 0 }]);
    expect(snap.combo).toBe(1); // tail hit starts combo at 1 (head miss reset it)
    expect(snap.noteStates[0]).toBe("missed"); // not all targets hit → note missed (renderer stops drawing)
  });

  it("tail auto-misses only after t+d+150 (own deadline, not head's)", () => {
    const { src, engine } = setup([hold(0, 1000, 500)]);
    src.t = 1500; // head already past t+110, tail still before t+d+150=1650
    engine.update();
    expect(engine.snapshot().events).toEqual([{ type: "miss", lane: 0, chartTime: 1500 }]); // head
    expect(engine.snapshot().noteStates[0]).toBe("pending"); // tail pending → note pending
    src.t = 1651;
    engine.update();
    const snap = engine.snapshot();
    expect(snap.events).toEqual([{ type: "miss", lane: 0, chartTime: 1651 }]); // tail at its own deadline
    expect(snap.noteStates[0]).toBe("missed");
  });

  it("calibrated tail expiry: calib=100 → tail pending at 1700, missed at 1751 (ruling 1)", () => {
    // tail deadline dual-domain: (t+d)+150+max(calib,0) = 1500+150+100 = 1750
    const { src, engine } = setup([hold(0, 1000, 500)], 100);
    src.t = 1700; // raw > 1650, calibrated 1600 < 1650 → still pending
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("pending");
    src.t = 1751;
    engine.update();
    expect(engine.snapshot().noteStates[0]).toBe("missed");
  });

  it("calibrated release window: calib=50 shifts dt (ruling 2)", () => {
    // release at 1540: dt = 1540-50-1500 = -10 → Perfect; without calib dt=40 → Great
    const { engine: cal } = setup([hold(0, 1000, 500)], 50);
    cal.judge(0, 1050); // head dt=0 Perfect (calibrated)
    cal.release(0, 1540);
    expect(cal.snapshot().events).toEqual([{ type: "hit", grade: "perfect", lane: 0, dt: -10, noteId: 0 }]);

    const { engine: raw } = setup([hold(0, 1000, 500)]);
    raw.judge(0, 1050);
    raw.release(0, 1540);
    expect(raw.snapshot().events).toEqual([{ type: "hit", grade: "great", lane: 0, dt: 40, noteId: 0 }]);
  });

  it("calibrated early-release boundary: calib=50 → release at 1390 misses (dt=-160)", () => {
    const { engine } = setup([hold(0, 1000, 500)], 50);
    engine.judge(0, 1050);
    engine.release(0, 1390); // dt = 1390-50-1500 = -160 < -150 → miss
    expect(engine.snapshot().events).toEqual([{ type: "miss", lane: 0, chartTime: 1390 }]);
  });

  it("totalTargets = taps + 2×holds; counts sum at freeze", () => {
    const { src, engine } = setup([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      hold(1, 2000, 500),
    ]);
    // all perfect path: 3 targets (tap + head + tail), maxCombo 3, accuracy 1
    engine.judge(0, 1010); // tap Perfect
    engine.judge(0, 2010); // hold head Perfect
    engine.release(0, 2495); // hold tail Perfect (t+d=2500, dt=-5)
    const full = engine.snapshot();
    expect(full.accuracy).toBe(1); // 3/3 — denominator is 3, not notes.length (2)
    expect(full.combo).toBe(3);
    expect(full.score).toBe(1_050_000);
    expect(full.noteStates).toEqual(["hit", "hit"]);

    // all-miss path: sum of resolved === totalTargets
    const { src: src2, engine: e2 } = setup([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      hold(1, 2000, 500),
    ]);
    src2.t = 2651; // past tap (1110) and tail (2650) deadlines
    const miss = e2.update();
    expect(miss.frozen).toBe(true);
    expect(miss.noteStates).toEqual(["missed", "missed"]);
    expect(miss.events.filter((e) => e.type === "miss")).toHaveLength(3); // tap + head + tail
    expect(miss.accuracy).toBe(0);
    expect(miss.score).toBe(0);
  });

  it("successful tail increments combo AND maxCombo (full-combo hold chart reaches maxCombo === totalTargets)", () => {
    const { engine } = setup([hold(0, 1000, 500)]);
    engine.judge(0, 1010); // head → combo 1
    engine.release(0, 1495); // tail → combo 2, maxCombo 2
    const snap = engine.snapshot();
    expect(snap.combo).toBe(2);
    // totalTargets=2; maxCombo=2 → multiplier 1.05 → floor(1e6*1.05)=1_050_000.
    // If tail did NOT update maxCombo, multiplier would be 1.025 → 1_025_000.
    expect(snap.score).toBe(1_050_000);
  });

  it("full-combo chart (1 tap + 1 hold): maxCombo === totalTargets = 3, combo multiplier 1.05 attainable", () => {
    const { engine } = setup([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      hold(1, 2000, 500),
    ]);
    engine.judge(0, 1010); // tap
    engine.judge(0, 2010); // head
    engine.release(0, 2495); // tail
    const snap = engine.snapshot();
    expect(snap.combo).toBe(3);
    expect(snap.score).toBe(1_050_000); // comboMultiplier(3, 3) = 1.05
  });

  it("a miss (any target) resets combo — including a tail miss after a head hit", () => {
    const { engine } = setup([
      hold(0, 1000, 500),
      { id: 1, t: 3000, lane: 1, type: "tap" },
    ]);
    engine.judge(0, 1010); // head hit → combo 1
    engine.release(0, 1300); // tail miss → combo 0
    expect(engine.snapshot().combo).toBe(0);
    engine.judge(1, 3010); // next hit starts combo at 1
    expect(engine.snapshot().combo).toBe(1);
  });

  it("release on a tap lane is a no-op; release on a hold without judged head still hits tail", () => {
    const { engine } = setup([{ id: 0, t: 1000, lane: 0, type: "tap" }]);
    engine.judge(0, 1000);
    engine.release(0, 1495); // tap lane — no pending tail → no-op
    expect(engine.snapshot().events).toEqual([]);

    const { engine: e2 } = setup([hold(1, 1000, 500, 2)]);
    e2.release(2, 1495); // release sweeps expiry first: overdue head missed, then tail dt=-5 hits
    expect(e2.snapshot().events).toEqual([
      { type: "miss", lane: 2, chartTime: 1495 },
      { type: "hit", grade: "perfect", lane: 2, dt: -5, noteId: 1 },
    ]);
  });
});
