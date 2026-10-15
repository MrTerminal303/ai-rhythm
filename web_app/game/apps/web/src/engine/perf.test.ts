// apps/web/src/engine/perf.test.ts
import { describe, expect, it } from "vitest";
import { PerfMonitor } from "./perf.js";

describe("PerfMonitor", () => {
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
