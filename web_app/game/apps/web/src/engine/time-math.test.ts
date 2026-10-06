// apps/web/src/engine/time-math.test.ts
import { describe, expect, it } from "vitest";
import { chartTime, inputChartTimeMs, judgeDt, audioClockSeconds, type ClockPair } from "./time-math.js";

const pair: ClockPair = { performanceTimeMs: 1000, contextTimeSeconds: 50, source: "getOutputTimestamp", sampledAt: 1000 };

describe("chartTime — §7.1 invariant, worked example at 30,000 ms", () => {
  it("mid-playback: raw buffer 30000 + offset 50 → chart 30050", () => {
    expect(chartTime({ audioSourceOffsetMs: 0, ctxCurrentTime: 30, sourceStartCtxTime: 0, audioOffsetMs: 50 })).toBe(30_050);
  });
  it("restart at buffer 30000 (non-zero source offset): chart 30050 at restart instant", () => {
    expect(chartTime({ audioSourceOffsetMs: 30_000, ctxCurrentTime: 100, sourceStartCtxTime: 100, audioOffsetMs: 50 })).toBe(30_050);
  });
  it("chart − offset → buffer (inverse direction)", () => {
    expect(30_050 - 50).toBe(30_000);
  });
  it("negative chart offset (notes arrive later)", () => {
    expect(chartTime({ audioSourceOffsetMs: 0, ctxCurrentTime: 10, sourceStartCtxTime: 0, audioOffsetMs: -100 })).toBe(9_900);
  });
});

describe("inputChartTimeMs — event.timeStamp mapped through the clock pair", () => {
  it("timeStamp 1500 ms after pair sample → 1500 ms of playback", () => {
    expect(audioClockSeconds(2500, pair)).toBeCloseTo(51.5, 6);
    expect(inputChartTimeMs(2500, pair, { sourceStartCtxTime: 50, audioSourceOffsetMs: 0, audioOffsetMs: 0 })).toBe(1500);
  });
  it("audioSourceOffsetMs and audioOffsetMs each applied exactly once", () => {
    expect(inputChartTimeMs(2500, pair, { sourceStartCtxTime: 50, audioSourceOffsetMs: 30_000, audioOffsetMs: 50 })).toBe(31_550);
  });
  it("fallback pair source still maps (label carried for diagnostics)", () => {
    const fb: ClockPair = { ...pair, source: "fallback" };
    expect(inputChartTimeMs(2500, fb, { sourceStartCtxTime: 50, audioSourceOffsetMs: 0, audioOffsetMs: 0 })).toBe(1500);
  });
});

describe("judgeDt sign convention", () => {
  it("positive = late", () => expect(judgeDt(1050, 0, 1000)).toBe(50));
  it("negative = early", () => expect(judgeDt(950, 0, 1000)).toBe(-50));
  it("calibration subtracts: 50 ms late per calibration → dt 0", () => expect(judgeDt(1050, 50, 1000)).toBe(0));
  it("zero calibration on perfect hit", () => expect(judgeDt(1000, 0, 1000)).toBe(0));
});
