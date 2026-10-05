import { describe, expect, it } from "vitest";
import { PerfMonitor, p95, RENDER_BUDGET_MS } from "./perf.js";

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
  it("tracks all three metrics separately; gate constant matches spec", () => {
    const m = new PerfMonitor();
    for (let i = 0; i < 20; i++) m.recordFrameInterval(16 + (i % 2));
    for (let i = 0; i < 100; i++) m.recordRenderDuration(i < 95 ? 5 : 30);
    for (let i = 0; i < 50; i++) m.recordUpdateDuration(2);
    expect(m.sampleCounts()).toEqual({ frames: 20, renders: 100, updates: 50 });
    // 95 fives (idx 0..94) + 5 thirties (idx 95..99) → sorted[94] = 5
    expect(m.p95RenderDurationMs()).toBe(5);
    expect(m.p95UpdateDurationMs()).toBe(2);
    expect(RENDER_BUDGET_MS).toBe(16.7);
  });
});