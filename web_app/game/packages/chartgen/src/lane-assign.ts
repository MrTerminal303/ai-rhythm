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
 * than `targetNps` onsets. A single time-ordered sweep: for each onset, the
 * window `[t, t+1000)` may contain at most `cap` kept onsets; later onsets in a
 * crowded window lose to earlier, higher-confidence ones (the onsets arrive
 * sorted by (t, -confidence), so ties prefer the higher confidence that starts
 * the window).
 */
export function selectDensity(onsets: Onset[], targetNps: number): Onset[] {
  const sorted = [...onsets].sort((a, b) => a.tMs - b.tMs || b.confidence - a.confidence);
  const cap = Math.max(1, Math.floor(targetNps));
  const kept: Onset[] = [];
  for (const o of sorted) {
    const inWindow = kept.filter((k) => o.tMs - k.tMs < 1000 && k.tMs <= o.tMs).length;
    if (inWindow < cap) kept.push(o);
  }
  return kept;
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
    const primary = pickLane(rng, lastLane, sameLaneRun);
    drafts.push(makeNote(primary, t, rng, holdP, holdMs, durationMs, holdEndByLane));
    if (isChord) {
      const partner = chordPartner(primary, rng);
      drafts.push(makeNote(partner, t, rng, holdP, holdMs, durationMs, holdEndByLane));
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
 * push a rolling window over `targetNps` (each chord emits two notes). Drop the
 * lower-confidence members of an over-full window deterministically (later time,
 * then higher lane) until every 1 s window is within the cap.
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
function pickLane(rng: () => number, lastLane: number, run: number): number {
  const pool: number[] = [];
  for (const l of [0, 1, 2, 3]) if (!(l === lastLane && run >= 2)) pool.push(l);
  return pool[Math.floor(rng() * pool.length)] ?? 0;
}

/** Chord partner: `a ± 2` (non-adjacent, distinct), clamped into 0..3. */
function chordPartner(a: number, rng: () => number): number {
  const candidates = [a - 2, a + 2].filter((l) => l >= 0 && l <= 3);
  return candidates[Math.floor(rng() * candidates.length)] ?? (a < 2 ? a + 2 : a - 2);
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
