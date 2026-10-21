// apps/web/src/app/import/generate-q10.ts
//
// W3 T25b fix r1 — the Q10 decision, extracted as a PURE function so it can be
// unit-tested. Before this, the Retry/Cancel surface in `page.tsx` had ZERO
// coverage: deleting it left every gate green.
//
// Q10 in one sentence: when a generation FAILS or runs OVER ITS BUDGET, the user
// is offered Retry and Cancel — and the app NEVER silently switches to another
// generator. `flux-v1` is the only generator, so every decision carries it.
//
// This module owns NO React state and NO I/O: it maps a run's OUTCOME to a
// rendering DECISION. The page applies the decision.

import { FluxGenerateError, FLUX_GENERATION_TIMEOUT_MS } from "@airhythm/chartgen";

/** The generator that produced the chart. The ONLY one (Q10: no silent switch). */
export const GENERATOR_ID = "flux-v1" as const;

/**
 * The Q10 generation budget — DERIVED from the generator's own constant, never
 * restated (the repo's single-source-of-truth rule: the engine does the same for
 * `JUDGE_WINDOWS.good`). The app passes this value to the generator; the
 * generator's own `FLUX_GENERATION_TIMEOUT_MS` is the fallback when no budget is
 * supplied, so the two can never disagree.
 */
export const GENERATE_TIMEOUT_MS = FLUX_GENERATION_TIMEOUT_MS;

/** What ended a generation run. */
export interface GenerateOutcome {
  /**
   * The AbortSignal fired — the USER cancelled. A user cancel is NOT a failure:
   * the run just stops and the page re-enables Generate. The generator's own
   * budget timeout does NOT set the abort flag, so an over-budget run arrives
   * here as a `timeout` ERROR and DOES get the Retry/Cancel surface.
   */
  cancelled: boolean;
  /** The failure that ended the run, if any (null/undefined = the run succeeded). */
  error?: unknown;
}

/** The rendering decision the page applies. */
export interface GenerateUiDecision {
  /** The Q10 error block is visible. */
  showError: boolean;
  /** Retry is offered. */
  showRetry: boolean;
  /** Cancel is offered. */
  showCancel: boolean;
  /** The message inside the error block (null when no block). */
  message: string | null;
  /**
   * The generator's structured error code — "timeout" (over budget), "validation",
   * "internal" or "cancelled" — or null for a failure that carried none.
   */
  code: string | null;
  /**
   * The generator the run used. It is ALWAYS `flux-v1`: Q10 forbids a silent
   * generator switch, so no decision may name a different generator.
   */
  generatorId: typeof GENERATOR_ID;
}

const NO_ERROR: GenerateUiDecision = {
  showError: false,
  showRetry: false,
  showCancel: false,
  message: null,
  code: null,
  generatorId: GENERATOR_ID,
};

/**
 * The Q10 decision table.
 *
 * | outcome                       | error block | Retry | Cancel | code        |
 * |-------------------------------|-------------|-------|--------|-------------|
 * | user cancelled                | no          | no    | no     | null        |
 * | success                       | no          | no    | no     | null        |
 * | over budget (timeout)         | YES         | YES   | YES    | "timeout"   |
 * | validation failure            | YES         | YES   | YES    | "validation"|
 * | internal failure              | YES         | YES   | YES    | "internal"  |
 * | any other failure             | YES         | YES   | YES    | null        |
 *
 * Every row keeps the SAME generator (`flux-v1`) — a failure never switches it.
 */
export function decideGenerateUi(outcome: GenerateOutcome): GenerateUiDecision {
  if (outcome.cancelled) return { ...NO_ERROR };
  if (outcome.error === undefined || outcome.error === null) return { ...NO_ERROR };
  const err = outcome.error;
  const code = err instanceof FluxGenerateError ? err.code : null;
  const detail = err instanceof Error ? err.message : String(err);
  return {
    showError: true,
    showRetry: true,
    showCancel: true,
    message:
      code === null ? `Generation failed: ${detail}` : `Generation failed (${code}): ${detail}`,
    code,
    generatorId: GENERATOR_ID,
  };
}
