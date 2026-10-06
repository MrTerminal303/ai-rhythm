// apps/web/src/engine/clock-pair.test.ts
import { describe, expect, it } from "vitest";
import { samplePair, ClockPairKeeper } from "./clock-pair.js";

describe("samplePair", () => {
  it("prefers getOutputTimestamp mapping and labels the source", () => {
    const p = samplePair({ currentTime: 40 }, 5000, () => ({ performanceTime: 4990, contextTime: 39.9 }));
    expect(p).toEqual({ performanceTimeMs: 4990, contextTimeSeconds: 39.9, source: "getOutputTimestamp", sampledAt: 5000 });
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
