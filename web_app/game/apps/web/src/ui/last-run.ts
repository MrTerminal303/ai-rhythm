// W3 T21 (B4): the B6 hand-off store. A completed run publishes ONE RunResult into this
// module-level observable; B6 (T23) subscribes to it. Guest runs publish with
// sessionOnly: true and sync nothing — the store has no network code of its own.
import type { GameSnapshot } from "../engine/types.js";
import { rankFor, type Grade, type Rank } from "@airhythm/shared";

export interface RunResult {
  runId: string;
  chartId: string | null;
  chartHash: string;
  audioHash: string | null;
  score: number;
  maxCombo: number;
  accuracy: number;
  counts: Record<Grade, number>;
  totalTargets: number;
  rank: Rank;
  playedAt: number;
  sessionOnly: boolean;
}

/**
 * Build a RunResult from a frozen snapshot. runId is minted ONCE here
 * (round 3 P1-4: stable identity for idempotent run uploads); every other field is a
 * pure projection of the snapshot. sessionOnly reflects authentication at completion —
 * no auth layer exists yet, so every current run is sessionOnly.
 */
export function buildRunResult(
  snap: GameSnapshot,
  chartHash: string,
  opts: { chartId?: string | null; audioHash?: string | null; authenticated?: boolean } = {},
): RunResult {
  return {
    runId: crypto.randomUUID(),
    chartId: opts.chartId ?? null,
    chartHash,
    audioHash: opts.audioHash ?? null,
    score: snap.score,
    maxCombo: snap.maxCombo,
    accuracy: snap.accuracy,
    counts: snap.judgementCounts,
    totalTargets: totalTargetsFrom(snap),
    rank: rankFor(snap.accuracy),
    playedAt: Date.now(),
    sessionOnly: !opts.authenticated,
  };
}

/** totalTargets is the sum of judgementCounts at freeze (every target resolved). */
function totalTargetsFrom(snap: GameSnapshot): number {
  return Object.values(snap.judgementCounts).reduce((a, b) => a + b, 0);
}

/** Module-level observable: B6 subscribes, the play page publishes on completed. */
class LastRunStore {
  private last: RunResult | null = null;
  private listeners = new Set<(r: RunResult | null) => void>();

  subscribe = (listener: (r: RunResult | null) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get(): RunResult | null {
    return this.last;
  }

  set(next: RunResult): void {
    this.last = next;
    for (const l of this.listeners) l(next);
  }
}

export const lastRunStore = new LastRunStore();
