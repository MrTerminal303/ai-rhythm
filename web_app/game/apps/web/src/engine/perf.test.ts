// apps/web/src/engine/perf.test.ts
import { describe, expect, it } from "vitest";
import { PerfMonitor, p95, quantizeMs, RENDER_BUDGET_MS } from "./perf.js";

// The percentile helper's own contract (restored in the Track A fix wave — the T16 rewrite of this
// file dropped it along with the gate-constant assertion; both are re-asserted here).
describe("p95", () => {
  it("empty → 0; single → itself", () => {
    expect(p95([])).toBe(0);
    expect(p95([5])).toBe(5);
  });
  it("100 samples 1..100 → 95", () => {
    const vals = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(vals)).toBe(95); // sorted[ceil(100*0.95)-1] = sorted[94] = 95
  });
});

describe("PerfMonitor", () => {
  it("the render budget constant matches the spec", () => {
    expect(RENDER_BUDGET_MS).toBe(16.7);
  });
  it("A13: records input latency, exposes p95 + count", () => {
    const p = new PerfMonitor();
    for (const ms of [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) p.recordInputLatency(ms);
    expect(p.inputLatencyCount()).toBe(10);
    expect(p.p95InputLatencyMs()).toBe(100); // ceil(10×0.95) index — matches p95() helper semantics
  });
  it("A13: empty series → 0 (no NaN in the report)", () => {
    expect(new PerfMonitor().p95InputLatencyMs()).toBe(0);
  });
  it("A13: p99FrameIntervalMs + frameIntervalsOver report shape (T16)", () => {
    const p = new PerfMonitor();
    for (const ms of [8, 9, 10, 10, 20, 25, 30, 35, 40, 50]) p.recordFrameInterval(ms);
    expect(p.p99FrameIntervalMs()).toBe(50);
    expect(p.frameIntervalsOver(16.7)).toEqual({
      over16_7Count: 6,
      over16_7Share: 0.6,
      maxFrameIntervalMs: 50,
    });
    expect(new PerfMonitor().frameIntervalsOver(16.7)).toEqual({
      over16_7Count: 0,
      over16_7Share: 0,
      maxFrameIntervalMs: 0,
    });
  });
});

// A6 fix round 1: DOMHighResTimeStamp resolves to ~0.1 ms, so a sub-0.1 ms excess over the budget is
// the clock's own readback noise, not frame cost. Both directions are pinned here — rounding must
// report the real artifact as 16.7 AND must not hide a genuine 16.8 ms frame.
describe("quantizeMs / A6 clock-quantum reporting", () => {
  const ARTIFACT = 16.700000000004366; // the value the certification run actually measured
  it("quantizes to the 0.1 ms clock step", () => {
    expect(quantizeMs(ARTIFACT)).toBe(16.7);
    expect(quantizeMs(16.8)).toBe(16.8);
    expect(quantizeMs(0)).toBe(0);
  });
  it("artifact case passes the gate", () => {
    expect(p95([ARTIFACT])).toBe(16.7);
    expect(p95([ARTIFACT]) <= RENDER_BUDGET_MS).toBe(true);
  });
  it("a real overrun still fails the gate", () => {
    expect(p95([16.8])).toBe(16.8);
    expect(p95([16.8]) <= RENDER_BUDGET_MS).toBe(false);
  });
  it("frameIntervalsOver ignores quantum noise but counts a real overrun", () => {
    const clean = new PerfMonitor();
    for (let i = 0; i < 100; i++) clean.recordFrameInterval(ARTIFACT);
    expect(clean.frameIntervalsOver(16.7)).toEqual({
      over16_7Count: 0,
      over16_7Share: 0,
      maxFrameIntervalMs: 16.7,
    });
    const mixed = new PerfMonitor();
    for (const ms of [16.7, 16.8]) mixed.recordFrameInterval(ms);
    expect(mixed.frameIntervalsOver(16.7).over16_7Count).toBe(1);
  });
});
