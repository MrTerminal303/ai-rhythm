// apps/web/src/engine/server-time.test.ts
import { describe, expect, it } from "vitest";
import {
  selectClockAnchor, serverNowMs, serverClockOffsetMs, startCtxTimeSeconds,
  computeResyncTarget, DriftGuard, type PingSample,
} from "./server-time.js";

describe("selectClockAnchor", () => {
  const samples: PingSample[] = [10, 20, 30, 40, 50, 60, 70, 80].map((rtt, i) => {
    const t0 = 10_000 + i * 1000;
    return { t0, t3: t0 + rtt, serverTimeMs: t0 + rtt / 2 + 1000 }; // constant epoch offset 1000
  });

  it("median offset of low-jitter half → projection identity holds", () => {
    const a = selectClockAnchor(samples);
    expect(serverClockOffsetMs(a)).toBeCloseTo(1000, 6);
    expect(serverNowMs(a, a.clientPerfAtSyncMs + 500)).toBeCloseTo(a.serverEpochAtSyncMs + 500, 6);
  });

  it("one noisy sample (huge RTT) does not move the anchor", () => {
    const noisy: PingSample[] = [...samples, { t0: 99_000, t3: 109_000, serverTimeMs: 104_000 }];
    const a = selectClockAnchor(noisy);
    expect(serverClockOffsetMs(a)).toBeCloseTo(1000, 0); // within 1 ms of true offset
  });

  it("throws on empty", () => expect(() => selectClockAnchor([])).toThrow());
});

describe("startCtxTimeSeconds — §7.1 shared start", () => {
  it("maps a future server start onto the local ctx clock", () => {
    expect(startCtxTimeSeconds(10, 1500, 1000)).toBeCloseTo(10.5, 6);
  });
});

describe("computeResyncTarget — buffer domain", () => {
  it("chart 30050, offset 50 → buffer 30000 (worked example)", () => {
    expect(computeResyncTarget(30_050, 50, 60_000, 60_000)).toEqual({ positionMs: 30_000, pastEnd: false });
  });
  it("clamps below 0 and above audio duration", () => {
    expect(computeResyncTarget(10, 50, 60_000, 60_000).positionMs).toBe(0);
    expect(computeResyncTarget(70_000, 0, 60_000, 60_000).positionMs).toBe(60_000);
  });
  it("past chart end flagged", () => {
    expect(computeResyncTarget(61_000, 0, 60_000, 60_000).pastEnd).toBe(true);
  });
});

describe("DriftGuard — exactly one resync per sustained episode", () => {
  it("100 ms drift → never fires", () => {
    const g = new DriftGuard();
    for (let t = 0; t < 10_000; t += 250) expect(g.observe(100, t)).toBe(false);
  });
  it("400 ms <2 s no; ≥2 s once; no re-fire while over; re-arms below", () => {
    const g = new DriftGuard();
    expect(g.observe(400, 0)).toBe(false);
    expect(g.observe(400, 1999)).toBe(false);
    expect(g.observe(400, 2000)).toBe(true);
    expect(g.observe(400, 2500)).toBe(false);
    expect(g.observe(50, 3000)).toBe(false);
    expect(g.observe(400, 3100)).toBe(false);
    expect(g.observe(400, 5100)).toBe(true);
  });
});
