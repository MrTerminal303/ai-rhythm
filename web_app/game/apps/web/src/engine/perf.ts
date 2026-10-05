// performance.now() here is §2.10 benchmark instrumentation, NOT gameplay timing.
export const RENDER_BUDGET_MS = 16.7;

export class PerfMonitor {
  private frameIntervals: number[] = [];
  private renderDurations: number[] = [];
  private updateDurations: number[] = [];

  recordFrameInterval(ms: number): void { this.frameIntervals.push(ms); }
  recordRenderDuration(ms: number): void { this.renderDurations.push(ms); }
  recordUpdateDuration(ms: number): void { this.updateDurations.push(ms); }
  p95FrameIntervalMs(): number { return p95(this.frameIntervals); }
  p95RenderDurationMs(): number { return p95(this.renderDurations); }
  p95UpdateDurationMs(): number { return p95(this.updateDurations); }
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