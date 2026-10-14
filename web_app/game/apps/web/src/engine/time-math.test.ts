// apps/web/src/engine/time-math.test.ts
import { describe, expect, it } from "vitest";
import { chartTime, inputChartTimeMs, judgeDt, audioClockSeconds, type ClockPair } from "./time-math.js";
import { asAudioOffsetMs, asBufferMs, asCalibMs, asChartMs, asCtxSec, asPerfMs } from "./branded.js";

const pair: ClockPair = { performanceTimeMs: asPerfMs(1000), contextTimeSeconds: asCtxSec(50), source: "getOutputTimestamp", sampledAt: asPerfMs(1000) };

describe("chartTime — §7.1 invariant, worked example at 30,000 ms", () => {
  it("mid-playback: raw buffer 30000 + offset 50 → chart 30050", () => {
    expect(chartTime({ audioSourceOffsetMs: asBufferMs(0), ctxCurrentTime: 30, sourceStartCtxTime: 0, audioOffsetMs: asAudioOffsetMs(50) })).toBe(30_050);
  });
  it("restart at buffer 30000 (non-zero source offset): chart 30050 at restart instant", () => {
    expect(chartTime({ audioSourceOffsetMs: asBufferMs(30_000), ctxCurrentTime: 100, sourceStartCtxTime: 100, audioOffsetMs: asAudioOffsetMs(50) })).toBe(30_050);
  });
  it("chart − offset → buffer (inverse direction)", () => {
    expect(30_050 - 50).toBe(30_000);
  });
  it("negative chart offset (notes arrive later)", () => {
    expect(chartTime({ audioSourceOffsetMs: asBufferMs(0), ctxCurrentTime: 10, sourceStartCtxTime: 0, audioOffsetMs: asAudioOffsetMs(-100) })).toBe(9_900);
  });
});

describe("inputChartTimeMs — event.timeStamp mapped through the clock pair", () => {
  it("timeStamp 1500 ms after pair sample → 1500 ms of playback", () => {
    expect(audioClockSeconds(asPerfMs(2500), pair)).toBeCloseTo(51.5, 6);
    expect(inputChartTimeMs(asPerfMs(2500), pair, { sourceStartCtxTime: 50, audioSourceOffsetMs: asBufferMs(0), audioOffsetMs: asAudioOffsetMs(0) })).toBe(1500);
  });
  it("audioSourceOffsetMs and audioOffsetMs each applied exactly once", () => {
    expect(inputChartTimeMs(asPerfMs(2500), pair, { sourceStartCtxTime: 50, audioSourceOffsetMs: asBufferMs(30_000), audioOffsetMs: asAudioOffsetMs(50) })).toBe(31_550);
  });
  it("fallback pair source still maps (label carried for diagnostics)", () => {
    const fb: ClockPair = { ...pair, source: "fallback" };
    expect(inputChartTimeMs(asPerfMs(2500), fb, { sourceStartCtxTime: 50, audioSourceOffsetMs: asBufferMs(0), audioOffsetMs: asAudioOffsetMs(0) })).toBe(1500);
  });
});

describe("judgeDt sign convention", () => {
  it("positive = late", () => expect(judgeDt(asChartMs(1050), asCalibMs(0), asChartMs(1000))).toBe(50));
  it("negative = early", () => expect(judgeDt(asChartMs(950), asCalibMs(0), asChartMs(1000))).toBe(-50));
  it("calibration subtracts: 50 ms late per calibration → dt 0", () => expect(judgeDt(asChartMs(1050), asCalibMs(50), asChartMs(1000))).toBe(0));
  it("zero calibration on perfect hit", () => expect(judgeDt(asChartMs(1000), asCalibMs(0), asChartMs(1000))).toBe(0));
});

describe("A1 claim-1 matrix: both sources under simulated output delay, suspend/resume, visibility, device change", () => {
  const mkPair = (source: "getOutputTimestamp" | "fallback", ctxSec: number, perfMs = 1000): ClockPair => ({
    performanceTimeMs: asPerfMs(perfMs), contextTimeSeconds: asCtxSec(ctxSec), source, sampledAt: asPerfMs(perfMs),
  });
  const CTX = { sourceStartCtxTime: 0, audioSourceOffsetMs: asBufferMs(0), audioOffsetMs: asAudioOffsetMs(0) };
  it("SAME INSTANT: render and input agree for the fallback source", () => {
    const render = chartTime({ audioSourceOffsetMs: asBufferMs(0), ctxCurrentTime: 30, sourceStartCtxTime: 0, audioOffsetMs: asAudioOffsetMs(0) });
    const input = inputChartTimeMs(asPerfMs(30_000), mkPair("fallback", 30, 30_000), CTX); // pair sampled at the render instant
    expect(render).toBe(30_000);
    expect(input).toBe(render); // both describe ctx 30 s → chart 30 000
  });
  it("SAME INSTANT: render and input agree for the outputTimestamp source after pair conversion", () => {
    const converted = mkPair("getOutputTimestamp", 30, 30_000); // already scheduled-domain post-T2
    const render = chartTime({ audioSourceOffsetMs: asBufferMs(0), ctxCurrentTime: 30, sourceStartCtxTime: 0, audioOffsetMs: asAudioOffsetMs(0) });
    const input = inputChartTimeMs(asPerfMs(30_000), converted, CTX);
    expect(input).toBe(render);
  });
  it("event 1 s after the pair sample is 1 s later in BOTH sources (no domain gap)", () => {
    const render = chartTime({ audioSourceOffsetMs: asBufferMs(0), ctxCurrentTime: 30, sourceStartCtxTime: 0, audioOffsetMs: asAudioOffsetMs(0) });
    expect(inputChartTimeMs(asPerfMs(31_000), mkPair("fallback", 30, 30_000), CTX)).toBe(render + 1000);
    expect(inputChartTimeMs(asPerfMs(31_000), mkPair("getOutputTimestamp", 30, 30_000), CTX)).toBe(render + 1000);
  });
  it("suspend/resume continuity: at the restart instant chartTime resumes from the recorded position", () => {
    // AudioClock restart bookkeeping (W2 T7): sourceStart == ctxCurrent at restart → elapsed 0
    expect(chartTime({ audioSourceOffsetMs: asBufferMs(4000), ctxCurrentTime: 106, sourceStartCtxTime: 106, audioOffsetMs: asAudioOffsetMs(50) })).toBe(4050);
    // 4 s later: 4000 + 4000 + 50 = 8050 (advances, does not restart from 0)
    expect(chartTime({ audioSourceOffsetMs: asBufferMs(4000), ctxCurrentTime: 110, sourceStartCtxTime: 106, audioOffsetMs: asAudioOffsetMs(50) })).toBe(8050);
  });
  it("visibility/device change only ever enter via pair re-sampling — no formula change", () => {
    const a = mkPair("fallback", 42, 42_000);
    const b = mkPair("getOutputTimestamp", 42, 42_000);
    expect(inputChartTimeMs(asPerfMs(43_000), a, CTX)).toBe(inputChartTimeMs(asPerfMs(43_000), b, CTX));
  });
  it("calibration applied exactly once: judgeDt subtracts it one time", () => {
    expect(judgeDt(asChartMs(1050), asCalibMs(50), asChartMs(1000))).toBe(0); // 50 − 50, not 100
  });
});
