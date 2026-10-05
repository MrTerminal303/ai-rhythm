import { describe, expect, it } from "vitest";
import { PerformanceClock, type TimeSource } from "./clock.js";

class FakeTime implements TimeSource {
  t = 1000;
  nowMs(): number {
    return this.t;
  }
}

describe("PerformanceClock", () => {
  it("throws before start", () => {
    const clock = new PerformanceClock(new FakeTime());
    expect(() => clock.chartTimeMs()).toThrow(/not started/);
  });

  it("start(0) reports ~0 immediately, then advances with the source", () => {
    const src = new FakeTime();
    const clock = new PerformanceClock(src);
    clock.start(0);
    expect(clock.chartTimeMs()).toBe(0);
    src.t += 250;
    expect(clock.chartTimeMs()).toBe(250);
  });

  it("start(atChartMs) begins at the requested offset", () => {
    const src = new FakeTime();
    const clock = new PerformanceClock(src);
    clock.start(500);
    expect(clock.chartTimeMs()).toBe(500);
    src.t += 100;
    expect(clock.chartTimeMs()).toBe(600);
  });

  it("restart resets the origin", () => {
    const src = new FakeTime();
    const clock = new PerformanceClock(src);
    clock.start(0);
    src.t += 10_000;
    clock.start(0);
    expect(clock.chartTimeMs()).toBe(0);
  });

  it("default source works with real performance.now()", () => {
    const clock = new PerformanceClock();
    clock.start(0);
    expect(clock.chartTimeMs()).toBeGreaterThanOrEqual(0);
    expect(clock.chartTimeMs()).toBeLessThan(1000);
  });
});
