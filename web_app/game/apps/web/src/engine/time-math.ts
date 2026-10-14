// apps/web/src/engine/time-math.ts
// Time-domain invariant (spec §4.2, single source of truth):
//   chartTime = rawBufferPosition + audioOffsetMs
//   rawBufferPosition = chartTime − audioOffsetMs
//   serverSongMs is chart-domain; desiredPlaybackPosition is always buffer-domain.
//   audioOffsetMs is applied EXACTLY ONCE per conversion — never twice.
//
// W3 timing contract (D21, spec §3 A1 — amended per review round 2) — C4 reaffirmed:
// AudioContext time remains authoritative for song/note progression. CHART TIME LIVES IN
// THE SCHEDULED-AUDIO domain (the timeline of AudioContext.currentTime — frames as
// submitted to the graph). Strategy rationale + visual/acoustic semantics: see D21 in
// DECISIONS.md — rendering is NOT output-compensated; visual leads acoustic by ≈
// baseLatency + outputLatency, accepted as a presentation limitation absorbed only by
// deviceCalibrationOffsetMs; acoustic synchronization is NOT claimed in W3 (A5 claim 3 → W11).
//
// Conversion table (each conversion applies its terms EXACTLY ONCE):
//   DOM event.timeStamp (perf ms)
//     → audioClockSeconds(): clock pair maps perf → ctx seconds. Pairs sampled from
//       getOutputTimestamp() carry OUTPUT-STREAM contextTime anchored at ts.performanceTime;
//       clock-pair.ts converts AT SAMPLE TIME perfNowMs:
//       ctxSec = t.contextTime + (perfNowMs − t.performanceTime)/1000 + baseLatencySeconds + outputLatencySeconds
//       (elapsed term always included; result anchored at perfNowMs).
//       Missing/invalid either latency component → honest fallback pair (no partial conversion).
//       Residual guard: |ctx.currentTime − predicted| > D21_RESIDUAL_S (25 ms) → fallback.
//       Fallback pairs map (perfNow, ctx.currentTime) with no latency term.
//     → chartTime: chartMs = audioSourceOffsetMs + (ctxSec − sourceStartCtxTime) × 1000 + audioOffsetMs
//   ctx.currentTime (render): same chartTime formula — RENDER ADDS NO LATENCY TERM.
//   deviceCalibrationOffsetMs: applied exactly once, in judgeDt (input path only;
//     auto-miss expiry stays on raw render chartTime). It is the ONLY runtime compensation.
//   baseLatency + outputLatency: used ONLY to convert getOutputTimestamp pairs in
//     clock-pair.ts. NOT a calibration fallback (fallback = 0; D21 supersedes PLAN §7.4's
//     outputLatency×1000 first-run guess — spec §3 A2) and never added anywhere else.
//   Real-browser validity of the conversion is measured by e2e/w3-clock-invariant.spec.ts
//     (same-tick |currentTime − (ts.contextTime + base + out)| ≤ 25 ms), not assumed.
//
// W3 A10 (D22): the domain names above live in the types — ChartMs/BufferMs/CtxSec/PerfMs/
// CalibMs/AudioOffsetMs (engine/branded.ts). Types erase at runtime; the as* constructors
// are the only sanctioned casts (DOM boundaries cast once).

import { asChartMs, asCtxSec, type AudioOffsetMs, type BufferMs, type CalibMs, type ChartMs, type CtxSec, type PerfMs } from "./branded.js";

export interface ChartTimeInput {
  audioSourceOffsetMs: BufferMs;
  ctxCurrentTime: number;
  sourceStartCtxTime: number;
  audioOffsetMs: AudioOffsetMs;
}

export function chartTime(i: ChartTimeInput): ChartMs {
  return asChartMs(i.audioSourceOffsetMs + (i.ctxCurrentTime - i.sourceStartCtxTime) * 1000 + i.audioOffsetMs);
}

export type PairSource = "getOutputTimestamp" | "fallback";

export interface ClockPair {
  performanceTimeMs: PerfMs;
  contextTimeSeconds: CtxSec;
  source: PairSource;
  sampledAt: PerfMs;
}

export function audioClockSeconds(timeStampMs: PerfMs, pair: ClockPair): CtxSec {
  return asCtxSec(pair.contextTimeSeconds + (timeStampMs - pair.performanceTimeMs) / 1000);
}

export function inputChartTimeMs(
  timeStampMs: PerfMs,
  pair: ClockPair,
  ctx: { sourceStartCtxTime: number; audioSourceOffsetMs: BufferMs; audioOffsetMs: AudioOffsetMs },
): ChartMs {
  const ctxSeconds = audioClockSeconds(timeStampMs, pair);
  return asChartMs(ctx.audioSourceOffsetMs + (ctxSeconds - ctx.sourceStartCtxTime) * 1000 + ctx.audioOffsetMs);
}

export function judgeDt(inputChartTimeMsValue: ChartMs, deviceCalibrationOffsetMs: CalibMs, noteTargetTimeMs: ChartMs): number {
  return inputChartTimeMsValue - deviceCalibrationOffsetMs - noteTargetTimeMs;
}
