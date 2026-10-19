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
 * pure projection of the snapshot. sessionOnly reflects authentication at completion.
 *
 * T23 carry-over fix: `crypto.randomUUID` needs a SECURE CONTEXT, so on a plain-HTTP LAN
 * origin it is undefined and building the result threw — the caller's publish was inside an
 * async IIFE, so a completed run silently vanished with no error. The id now has a
 * documented fallback and never throws; stability (not unguessability) is what the id needs —
 * it is the idempotency key of a row the DB already scopes to `user_id`.
 */
export function buildRunResult(
  snap: GameSnapshot,
  chartHash: string,
  opts: { chartId?: string | null; audioHash?: string | null; authenticated?: boolean } = {},
): RunResult {
  return {
    runId: mintRunId(),
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

/** randomUUID when the context allows it, else a Math.random UUIDv4 shape (no secure context). */
function mintRunId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
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
