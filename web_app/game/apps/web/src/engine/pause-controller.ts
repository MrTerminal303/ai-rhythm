export class SoloPauseController {
  private recorded: number | null = null;
  pause(currentChartMs: number): number {
    if (this.recorded === null) this.recorded = currentChartMs;
    return this.recorded;
  }
  get pausedAtMs(): number | null {
    return this.recorded;
  }
  clear(): void {
    this.recorded = null;
  }
}
