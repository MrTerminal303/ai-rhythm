import { JUDGE_WINDOWS, type Grade } from "./constants.js";

export function grade(dt: number): Grade {
  const absDt = Math.abs(dt);
  if (absDt <= JUDGE_WINDOWS.perfect) return "perfect";
  if (absDt <= JUDGE_WINDOWS.great) return "great";
  if (absDt <= JUDGE_WINDOWS.good) return "good";
  return "miss";
}

/** Combo bonus multiplier — PLAN §7.3 "≤5%, documented in code". Tunable. maxCombo clamped to [0, totalTargets]. */
export function comboMultiplier(maxCombo: number, totalTargets: number): number {
  if (totalTargets === 0) return 1;
  const mc = Math.min(Math.max(maxCombo, 0), totalTargets); // bonus can never exceed 5%
  return 1 + 0.05 * (mc / totalTargets);
}

export function scoreFromWeights(sumOfWeights: number, totalTargets: number, maxCombo = 0): number {
  if (totalTargets === 0) return 0;
  const base = (1_000_000 * sumOfWeights) / totalTargets;
  // +1e-7 FP guard: 800000 × 1.025 stores as 819999.9999999999 but the true value is 820000.
  // Genuine fractional scores sit ≥ 1/totalTargets from an integer — always ≫ 1e-7.
  return Math.min(
    Math.floor(base * comboMultiplier(maxCombo, totalTargets) + 1e-7),
    Math.floor(1_000_000 * 1.05),
  );
}

export function accuracyFraction(sumOfWeights: number, totalTargets: number): number {
  if (totalTargets === 0) return 0;
  return sumOfWeights / totalTargets;
}
