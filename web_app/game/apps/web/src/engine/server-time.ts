// apps/web/src/engine/server-time.ts — pure §7.1 server projection + resync + drift (no I/O; ping loop is W4)

export interface PingSample { t0: number; serverTimeMs: number; t3: number; }
export interface ClockAnchor { clientPerfAtSyncMs: number; serverEpochAtSyncMs: number; }

export function selectClockAnchor(samples: PingSample[]): ClockAnchor {
  if (samples.length === 0) throw new Error("no ping samples");
  const withRtt = samples.map((s) => ({ ...s, rtt: s.t3 - s.t0 })).sort((a, b) => a.rtt - b.rtt);
  const kept = withRtt.slice(0, Math.max(1, Math.ceil(withRtt.length / 2))); // low-jitter half
  const offsets = kept
    .map((s) => ({ mid: (s.t0 + s.t3) / 2, off: s.serverTimeMs - (s.t0 + s.t3) / 2 }))
    .sort((a, b) => a.off - b.off);
  const med = offsets[Math.floor(offsets.length / 2)]!;
  return { clientPerfAtSyncMs: med.mid, serverEpochAtSyncMs: med.mid + med.off };
}

export function serverNowMs(anchor: ClockAnchor, perfNowMs: number): number {
  return anchor.serverEpochAtSyncMs + (perfNowMs - anchor.clientPerfAtSyncMs);
}

export function serverClockOffsetMs(anchor: ClockAnchor): number {
  return anchor.serverEpochAtSyncMs - anchor.clientPerfAtSyncMs;
}

export function serverSongMs(anchor: ClockAnchor, perfNowMs: number, startAtServerTimeMs: number): number {
  return serverNowMs(anchor, perfNowMs) - startAtServerTimeMs;
}

export function startCtxTimeSeconds(ctxCurrentTime: number, startAtServerTimeMs: number, serverNow: number): number {
  return ctxCurrentTime + (startAtServerTimeMs - serverNow) / 1000;
}

export function computeResyncTarget(
  serverSongMsValue: number,
  audioOffsetMs: number,
  audioDurationMs: number,
  chartEndMs: number,
): { positionMs: number; pastEnd: boolean } {
  const pastEnd = serverSongMsValue > chartEndMs;
  const desired = serverSongMsValue - audioOffsetMs; // chart → buffer: subtract once
  const positionMs = Math.min(Math.max(desired, 0), audioDurationMs);
  return { positionMs, pastEnd };
}

export class DriftGuard {
  private sinceMs: number | null = null;
  private armed = true;
  constructor(private readonly thresholdMs = 250, private readonly sustainMs = 2000) {}
  observe(diffMs: number, nowMs: number): boolean {
    const over = Math.abs(diffMs) > this.thresholdMs;
    if (!over) {
      this.sinceMs = null;
      this.armed = true;
      return false;
    }
    if (this.sinceMs === null) this.sinceMs = nowMs;
    if (this.armed && nowMs - this.sinceMs >= this.sustainMs) {
      this.armed = false;
      return true;
    }
    return false;
  }
}
