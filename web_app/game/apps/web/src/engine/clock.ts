import { asChartMs, type ChartMs } from "./branded.js";

export interface TimeSource {
  nowMs(): number;
}

export interface GameClock {
  start(atChartMs?: number): void;
  chartTimeMs(): ChartMs;
}

export class PerformanceClock implements GameClock {
  private originWallMs: number | null = null;
  private originChartMs = 0;
  private readonly source: TimeSource;

  constructor(source?: TimeSource) {
    this.source = source ?? { nowMs: () => performance.now() };
  }

  start(atChartMs = 0): void {
    this.originChartMs = atChartMs;
    this.originWallMs = this.source.nowMs();
  }

  chartTimeMs(): ChartMs {
    if (this.originWallMs === null) throw new Error("clock not started");
    return asChartMs(this.originChartMs + (this.source.nowMs() - this.originWallMs));
  }
}
