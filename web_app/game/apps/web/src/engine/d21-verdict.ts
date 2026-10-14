// apps/web/src/engine/d21-verdict.ts
export const D21_ACCEPT_RATE = 0.9;        // frozen: ≥90% of probed samples accepted
// Round 10 P1-2/P1-4: the measured quantity is the OBSERVED REFERENCE DISCREPANCY
// (|t_cached − t_ref|), NOT a bound on the true mapping error — the independent reference
// itself has uncertainty (bounded by the two performance.now() brackets, ~1 audio render
// quantum ≈ 2.7–2.9 ms). The budget is the max PERMITTED observed discrepancy under normal
// precision. "conversion-validated" therefore claims the observed discrepancy is within
// budget; it does NOT claim the true mapping error is < 5 ms (that would require an
// uncertainty-free reference).
export const D21_MAX_MAPPING_ERR_MS = 5;   // frozen: max OBSERVED reference discrepancy under normal precision
export type D21Precision = "normal" | "degraded" | "inconclusive";
export type D21Verdict = "conversion-validated" | "fallback-mode" | "conversion-unverified" | "mapping-error-fail";

export function d21FinalVerdict(input: {
  precision: D21Precision;
  acceptCount: number;  // DIRECT conversion-sample accepts (probePair population — round 9 P1-3)
  total: number;        // DIRECT conversion-sample total
  maxAbsErrMs: number | null; // REAL-INPUT observed reference discrepancy (recorded pairs, round 9; round 10 P1-4); null = no usable measurement
  // Round 10 P1-2: invalid-measurement flag — if ANY of the N individual error readings
  // was NaN/±Infinity (e.g. a malformed recorder entry), the aggregate is USABLE but
  // the measurement is INVALID: fail closed to conversion-unverified.
  anyInvalidReading: boolean;
}): D21Verdict {
  // Round 11 P1-2: validate counters BEFORE any verdict classification. Invalid counters
  // (negative, fractional, non-integer, NaN, Infinity) can never produce a trustworthy
  // acceptance-rate — fail closed to conversion-unverified. Do NOT relax the expected
  // test result to accommodate invalid input.
  if (!Number.isInteger(input.acceptCount) || !Number.isInteger(input.total)) return "conversion-unverified";
  if (input.acceptCount < 0 || input.total <= 0 || input.acceptCount > input.total) return "conversion-unverified";
  if (input.precision !== "normal") return "conversion-unverified"; // bound not demonstrable
  // Round 10 P1-2: fail closed on invalid measurements BEFORE the budget check.
  // A NaN/±Infinity reading can never be "within budget" — comparisons with NaN are
  // false, which would silently skip the >5 ms hard-fail below.
  if (input.anyInvalidReading) return "conversion-unverified"; // measurement unusable
  if (input.maxAbsErrMs === null) return "conversion-unverified"; // no measurement at all
  // SAFETY BEFORE ELIGIBILITY (round 9 P0): a measured mapping failure is a HARD FAIL
  // REGARDLESS of acceptance rate — poor conversion availability must never hide a
  // measured failure of the fallback path.
  if (!Number.isFinite(input.maxAbsErrMs)) return "conversion-unverified"; // P1-2 double-guard
  // Round 13 P2-2: a negative "max abs error" is a malformed aggregate — |E| can never be
  // negative. Fail closed; never let it reach the eligibility branch.
  if (input.maxAbsErrMs < 0) return "conversion-unverified";
  if (input.maxAbsErrMs > D21_MAX_MAPPING_ERR_MS) return "mapping-error-fail"; // HARD FAIL
  // observed discrepancy within budget from here on:
  if (input.total === 0) return "conversion-unverified";
  const eligible = input.acceptCount / input.total >= D21_ACCEPT_RATE;
  return eligible ? "conversion-validated" : "fallback-mode";
}

// ONE precision classifier for every consumer (round 9 P2-5 — the rate test's looser
// inline rule is removed): normal if ANY fine step < GRANULARITY_FINE_MS; degraded only
// when there are ≥ MIN_GRANULARITY_CHANGES steps AND ALL are ≥ GRANULARITY_DEGRADED_MS;
// everything else (mixed, too few) is inconclusive — mixed is NOT a degraded diagnosis.
//
// Round 14 deviation (test-driven, operator decision logged in task-2-report.md): the
// frozen brief body checked `changes.length < MIN_GRANULARITY_CHANGES` BEFORE the
// fine-step check, which contradicted one of its own frozen test rows —
// "[2.8, 16.7, 16.7]" (3 changes, one fine step) must yield "normal". As written, the
// body returns "inconclusive" for that row. Implemented the only ordering consistent
// with all four frozen rows: a fine step observed among the FIVE OR MORE changes →
// "normal"; fewer than 5 changes and all ≥16 ms → "degraded" (round 7: the Firefox
// privacy.resistFingerprinting class shows uniform ≥16 ms changes); anything else →
// "inconclusive" (insufficient evidence either direction).
export const GRANULARITY_FINE_MS = 10;
export const GRANULARITY_DEGRADED_MS = 16;
export const MIN_GRANULARITY_CHANGES = 5;

export function classifyPrecision(changes: number[]): D21Precision {
  const hasFine = changes.some((d) => d > 0 && d < GRANULARITY_FINE_MS);
  if (changes.length >= MIN_GRANULARITY_CHANGES) {
    if (hasFine) return "normal";
    return changes.every((d) => d >= GRANULARITY_DEGRADED_MS) ? "degraded" : "inconclusive";
  }
  // < 5 observations: all ≥16 → degraded-class diagnosis; else inconclusive
  if (changes.length > 0 && !hasFine && changes.every((d) => d >= GRANULARITY_DEGRADED_MS)) return "degraded";
  return "inconclusive"; // mixed / too-few / fine-under-five — not a degraded diagnosis
}
