// apps/web/src/engine/clock-pair.test.ts
import { describe, expect, it } from "vitest";
import { samplePair, ClockPairKeeper } from "./clock-pair.js";
import { inputChartTimeMs } from "./time-math.js";

describe("samplePair", () => {
  it("prefers getOutputTimestamp mapping and labels the source (D21: conversion applied, both latency components present)", () => {
    const p = samplePair(
      { currentTime: 39.93 }, 5000,
      () => ({ performanceTime: 4990, contextTime: 39.9 }),
      { baseLatencySeconds: 0.005, outputLatencySeconds: 0.015 },
    );
    expect(p).toEqual({ performanceTimeMs: 5000, contextTimeSeconds: 39.93, source: "getOutputTimestamp", sampledAt: 5000 });
  });
  it("falls back when reader missing, null, or non-finite", () => {
    expect(samplePair({ currentTime: 40 }, 5000).source).toBe("fallback");
    expect(samplePair({ currentTime: 40 }, 5000, () => null).source).toBe("fallback");
    expect(samplePair({ currentTime: 40 }, 5000, () => ({ performanceTime: NaN, contextTime: 1 })).source).toBe("fallback");
    const fb = samplePair({ currentTime: 40 }, 5000, () => null);
    expect(fb.performanceTimeMs).toBe(5000);
    expect(fb.contextTimeSeconds).toBe(40);
  });
});

describe("ClockPairKeeper — refresh cadence ~1 s", () => {
  it("reuses a pair younger than maxAge, re-samples at/after maxAge", () => {
    let ctxTime = 10;
    const keeper = new ClockPairKeeper({ get currentTime() { return ctxTime; } }, { maxAgeMs: 1000 });
    const a = keeper.get(0);
    ctxTime = 10.4;
    const b = keeper.get(500);
    expect(b).toBe(a); // same object, not re-sampled
    ctxTime = 10.9;
    const c = keeper.get(1000);
    expect(c).not.toBe(a);
    expect(c.sampledAt).toBe(1000);
    expect(c.contextTimeSeconds).toBe(10.9);
  });
});

// W2 clock-pair tests that pinned the un-converted output value (orphaned by D21 T2):
// samplePair now converts output-stream → scheduled domain exactly once.
describe("samplePair — D21 conversion semantics", () => {
  it("prefers getOutputTimestamp mapping and labels the source (conversion: 39.9 + 0.005 + 0.015 → 39.92, perfNow 5000 vs ts.performanceTime 4990 → 39.93)", () => {
    const p = samplePair(
      { currentTime: 39.93 }, 5000,
      () => ({ performanceTime: 4990, contextTime: 39.9 }),
      { baseLatencySeconds: 0.005, outputLatencySeconds: 0.015 },
    );
    expect(p.source).toBe("getOutputTimestamp");
    // 39.9 + (5000 − 4990)/1000 + 0.005 + 0.015 = 39.93
    expect(p.contextTimeSeconds).toBeCloseTo(39.93, 9);
    expect(p.performanceTimeMs).toBe(5000);
    expect(p.sampledAt).toBe(5000);
  });
  it("fresh reading (perfNowMs === ts.performanceTime) reduces to the plain sum: 39.98 + 0.020 → 40.0", () => {
    const p = samplePair(
      { currentTime: 40 }, 5000,
      () => ({ performanceTime: 5000, contextTime: 39.98 }),
      { baseLatencySeconds: 0.005, outputLatencySeconds: 0.015 },
    );
    expect(p.source).toBe("getOutputTimestamp");
    expect(p.contextTimeSeconds).toBeCloseTo(40.0, 9);
    expect(p.performanceTimeMs).toBe(5000);
  });
});

// One reference instant governs every test in this describe (review round 1 — rebuilt vectors;
// round 2 — BOTH latency components, independently variable):
//   baseLatency = 5 ms (graph→host), outputLatency = 15 ms (host→device) → total 20 ms.
//   At wall/perf 5000 ms the SCHEDULED head is ctx 40.000 s, so getOutputTimestamp reports
//   output-stream ctx 39.980 s at performanceTime 5000.
//   Invariant: outputCtx + base + out = scheduled (39.980 + 0.005 + 0.015 = 40.000).
const LAT = { baseLatencySeconds: 0.005, outputLatencySeconds: 0.015 };
const READING = { performanceTime: 5000, contextTime: 39.98 };

describe("A1 contract (D21): getOutputTimestamp pairs convert output-stream → scheduled exactly once", () => {
  it("adds BOTH latency components: 39.98 + 0.005 + 0.015 → 40.00", () => {
    const p = samplePair({ currentTime: 40 }, 5000, () => READING, LAT);
    expect(p.source).toBe("getOutputTimestamp");
    expect(p.contextTimeSeconds).toBeCloseTo(40.0, 9);
    expect(p.performanceTimeMs).toBe(5000);
  });
  it("baseLatency and outputLatency are INDEPENDENTLY varied (review round 2 — not one combined value)", () => {
    // same output reading, different splits of the same total → identical conversion
    const a = samplePair({ currentTime: 40 }, 5000, () => READING, { baseLatencySeconds: 0, outputLatencySeconds: 0.02 });
    const b = samplePair({ currentTime: 40 }, 5000, () => READING, { baseLatencySeconds: 0.02, outputLatencySeconds: 0 });
    expect(a.contextTimeSeconds).toBeCloseTo(40.0, 9);
    expect(b.contextTimeSeconds).toBeCloseTo(40.0, 9);
    // different TOTALS differ by exactly the total
    const c = samplePair({ currentTime: 40 }, 5000, () => READING, { baseLatencySeconds: 0.01, outputLatencySeconds: 0.01 });
    expect(c.contextTimeSeconds).toBeCloseTo(39.98 + 0.02, 9);
    expect(b.contextTimeSeconds! - c.contextTimeSeconds!).toBeCloseTo(0, 9); // both totals 0.02
    const d = samplePair({ currentTime: 40 }, 5000, () => READING, { baseLatencySeconds: 0.005, outputLatencySeconds: 0.015 });
    expect(d.contextTimeSeconds! - c.contextTimeSeconds!).toBeCloseTo(0, 9); // 0.020 = 0.020
  });
  it("either component missing/invalid → honest fallback (cannot convert partially)", () => {
    expect(samplePair({ currentTime: 40 }, 5000, () => READING, { outputLatencySeconds: 0.02 }).source).toBe("fallback"); // base unknown
    expect(samplePair({ currentTime: 40 }, 5000, () => READING, { baseLatencySeconds: 0.005 }).source).toBe("fallback"); // out unknown
    expect(samplePair({ currentTime: 40 }, 5000, () => READING, { baseLatencySeconds: NaN, outputLatencySeconds: 0.02 }).source).toBe("fallback");
    expect(samplePair({ currentTime: 40 }, 5000, () => READING, { baseLatencySeconds: 0.005, outputLatencySeconds: -1 }).source).toBe("fallback");
    expect(samplePair({ currentTime: 40 }, 5000, () => READING, undefined).source).toBe("fallback");
    const fb = samplePair({ currentTime: 40 }, 5000, () => READING, undefined);
    expect(fb.contextTimeSeconds).toBe(40); // plain ctx.currentTime mapping
  });
  it("zero/zero keeps the reading (no shift), still labeled getOutputTimestamp", () => {
    const p = samplePair({ currentTime: 40 }, 5000, () => ({ performanceTime: 5000, contextTime: 40 }), { baseLatencySeconds: 0, outputLatencySeconds: 0 });
    expect(p.source).toBe("getOutputTimestamp");
    expect(p.contextTimeSeconds).toBe(40);
  });
  it("runtime residual guard: inconsistent reading+latency rejects to fallback (round 3)", () => {
    // reading claims 39.9 but latencies claim 20 ms → predicted 39.92 vs currentTime 40 → 80 ms residual
    const p = samplePair({ currentTime: 40 }, 5000, () => ({ performanceTime: 5000, contextTime: 39.9 }), { baseLatencySeconds: 0.005, outputLatencySeconds: 0.015 });
    expect(p.source).toBe("fallback");
    expect(p.contextTimeSeconds).toBe(40); // honest ctx.currentTime mapping
  });
  it("ClockPairKeeper.invalidate() forces re-sample within maxAge (round 5 P0-1)", () => {
    let ctxTime = 10;
    const keeper = new ClockPairKeeper({ get currentTime() { return ctxTime; } }, { maxAgeMs: 1000 });
    const a = keeper.get(0);
    const b = keeper.get(100); // within maxAge → cached (same object)
    expect(b).toBe(a);
    keeper.invalidate();
    ctxTime = 10.05; // lifecycle transition (resume) moved the audio clock
    const c = keeper.get(150);
    expect(c).not.toBe(a);        // re-sampled despite age < maxAge
    expect(c.contextTimeSeconds).toBe(10.05);
  });
  it("latency is applied by the pair sampler ONLY — inputChartTimeMs adds nothing extra", () => {
    const pair = samplePair({ currentTime: 40 }, 5000, () => READING, LAT);
    // same instant as sourceStart → 0 ms; 100 ms later → 100 ms (no extra latency term)
    expect(
      inputChartTimeMs(5000, pair, { sourceStartCtxTime: 40, audioSourceOffsetMs: 0, audioOffsetMs: 0 }),
    ).toBeCloseTo(0, 6);
    expect(
      inputChartTimeMs(5100, pair, { sourceStartCtxTime: 40, audioSourceOffsetMs: 0, audioOffsetMs: 0 }),
    ).toBeCloseTo(100, 6);
  });
});
