// apps/web/src/app/play/input-probe.ts
// W3 T2 (D21, round 10 P1-1 regression target): the pure calculation behind the
// inputProbeRecord recorder — no React state, no side effects.
//
// It lives in its OWN module (not in page.tsx) so the unit test can IMPORT the real
// implementation instead of mirroring it: a mirrored copy stays green when the page
// regresses, which is exactly the defect this module fixes. The play page is a Next
// client component whose generated .next/types OmitWithTag constraint forbids extra
// named exports from the page module — a sibling module has no such constraint.
import type { ClockPair } from "../../engine/time-math.js";

export interface InputProbeEntry {
  e: number; handlerNow: number; ageMs: number; dispatchDelayMs: number;
  errMs: number; source: string; refUncertaintyMs: number;
  refPerfBefore: number; refPerfAfter: number; refCtxNow0: number;
}

/** The event the probe measures. Structurally a KeyboardEvent — only `timeStamp` is read. */
export interface ProbeEvent {
  timeStamp: number;
}

/** The independent same-tick reference snapshot captured in the onKey wrapper. */
export interface ProbeReference {
  perfBefore: number; perfAfter: number; ctxNow0: number;
}

export const computeProbeEntry = (
  e: ProbeEvent,
  cached: ClockPair,
  handlerNow: number,
  ref: ProbeReference,
): InputProbeEntry => {
  const cachedCtxAtE = cached.contextTimeSeconds + (e.timeStamp - cached.performanceTimeMs) / 1000;
  // The reference anchor is the MIDPOINT of the perfBefore/perfAfter bracket — the ctx
  // read brackets the handler entry, not post-processing time (round 10 P1-1).
  const refPerfMid = (ref.perfBefore + ref.perfAfter) / 2;
  const refCtxAtE = ref.ctxNow0 + (e.timeStamp - refPerfMid) / 1000;
  // Bounded reference uncertainty (round 11 P2-19 + round 12 P2-6): (a) clock-advance
  // uncertainty = bracket width; (b) render-quantum floor ≈ 2.8 ms (48 kHz quantum 2.7,
  // 44.1 kHz 2.9 — repeated reads of currentTime within one quantum return the same value).
  // Do NOT add |e.timeStamp − refPerfMid| — that anchoring offset the formula accounts for.
  const refUncertaintyMs = Math.max(ref.perfAfter - ref.perfBefore, 2.8);
  return {
    e: e.timeStamp,
    handlerNow,
    ageMs: handlerNow - cached.sampledAt,
    dispatchDelayMs: handlerNow - e.timeStamp,
    errMs: Math.abs(cachedCtxAtE - refCtxAtE) * 1000,
    source: cached.source,
    refUncertaintyMs,
    refPerfBefore: ref.perfBefore,
    refPerfAfter: ref.perfAfter,
    refCtxNow0: ref.ctxNow0,
  };
};
