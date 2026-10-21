import { stableJson } from "@airhythm/shared";
import type { Onset } from "./flux-v1.js";

/**
 * T25 lane assignment — PLAN §13.2 step 7 verbatim, plus Q27 chord cap.
 *
 * The lane seed is `SHA-256(canonical UTF-8 JSON({ audioHash, generationOptions,
 * generatorId: "flux-v1", generatorVersion: "1" }))` (the brief's formula, verbatim).
 * `generationOptions` is the RESOLVED option record (`targetNps` default 7,
 * `density` default 0); `stableJson` is shared's code-unit-sorted stable
 * stringify, so the digest is engine-stable. mulberry32 is seeded from the first
 * 4 digest bytes (big-endian uint32) — a deterministic, dependency-free
 * hash-to-PRNG bridge.
 *
 * Invariants:
 * - lanes ∈ 0..3; no more than 2 consecutive same-lane taps (jack cap)
 * - chords are clamped to 2 (Q27); their lanes are non-adjacent (`|a−b| ≥ 2`)
 * - holds: no overlapping holds per lane, `d ≥ 250 ms`; a hold starts only after
 *   the lane's last hold ended and never before the previous note on that lane
 * - a lane that is inside an active hold is NOT available: neither a tap nor a
 *   hold may be emitted on it until the hold ends
 */

/** One lane-assigned note draft (before ids/validation). */
export interface NoteDraft {
  t: number;
  lane: number;
  type: "tap" | "hold";
  d?: number;
}

export interface AssignOptions {
  /** Fraction of onsets promoted to a 2-note chord (default 0.2 — Q27 cap 2). */
  chordProbability?: number;
  /** Fraction of single taps promoted to holds (default 0.15). */
  holdProbability?: number;
  /** Hold duration in ms (default 300 — the §13.4 floor is 250). */
  holdDurationMs?: number;
  /** Track duration — holds never extend past it. */
  durationMs?: number;
}

export const MIN_HOLD_MS = 250;

// ------------------------------------------------------------------ PRNG + laneSeed
/** mulberry32 — the brief's PRNG, applied to the lane seed bytes. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The laneSeed input record in canonical (code-unit-sorted) JSON. */
export function laneSeedInput(audioHash: string, generationOptions: Record<string, unknown>): string {
  return stableJson({
    audioHash,
    generationOptions,
    generatorId: "flux-v1",
    generatorVersion: "1",
  });
}

/** SHA-256 of the canonical laneSeed input → first 4 digest bytes as a big-endian uint32. */
export async function computeLaneSeed(
  audioHash: string,
  generationOptions: Record<string, unknown>,
): Promise<number> {
  const canonical = laneSeedInput(audioHash, generationOptions);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
}

// ------------------------------------------------------------------ density selection
/**
 * Keep the highest-confidence onsets so that no rolling 1 s window holds more
 * than `targetNps` onsets (PLAN §13.2 step 8). Candidates are considered in
 * DESCENDING confidence (ties prefer the earlier onset) and a candidate is
 * accepted only when EVERY rolling 1 s window stays within the cap — so a
 * high-confidence onset is never dropped in favour of an earlier, weaker one.
 */
export function selectDensity(onsets: Onset[], targetNps: number): Onset[] {
  const cap = Math.max(1, Math.floor(targetNps));
  const ordered = [...onsets].sort((a, b) => b.confidence - a.confidence || a.tMs - b.tMs);
  const kept: Onset[] = []; // time-sorted, so the window counts are binary-searchable
  for (const o of ordered) {
    if (fitsDensityWindow(kept, o, cap)) {
      kept.push(o);
      kept.sort((a, b) => a.tMs - b.tMs);
    }
  }
  return kept;
}

/**
 * Would adding `o` keep every rolling 1 s window within `cap`? The maximum count
 * over all windows of length 1 s is attained by a window whose left edge is one
 * of the points, so checking the window anchored at each kept point (plus the
 * one anchored at `o`) is exact.
 */
function fitsDensityWindow(kept: Onset[], o: Onset, cap: number): boolean {
  for (const k of kept) {
    if (o.tMs >= k.tMs && o.tMs - k.tMs < 1000 && countInWindow(kept, k.tMs) + 1 > cap) return false;
  }
  return countInWindow(kept, o.tMs) + 1 <= cap;
}

/** How many of the time-sorted `kept` fall in `[t, t+1000)`. */
function countInWindow(sorted: Onset[], t: number): number {
  return lowerBound(sorted, t + 1000) - lowerBound(sorted, t);
}

/** Index of the first entry with `tMs >= t` (binary search over a time-sorted array). */
function lowerBound(sorted: Onset[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.tMs < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------------ lane assignment
/**
 * Assign lanes to time-sorted onsets. `onsets` ascending by `tMs`. Returns the
 * drafts sorted by (t, lane); chords emit one draft per lane at the same time.
 */
export function assignLanes(onsets: Onset[], rng: () => number, opts: AssignOptions = {}): NoteDraft[] {
  const chordP = opts.chordProbability ?? 0.2;
  const holdP = opts.holdProbability ?? 0.15;
  const holdMs = Math.max(MIN_HOLD_MS, opts.holdDurationMs ?? 300);
  const durationMs = opts.durationMs ?? Number.POSITIVE_INFINITY;
  const drafts: NoteDraft[] = [];
  let lastLane = -1;
  let sameLaneRun = 0;
  const holdEndByLane = new Map<number, number>();

  for (const o of onsets) {
    const t = Math.round(o.tMs);
    const isChord = rng() < chordP;
    // A lane inside an active hold is NOT available — a tap there would land
    // inside the hold (a note the player cannot hit).
    const busy = (lane: number): boolean => t < (holdEndByLane.get(lane) ?? -Infinity);
    const primary = pickLane(rng, lastLane, sameLaneRun, busy);
    if (primary === null) continue; // every lane is inside a hold — the onset is dropped
    drafts.push(makeNote(primary, t, rng, holdP, holdMs, durationMs, holdEndByLane));
    if (isChord) {
      const partner = chordPartner(primary, rng, busy);
      if (partner !== null) drafts.push(makeNote(partner, t, rng, holdP, holdMs, durationMs, holdEndByLane));
    }
    // Jack cap bookkeeping: a single tap on the same lane extends the run; a
    // chord (or a different lane) resets it. Chords never count toward the run.
    if (!isChord && primary === lastLane) {
      sameLaneRun++;
    } else {
      lastLane = primary;
      sameLaneRun = 1;
    }
  }
  return drafts.sort((a, b) => a.t - b.t || a.lane - b.lane);
}

/**
 * Re-check the density cap AFTER lane assignment: a chord at the cap boundary can
 * push a rolling window over `targetNps` (each chord emits two notes). When a
 * window is over the cap, the LATER notes in that window are dropped
 * deterministically (time, then lane) until it fits. `NoteDraft` carries no
 * confidence — the confidence-based selection happens upstream in
 * `selectDensity`; this pass only enforces the cap on the lane-assigned notes.
 */
export function enforceNoteDensity(notes: NoteDraft[], targetNps: number): NoteDraft[] {
  const cap = Math.max(1, Math.floor(targetNps));
  const sorted = [...notes].sort((a, b) => a.t - b.t || a.lane - b.lane);
  const dropped = new Set<NoteDraft>();
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (dropped.has(n)) continue;
    const inWindow: NoteDraft[] = [];
    for (let j = i; j < sorted.length; j++) {
      const m = sorted[j]!;
      if (dropped.has(m)) continue;
      if (m.t - n.t >= 1000) break;
      inWindow.push(m);
    }
    // Keep the earliest `cap` notes in this window; a chord that straddles the
    // boundary keeps its earliest member and loses the partner.
    for (let k = cap; k < inWindow.length; k++) dropped.add(inWindow[k]!);
  }
  return sorted.filter((n) => !dropped.has(n));
}

// ------------------------------------------------------------------ helpers
/**
 * Pick a lane for a single tap: never the jack-capped lane, never a lane inside
 * an active hold. Returns `null` when every lane is unavailable.
 */
function pickLane(
  rng: () => number,
  lastLane: number,
  run: number,
  busy: (lane: number) => boolean,
): number | null {
  const pool: number[] = [];
  for (const l of [0, 1, 2, 3]) {
    if (l === lastLane && run >= 2) continue; // jack cap
    if (busy(l)) continue; // inside an active hold
    pool.push(l);
  }
  if (pool.length === 0) return null;
  // `rng()` is in [0, 1) so the index is always in range — no fallback branch.
  return pool[Math.floor(rng() * pool.length)]!;
}

/**
 * Chord partner: `a ± 2` (non-adjacent, distinct), clamped into 0..3, and never
 * inside an active hold. Returns `null` when no partner lane is available.
 */
function chordPartner(a: number, rng: () => number, busy: (lane: number) => boolean): number | null {
  const candidates = [a - 2, a + 2].filter((l) => l >= 0 && l <= 3 && !busy(l));
  if (candidates.length === 0) return null;
  // `rng()` is in [0, 1) so the index is always in range — no fallback branch.
  return candidates[Math.floor(rng() * candidates.length)]!;
}

function makeNote(
  lane: number,
  t: number,
  rng: () => number,
  holdP: number,
  holdMs: number,
  durationMs: number,
  holdEndByLane: Map<number, number>,
): NoteDraft {
  const lastEnd = holdEndByLane.get(lane) ?? -Infinity;
  const canHold = t >= lastEnd && t + holdMs <= durationMs && rng() < holdP;
  if (!canHold) return { t, lane, type: "tap" };
  holdEndByLane.set(lane, t + holdMs);
  return { t, lane, type: "hold", d: holdMs };
}
