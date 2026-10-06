// Best-effort detection (spec §4.7): sinkchange has limited availability; outputLatency is an estimate.
// Tests are the spec (brief Step 1): fire once per shift >5 ms vs the stable baseline, no repeat
// while still shifted, re-arm only when a reading lands within 5 ms of baseline again.
export class DeviceChangeDetector {
  private baseline: number | null = null;
  private fired = false;
  private dirty = false;
  constructor(private readonly readLatency: () => number | undefined) {}
  markDirty(): void { this.dirty = true; } // called from sinkchange listener when supported
  observe(): boolean {
    const v = this.readLatency();
    if (v === undefined || !Number.isFinite(v)) return false;
    if (this.baseline === null) { this.baseline = v; return false; }
    if (this.dirty) { this.dirty = false; this.fired = true; return true; }
    const diff = Math.abs(v - this.baseline);
    if (diff > 0.005) {
      if (this.fired) return false; // still shifted — no repeat until re-armed
      this.fired = true;
      return true;
    }
    this.fired = false; // back near baseline → re-arm
    this.baseline = v;
    return false;
  }
}
