// apps/web/src/engine/time-math.ts
// Time-domain invariant (spec §4.2, single source of truth):
//   chartTime = rawBufferPosition + audioOffsetMs
//   rawBufferPosition = chartTime − audioOffsetMs
//   serverSongMs is chart-domain; desiredPlaybackPosition is always buffer-domain.
//   audioOffsetMs is applied EXACTLY ONCE per conversion — never twice.

export interface ChartTimeInput {
  audioSourceOffsetMs: number;
  ctxCurrentTime: number;
  sourceStartCtxTime: number;
  audioOffsetMs: number;
}

export function chartTime(i: ChartTimeInput): number {
  return i.audioSourceOffsetMs + (i.ctxCurrentTime - i.sourceStartCtxTime) * 1000 + i.audioOffsetMs;
}

export type PairSource = "getOutputTimestamp" | "fallback";

export interface ClockPair {
  performanceTimeMs: number;
  contextTimeSeconds: number;
  source: PairSource;
  sampledAt: number;
}

export function audioClockSeconds(timeStampMs: number, pair: ClockPair): number {
  return pair.contextTimeSeconds + (timeStampMs - pair.performanceTimeMs) / 1000;
}

export function inputChartTimeMs(
  timeStampMs: number,
  pair: ClockPair,
  ctx: { sourceStartCtxTime: number; audioSourceOffsetMs: number; audioOffsetMs: number },
): number {
  const ctxSeconds = audioClockSeconds(timeStampMs, pair);
  return ctx.audioSourceOffsetMs + (ctxSeconds - ctx.sourceStartCtxTime) * 1000 + ctx.audioOffsetMs;
}

export function judgeDt(inputChartTimeMsValue: number, deviceCalibrationOffsetMs: number, noteTargetTimeMs: number): number {
  return inputChartTimeMsValue - deviceCalibrationOffsetMs - noteTargetTimeMs;
}
