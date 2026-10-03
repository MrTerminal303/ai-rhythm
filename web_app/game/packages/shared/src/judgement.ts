import { JUDGE_WINDOWS, type Grade } from "./constants.js";

export function grade(dt: number): Grade {
  const absDt = Math.abs(dt);
  if (absDt <= JUDGE_WINDOWS.perfect) return "perfect";
  if (absDt <= JUDGE_WINDOWS.great) return "great";
  if (absDt <= JUDGE_WINDOWS.good) return "good";
  return "miss";
}

export function scoreFromWeights(sumOfWeights: number, totalTargets: number): number {
  if (totalTargets === 0) return 0;
  return Math.floor((1_000_000 * sumOfWeights) / totalTargets);
}

export function accuracyFraction(sumOfWeights: number, totalTargets: number): number {
  if (totalTargets === 0) return 0;
  return sumOfWeights / totalTargets;
}
