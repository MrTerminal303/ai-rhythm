export type Rank = "SS" | "S" | "A" | "B" | "C" | "D";

/**
 * Rank from final accuracy fraction (0..1). Thresholds frozen per spec §4 B4 (D28) —
 * pure, server-side-reusable: the same mapping grades client runs and future server
 * recomputation. Tunable in one place.
 */
export function rankFor(accuracyFraction: number): Rank {
  if (accuracyFraction >= 0.995) return "SS";
  if (accuracyFraction >= 0.98) return "S";
  if (accuracyFraction >= 0.95) return "A";
  if (accuracyFraction >= 0.9) return "B";
  if (accuracyFraction >= 0.85) return "C";
  return "D";
}
