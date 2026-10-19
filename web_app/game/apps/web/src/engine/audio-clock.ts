// apps/web/src/engine/audio-clock.ts
import type { GameClock } from "./clock.js";
import { chartTime, inputChartTimeMs, type ClockPair } from "./time-math.js";
import { asAudioOffsetMs, asBufferMs, asChartMs, type AudioOffsetMs, type BufferMs, type ChartMs, type PerfMs } from "./branded.js";

export interface AudioClockSource {
  buffer: unknown;
  start(when: number, offsetSeconds?: number): void;
  stop(when?: number): void;
  /** optional: present on real AudioBufferSources; stub contexts in unit tests omit it */
  connect?(destination: AudioNode): void;
}
export interface AudioClockCtx {
  currentTime: number;
  createBufferSource(): AudioClockSource;
}

export class AudioClock implements GameClock {
  private audioOffsetMs: AudioOffsetMs = asAudioOffsetMs(0);
  private audioSourceOffsetMs: BufferMs = asBufferMs(0);
  private sourceStartCtxTime = 0;
  private source: AudioClockSource | null = null;
  private state: "idle" | "running" | "paused" | "stopped" = "idle";
  private pausedChartMs: ChartMs = asChartMs(0);
  private pausedPosMs: BufferMs = asBufferMs(0);
  private pendingBuffer: unknown = null;
  private output: AudioNode | null = null;

  constructor(
    private readonly ctx: AudioClockCtx,
    private readonly pairKeeper: { get(nowMs: number): ClockPair },
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  /**
   * W3 T22 (B5): the node every song source feeds — the master/music gain chain the play
   * page builds at startGame. Set before start(); omitted → the source is left unconnected
   * (unit stubs), which keeps the clock's behaviour otherwise unchanged.
   */
  setOutput(node: AudioNode | null): void {
    this.output = node;
  }

  load(buffer: unknown, audioOffsetMs: AudioOffsetMs): void {
    this.audioOffsetMs = audioOffsetMs;
    this.pendingBuffer = buffer;
  }

  start(atChartMs: number = 0): void {
    if (this.pendingBuffer === null) throw new Error("load() before start()");
    this.source?.stop();
    const raw: BufferMs = asBufferMs(Math.max(0, atChartMs - this.audioOffsetMs)); // chart → buffer: subtract offset ONCE
    this.audioSourceOffsetMs = raw;
    this.sourceStartCtxTime = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.pendingBuffer;
    if (this.output) src.connect?.(this.output); // T22: song → music gain → master gain → destination
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

  chartTimeMs(): ChartMs {
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

  playbackPositionMs(): BufferMs {
    if (this.state === "running") {
      return asBufferMs(this.audioSourceOffsetMs + (this.ctx.currentTime - this.sourceStartCtxTime) * 1000);
    }
    if (this.state === "paused") return this.pausedPosMs;
    throw new Error("clock not started");
  }

  chartTimeAt(timeStampMs: PerfMs, pair?: ClockPair): ChartMs {
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
