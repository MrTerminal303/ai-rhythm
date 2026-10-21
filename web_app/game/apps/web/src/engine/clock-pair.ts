// apps/web/src/engine/clock-pair.ts
import type { ClockPair, PairSource } from "./time-math.js";
import { asCtxSec, asPerfMs, type CtxSec, type PerfMs } from "./branded.js";

export const D21_RESIDUAL_S = 0.025; // 25 ms = EXPLICIT max permitted CLOCK-MAPPING contribution to judgement error (round 5: NOT a full input-to-render guarantee — event delivery and other contributors are measured separately, e.g. A13): boundary-error risk up to 25 ms ACCEPTED (never claimed away). Fallback does NOT inherit this bound from pair age — see the D21 three-quantity table: correctness rests on the CACHED-PAIR contract (≤1 s cache, keeper.invalidate() across lifecycle transitions) measured on the REAL input path (event.timeStamp mapping error vs independent same-tick reference) with the gated rate-divergence check; final outcome from d21FinalVerdict(). Budget changes = new D21 revision + fresh run.

export function samplePair(
  ctx: { currentTime: number },
  perfNowMs: number,
  readOutputTimestamp?: () => { performanceTime: number; contextTime: number } | null,
  latency?: { baseLatencySeconds?: number; outputLatencySeconds?: number },
  // Round 12 P1-1: optional clock snapshot — when provided, the residual guard and
  // fallback construction use snapshot.currentTime instead of a live ctx.currentTime
  // read, so probePair's diagnostic residual and samplePair's guard decision use
  // exactly the same clock value.
  snapshot?: { currentTime: number },
): ClockPair {
  const ctxNow: CtxSec = asCtxSec(snapshot?.currentTime ?? ctx.currentTime);
  const perfNow: PerfMs = asPerfMs(perfNowMs);
  const t = readOutputTimestamp?.();
  if (t && Number.isFinite(t.performanceTime) && Number.isFinite(t.contextTime)) {
    const base = latency?.baseLatencySeconds;
    const out = latency?.outputLatencySeconds;
    const baseOk = base !== undefined && Number.isFinite(base) && base >= 0;
    const outOk = out !== undefined && Number.isFinite(out) && out >= 0;
    if (!baseOk || !outOk) {
      // a latency component is unknown/invalid → cannot convert honestly: never a partial sum (D21)
      return { performanceTimeMs: perfNow, contextTimeSeconds: ctxNow, source: "fallback", sampledAt: perfNow };
    }
    const scheduledAtPerfNow: CtxSec = asCtxSec(t.contextTime + (perfNowMs - t.performanceTime) / 1000 + base! + out!);
    if (Math.abs(ctxNow - scheduledAtPerfNow) > D21_RESIDUAL_S) {
      return { performanceTimeMs: perfNow, contextTimeSeconds: ctxNow, source: "fallback", sampledAt: perfNow };
    }
    return {
      performanceTimeMs: perfNow,
      contextTimeSeconds: scheduledAtPerfNow,
      source: "getOutputTimestamp",
      sampledAt: perfNow,
    };
  }
  return { performanceTimeMs: perfNow, contextTimeSeconds: ctxNow, source: "fallback", sampledAt: perfNow };
}

export class ClockPairKeeper {
  private cached: ClockPair | null = null;
  constructor(
    private readonly ctx: { currentTime: number },
    private readonly opts?: {
      readOutputTimestamp?: () => { performanceTime: number; contextTime: number } | null;
      readLatency?: () => { baseLatencySeconds?: number; outputLatencySeconds?: number } | undefined;
      maxAgeMs?: number;
    },
  ) {}
  get(nowMs: number): ClockPair {
    const maxAge = this.opts?.maxAgeMs ?? 1000;
    if (this.cached === null || nowMs - this.cached.sampledAt >= maxAge) {
      this.cached = samplePair(
        this.ctx,
        nowMs,
        this.opts?.readOutputTimestamp,
        this.opts?.readLatency?.(),
      );
    }
    return this.cached;
  }
  // Round 5 P0-1: drop the cache so the next get() re-samples in the same tick.
  // Call on every clock lifecycle transition (pause/resume/statechange/visibility)
  // so a pair sampled before a suspension never maps inputs after it.
  invalidate(): void {
    this.cached = null;
  }
}
