// performance.now() here is §2.10 benchmark instrumentation, NOT gameplay timing.
export const RENDER_BUDGET_MS = 16.7;

export class PerfMonitor {
  private frameIntervals: number[] = [];
  private renderDurations: number[] = [];
  private updateDurations: number[] = [];
  private inputLatencies: number[] = []; // A13: dispatch → handler completion (ms), accepted lane keys only

  recordFrameInterval(ms: number): void { this.frameIntervals.push(ms); }
  recordRenderDuration(ms: number): void { this.renderDurations.push(ms); }
  recordUpdateDuration(ms: number): void { this.updateDurations.push(ms); }
  recordInputLatency(ms: number): void { this.inputLatencies.push(ms); }
  p95FrameIntervalMs(): number { return p95(this.frameIntervals); }
  p99FrameIntervalMs(): number { return p99(this.frameIntervals); }
  p95RenderDurationMs(): number { return p95(this.renderDurations); }
  p95UpdateDurationMs(): number { return p95(this.updateDurations); }
  p95InputLatencyMs(): number { return p95(this.inputLatencies); }
  inputLatencyCount(): number { return this.inputLatencies.length; }
  frameIntervalsOver(budgetMs: number) {
    const over = this.frameIntervals.filter((v) => v > budgetMs);
    return { over16_7Count: over.length, over16_7Share: this.frameIntervals.length ? over.length / this.frameIntervals.length : 0, maxFrameIntervalMs: this.frameIntervals.length ? Math.max(...this.frameIntervals) : 0 };
  }
  sampleCounts() {
    return {
      frames: this.frameIntervals.length,
      renders: this.renderDurations.length,
      updates: this.updateDurations.length,
    };
  }
}

export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(idx, 0)]!;
}

export function p99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
  return sorted[Math.max(idx, 0)]!;
}