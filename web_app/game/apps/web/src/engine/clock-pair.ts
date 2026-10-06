// apps/web/src/engine/clock-pair.ts
import type { ClockPair, PairSource } from "./time-math.js";

export function samplePair(
  ctx: { currentTime: number },
  perfNowMs: number,
  readOutputTimestamp?: () => { performanceTime: number; contextTime: number } | null,
): ClockPair {
  const t = readOutputTimestamp?.();
  if (t && Number.isFinite(t.performanceTime) && Number.isFinite(t.contextTime)) {
    return { performanceTimeMs: t.performanceTime, contextTimeSeconds: t.contextTime, source: "getOutputTimestamp", sampledAt: perfNowMs };
  }
  // fallback: labels honestly — NOT output-device-truthful (spec §4.1)
  return { performanceTimeMs: perfNowMs, contextTimeSeconds: ctx.currentTime, source: "fallback", sampledAt: perfNowMs };
}

export class ClockPairKeeper {
  private cached: ClockPair | null = null;
  constructor(
    private readonly ctx: { currentTime: number },
    private readonly opts?: {
      readOutputTimestamp?: () => { performanceTime: number; contextTime: number } | null;
      maxAgeMs?: number;
    },
  ) {}
  get(nowMs: number): ClockPair {
    const maxAge = this.opts?.maxAgeMs ?? 1000;
    if (this.cached === null || nowMs - this.cached.sampledAt >= maxAge) {
      this.cached = samplePair(this.ctx, nowMs, this.opts?.readOutputTimestamp);
    }
    return this.cached;
  }
}
