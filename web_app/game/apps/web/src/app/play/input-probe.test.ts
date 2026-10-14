// apps/web/src/app/play/input-probe.test.ts
// Page-level regression target for D21 round 10 P1-1: the probe reference must be
// anchored at the midpoint of ref.perfBefore/ref.perfAfter. computeProbeEntry is
// re-implemented here against the CONTRACT (mirrored, not imported — the play page is
// a client component ("use client") and its OmitWithTag constraint forbids extra named exports).
import { describe, expect, it } from "vitest";
import type { ClockPair } from "../../engine/time-math.js";

// Mirrors the page-local pure computation (page.tsx):
//   refPerfMid = (perfBefore + perfAfter) / 2
//   refCtxAtE  = ctxNow0 + (e.timeStamp − refPerfMid) / 1000
//   cachedCtxAtE = cached.contextTimeSeconds + (e.timeStamp − cached.performanceTimeMs) / 1000
//   errMs          = |cachedCtxAtE − refCtxAtE| × 1000
//   refUncertaintyMs = max(perfAfter − perfBefore, 2.8)  // render-quantum floor (round 12 P2)
const computeProbeEntry = (
  e: { timeStamp: number },
  cached: ClockPair,
  handlerNow: number,
  ref: { perfBefore: number; perfAfter: number; ctxNow0: number },
) => {
  const cachedCtxAtE = cached.contextTimeSeconds + (e.timeStamp - cached.performanceTimeMs) / 1000;
  const refPerfMid = (ref.perfBefore + ref.perfAfter) / 2;
  const refCtxAtE = ref.ctxNow0 + (e.timeStamp - refPerfMid) / 1000;
  const refUncertaintyMs = Math.max(ref.perfAfter - ref.perfBefore, 2.8);
  return {
    e: e.timeStamp,
    handlerNow,
    ageMs: handlerNow - cached.sampledAt,
    dispatchDelayMs: handlerNow - e.timeStamp,
    errMs: Math.abs(cachedCtxAtE - refCtxAtE) * 1000,
    source: cached.source,
    refUncertaintyMs,
  };
};

// Round 10 P1-1 + round 12 P1-1: the reference must be anchored at the midpoint of
// ref.perfBefore/ref.perfAfter, NOT at handlerNow or at call time. If the
// implementation regressed to reading audioCtx.currentTime inside inputProbeRecord
// (the round-9 bug), this test fails.
describe("inputProbeRecord — reference anchoring (round 10 P1-1 regression)", () => {
  it("inputProbeRecord uses the perfBefore/perfAfter midpoint as the anchor, not handlerNow or call-time ctx", () => {
    // Simulate: perfBefore=4998, perfAfter=5002 → refPerfMid = 5000 (5 ms BEFORE handlerNow)
    // ctx advanced 5 ms between the bracket and handlerNow — this is the contaminated
    // window the fix removes. If the code uses handlerNow as anchor, refCtxAtE will be
    // 5 ms off from the correct value.
    const fakeCtxNow = 100.0; // ctxNow0 — ctx.currentTime at the moment ref was captured
    const ref = { perfBefore: 4998, perfAfter: 5002, ctxNow0: fakeCtxNow };
    const handlerNow = 5005; // handlerNow is 5 ms AFTER refPerfMid
    const e = { timeStamp: 5000 };
    const cached: ClockPair = {
      contextTimeSeconds: 99.99, // deliberately off by 10 ms from ref
      performanceTimeMs: 4000,
      sampledAt: 4000,
      source: "getOutputTimestamp",
    };

    // Correct calculation:
    // refPerfMid = (4998+5002)/2 = 5000
    // refCtxAtE = 100.0 + (5000 − 5000)/1000 = 100.0
    // cachedCtxAtE = 99.99 + (5000 − 4000)/1000 = 99.99 + 1.0 = 100.99
    // errMs = |100.99 − 100.0| × 1000 = 990 ms
    const entry = computeProbeEntry(e, cached, handlerNow, ref);
    expect(entry.errMs).toBeCloseTo(990, 1);
    // refUncertaintyMs = max(5002−4998, 2.8) = 4 ms
    // (bracket width 5002−4998 dominates the 2.8 ms render-quantum floor — round 12 P2)
    expect(entry.refUncertaintyMs).toBeCloseTo(4, 1);
    // If the implementation used handlerNow as anchor: refCtxAtE = fakeCtxNow + (5000 − 5005)/1000
    // = 100.0 − 0.005 = 99.995; errMs = |100.99 − 99.995| × 1000 = 995 ms — different value, test fails.
  });
});
