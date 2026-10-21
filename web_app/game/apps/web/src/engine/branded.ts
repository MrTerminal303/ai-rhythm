// apps/web/src/engine/branded.ts — A10 (spec §3 A10, arch §30): units/domains in the type.
// Types erase at runtime; constructors are the only sanctioned casts (D22).
declare const __brand: unique symbol;
type Brand<K extends string> = { readonly [__brand]: K };

export type ChartMs = number & Brand<"ChartMs">; // chart domain (audioOffset applied)
export type BufferMs = number & Brand<"BufferMs">; // raw AudioBuffer position
export type CtxSec = number & Brand<"CtxSec">; // AudioContext seconds, scheduled domain (D21)
export type PerfMs = number & Brand<"PerfMs">; // performance.now() / event.timeStamp
export type CalibMs = number & Brand<"CalibMs">; // deviceCalibrationOffsetMs (judgeDt only)
export type AudioOffsetMs = number & Brand<"AudioOffsetMs">; // chart.song.audioOffsetMs (chart offset — NOT CalibMs)

export const asChartMs = (n: number): ChartMs => n as ChartMs;
export const asBufferMs = (n: number): BufferMs => n as BufferMs;
export const asCtxSec = (n: number): CtxSec => n as CtxSec;
export const asPerfMs = (n: number): PerfMs => n as PerfMs;
export const asCalibMs = (n: number): CalibMs => n as CalibMs;
export const asAudioOffsetMs = (n: number): AudioOffsetMs => n as AudioOffsetMs;
