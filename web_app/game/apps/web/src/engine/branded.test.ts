import { describe, expect, expectTypeOf, it } from "vitest";
import { asAudioOffsetMs, asBufferMs, asCalibMs, asChartMs, asCtxSec, asPerfMs, type ChartMs } from "./branded.js";
import { chartTime, inputChartTimeMs, judgeDt, type ClockPair } from "./time-math.js";

describe("A10 branded timestamps", () => {
  it("constructors are zero-cost casts (no value mutation)", () => {
    expect(asChartMs(1500)).toBe(1500);
    expect(asCtxSec(42)).toBe(42);
    expect(asPerfMs(1)).toBe(1);
    expect(asBufferMs(0)).toBe(0);
    expect(asCalibMs(-50)).toBe(-50);
    expect(asAudioOffsetMs(50)).toBe(50);
  });
  it("chart offset and device calibration are DISTINCT brands (review P0: audioOffsetMs ≠ CalibMs)", () => {
    expectTypeOf(chartTime({
      audioSourceOffsetMs: asBufferMs(0),
      ctxCurrentTime: 30,
      sourceStartCtxTime: 0,
      audioOffsetMs: asAudioOffsetMs(50), // chart.song.audioOffsetMs — NOT CalibMs
    })).toEqualTypeOf<ChartMs>();
    const pair: ClockPair = {
      performanceTimeMs: asPerfMs(1000),
      contextTimeSeconds: asCtxSec(50),
      source: "fallback",
      sampledAt: asPerfMs(1000),
    };
    expectTypeOf(
      inputChartTimeMs(asPerfMs(2500), pair, {
        sourceStartCtxTime: 0,
        audioSourceOffsetMs: asBufferMs(0),
        audioOffsetMs: asAudioOffsetMs(0),
      }),
    ).toEqualTypeOf<ChartMs>();
    expectTypeOf(judgeDt(asChartMs(1050), asCalibMs(50), asChartMs(1000))).toBeNumber(); // CalibMs only here
  });
});
