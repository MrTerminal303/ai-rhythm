// apps/web/src/engine/audio-clock.ts
import type { GameClock } from "./clock.js";
import { chartTime, inputChartTimeMs, type ClockPair } from "./time-math.js";

export interface AudioClockSource {
  buffer: unknown;
  start(when: number, offsetSeconds?: number): void;
  stop(when?: number): void;
}
export interface AudioClockCtx {
  currentTime: number;
  createBufferSource(): AudioClockSource;
}

export class AudioClock implements GameClock {
  private audioOffsetMs = 0;
  private audioSourceOffsetMs = 0;
  private sourceStartCtxTime = 0;
  private source: AudioClockSource | null = null;
  private state: "idle" | "running" | "paused" | "stopped" = "idle";
  private pausedChartMs = 0;
  private pausedPosMs = 0;
  private pendingBuffer: unknown = null;

  constructor(
    private readonly ctx: AudioClockCtx,
    private readonly pairKeeper: { get(nowMs: number): ClockPair },
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  load(buffer: unknown, audioOffsetMs: number): void {
    this.audioOffsetMs = audioOffsetMs;
    this.pendingBuffer = buffer;
  }

  start(atChartMs = 0): void {
    if (this.pendingBuffer === null) throw new Error("load() before start()");
    this.source?.stop();
    const raw = Math.max(0, atChartMs - this.audioOffsetMs); // chart → buffer: subtract offset ONCE
    this.audioSourceOffsetMs = raw;
    this.sourceStartCtxTime = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.pendingBuffer;
    src.start(this.sourceStartCtxTime, raw / 1000);
    this.source = src;
    this.state = "running";
  }

  pause(): void {
    if (this.state !== "running") return;
    this.pausedChartMs = this.chartTimeMs();
    this.pausedPosMs = this.playbackPositionMs();
    this.source?.stop();
    this.source = null;
    this.state = "paused";
  }

  chartTimeMs(): number {
    if (this.state === "running") {
      return chartTime({
        audioSourceOffsetMs: this.audioSourceOffsetMs,
        ctxCurrentTime: this.ctx.currentTime,
        sourceStartCtxTime: this.sourceStartCtxTime,
        audioOffsetMs: this.audioOffsetMs,
      });
    }
    if (this.state === "paused") return this.pausedChartMs; // frozen — never throws
    throw new Error("clock not started"); // idle | stopped
  }

  playbackPositionMs(): number {
    if (this.state === "running") {
      return this.audioSourceOffsetMs + (this.ctx.currentTime - this.sourceStartCtxTime) * 1000;
    }
    if (this.state === "paused") return this.pausedPosMs;
    throw new Error("clock not started");
  }

  chartTimeAt(timeStampMs: number, pair?: ClockPair): number {
    if (this.state !== "running") throw new Error("clock not started");
    // W3 T2 (D21 real-input probe): the caller may pass the EXACT pair it mapped through
    // (one keeper.get shared by conversion and the e2e recorder); omitted → keeper (backward compatible).
    const p = pair ?? this.pairKeeper.get(this.nowMs());
    return inputChartTimeMs(timeStampMs, p, {
      sourceStartCtxTime: this.sourceStartCtxTime,
      audioSourceOffsetMs: this.audioSourceOffsetMs,
      audioOffsetMs: this.audioOffsetMs,
    });
  }

  stop(): void {
    this.source?.stop();
    this.source = null;
    this.state = "stopped"; // teardown only — pause() is the mid-playback path
  }
}
