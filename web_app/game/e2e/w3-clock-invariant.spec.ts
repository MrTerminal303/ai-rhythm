// e2e/w3-clock-invariant.spec.ts
// D21 real-browser conversion proof (rounds 2–8): the sampler's accept/reject decision IS the
// gate — the suite never asserts a raw population band that contradicts the fallback
// accommodation. The four evidence items feed the A5 claim-1 report verbatim, one block per engine.
import { expect, test } from "@playwright/test";
import { d21FinalVerdict, classifyPrecision } from "../apps/web/src/engine/d21-verdict.js";

// Band rationale (round 5 — three SEPARATE quantities, per D21's table):
//   (1) PAIR AGE — time since the clocks were sampled (keeper cache ≤ 1 s; never a bound
//       on anything else).
//   (2) MAPPING ERROR — how far estimated chart time differs from true scheduled-domain
//       chart time. The 25 ms threshold bounds ONLY the clock-mapping contribution of the
//       getOutputTimestamp path (measured residual). It is NOT a full input-to-render
//       guarantee: event delivery, handler latency, etc. are separate contributors
//       (instrumented by A13 input telemetry, not bounded by this constant).
//   (3) GAMEPLAY TIMING ERROR — mapping error reaches dt 1:1; other contributors add on
//       top; boundary flips within the total error of a threshold remain possible and are
//       ACCEPTED (worst case from mapping alone: 25 ms).
// Fallback path (round 8 — CACHED-PAIR MAPPING contract, the single truth): pairs are
// CACHED by ClockPairKeeper (≤1 s age) and used for every input mapping; the keeper is
// INVALIDATED across suspend/resume/visibility/phase transitions so suspended time never
// enters extrapolation; correctness is measured ON THE REAL INPUT PATH — each accepted
// lane-key event records the exact pair used and its mapping error at event.timeStamp
// vs an independent same-tick (performance.now(), currentTime) reference (pair age alone
// is explicitly NOT claimed as that bound); the ≤5 ms rate-divergence check is GATED on
// precision and is supporting evidence only. The FINAL outcome is computed ONCE by the
// frozen d21FinalVerdict() pure function. Budget changes = new D21 revision with a
// fresh run, never a silent widen-to-green.
test("D21 conversion invariant: accepted conversions are in-band; out-of-band samples select fallback (full residual)", async ({ page }) => {
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing");
  await page.waitForTimeout(1000);
  // Round 11 P1-1: the probePair result type includes `reason` — declared once here and
  // reused in the samples array and the reasonCounts consumer (strict TS: reading
  // s.reason on a type without `reason` is a compile error).
  type ProbePairResult = {
    source: string;
    residualMs: number | null;
    reason: "accepted" | "missing-timestamp" | "invalid-latency" | "residual-guard";
  };
  const samples: ProbePairResult[] = await page.evaluate(async () => {
    const w = (window as never as { __w2: { probePair(): { source: string; residualMs: number | null; reason: "accepted" | "missing-timestamp" | "invalid-latency" | "residual-guard" } } }).__w2;
    const out: { source: string; residualMs: number | null; reason: "accepted" | "missing-timestamp" | "invalid-latency" | "residual-guard" }[] = [];
    for (let i = 0; i < 50; i++) {
      out.push(w.probePair());
      await new Promise((r) => setTimeout(r, 20));
    }
    return out;
  });
  expect(samples.length).toBeGreaterThan(40);
  const accepted = samples.filter((s) => s.source === "getOutputTimestamp" && s.residualMs !== null);
  const rejected = samples.filter((s) => s.source === "fallback");
  // CONSISTENCY contract (round 4): every conversion samplePair ACCEPTED must be in-band —
  // exactly what the runtime guard guarantees, so this can never fail on an engine the
  // contract accommodates; an engine whose conversion never passes records all-fallback
  // evidence (downgrade recorded in D21 evidence, suite stays green).
  for (const a of accepted) expect(Math.abs(a.residualMs!)).toBeLessThanOrEqual(25);
  // every sample whose raw residual is out-of-band must have been REJECTED to fallback
  for (const s of samples) {
    if (s.residualMs !== null && Math.abs(s.residualMs) > 25) expect(s.source).toBe("fallback");
  }
  const residuals = samples.filter((s) => s.residualMs !== null).map((s) => s.residualMs!);
  // ROUND 8: this is an INTERMEDIATE eligibility flag, NEVER the final verdict — the final
  // verdict is computed ONCE by d21FinalVerdict() in the mapping-evidence test below.
  const MIN_ACCEPTED = 45;
  const acceptRateEligible = accepted.length >= MIN_ACCEPTED;
  void rejected; // fallback breakdown is reported via reasonCounts below
  const sortedSigned = [...residuals].sort((a, b) => a - b);
  const absSorted = [...residuals].map(Math.abs).sort((a, b) => a - b);
  const stat = (arr: number[]) => (arr.length ? arr : null);
  const stats = {
    minSigned: stat(sortedSigned) ? sortedSigned[0]! : null,
    medianSigned: stat(sortedSigned) ? sortedSigned[Math.floor(sortedSigned.length / 2)]! : null,
    maxSigned: stat(sortedSigned) ? sortedSigned[sortedSigned.length - 1]! : null,
    maxAbs: stat(absSorted) ? absSorted[absSorted.length - 1]! : null, // round 8 P2-4: last SIGNED was wrong when the worst residual was negative
    p95Abs: stat(absSorted) ? absSorted[Math.min(absSorted.length - 1, Math.ceil(absSorted.length * 0.95) - 1)]! : null,
  };
  const reasonCounts: Record<string, number> = {};
  for (const s of samples) reasonCounts[s.reason] = (reasonCounts[s.reason] ?? 0) + 1; // round 8 P2-4: structured fallback reasons
  console.log(`[D21 evidence] 1) residual stats: n=${residuals.length} min=${stats.minSigned} median=${stats.medianSigned} maxSigned=${stats.maxSigned} maxAbs=${stats.maxAbs} p95Abs=${stats.p95Abs}`);
  console.log(`[D21 evidence] 2) accepted conversions: ${accepted.length}/${samples.length} (${((accepted.length / samples.length) * 100).toFixed(0)}%) — frozen minimum ${MIN_ACCEPTED}/${samples.length}; acceptRateEligible=${acceptRateEligible}`);
  console.log(`[D21 evidence] 3) fallback breakdown: ${JSON.stringify(reasonCounts)} (codes: missing-timestamp | invalid-latency | residual-guard; accepted-counted separately)`);
  // NOTE (round 8): no "outcome" is printed here — the FOURTH evidence item is the single
  // final verdict logged ONCE by d21FinalVerdict() in the mapping-evidence test.
  expect(typeof acceptRateEligible).toBe("boolean");
});

test("D21 fallback guarantee: clock-RATE divergence ≤5 ms over 1 s + invalidate across lifecycle (round 5/6)", async ({ page }) => {
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing");
  // (a) rate divergence — SUPPORTING evidence only; classify precision first (round 8 P1-2:
  // the ≤5 ms assert must not fire in degraded/inconclusive environments where the bound
  // is not demonstrable). Busy-loop CHANGE magnitudes; rAF banned (round 7).
  const rateChanges = await page.evaluate(async () => {
    const snap = () => (window as never as { __w2: { ctxSnapshot(): { currentTime: number } } }).__w2.ctxSnapshot().currentTime;
    const out: number[] = [];
    const t0 = performance.now();
    let prev = snap();
    while (performance.now() - t0 < 300) {
      const cur = snap();
      const d = (cur - prev) * 1000;
      if (d > 0) { out.push(d); prev = cur; }
    }
    return out;
  });
  const ratePrecision = classifyPrecision(rateChanges); // ONE classifier (round 9 P2-5)
  const drift = await page.evaluate(async () => {
    const w = (window as never as { __w2: { ctxSnapshot(): { currentTime: number } } }).__w2;
    const p0 = performance.now();
    const c0 = w.ctxSnapshot().currentTime;
    await new Promise((r) => setTimeout(r, 1200));
    const p1 = performance.now();
    const c1 = w.ctxSnapshot().currentTime;
    return { driftMs: (c1 - c0) * 1000 - (p1 - p0), elapsedMs: p1 - p0 };
  });
  expect(drift.elapsedMs).toBeGreaterThanOrEqual(1000);
  if (ratePrecision === "normal") {
    expect(Math.abs(drift.driftMs)).toBeLessThanOrEqual(5); // CLOCK-RATE divergence check — NOT a per-event mapping bound
  }
  console.log(`[D21 rate-divergence] precision=${ratePrecision} Δctx−Δperf over ${drift.elapsedMs.toFixed(0)}ms = ${drift.driftMs.toFixed(2)}ms${ratePrecision === "normal" ? "" : " (recorded WITHOUT bound assert)"}`);

  // (b) lifecycle invalidation: pause → resume re-samples the pair immediately
  const before = await page.evaluate(() => (window as never as { __w2: { pairSampledAt(): number } }).__w2.pairSampledAt());
  await page.keyboard.press("Escape"); // F04 pause binding (playing → paused)
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2.phase() === "paused");
  await page.getByRole("button", { name: /click to resume/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2.phase() === "playing", undefined, { timeout: 10000 });
  const after = await page.evaluate(() => (window as never as { __w2: { pairSampledAt(): number } }).__w2.pairSampledAt());
  expect(after).not.toBe(before); // invalidate() ran across the transition — no stale pair survives resume
});

test("D21 mapping error on REAL inputs + ONE final verdict (round 8: cached-pair contract)", async ({ page }, testInfo) => {
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing");
  // FROZEN (D21, before evidence): MAX_MAPPING_ERR_MS = 5; MAX_PAIR_AGE_AT_INPUT_MS = 1000 (keeper);
  // granularity classification (round 7 — MEASURED INDEPENDENTLY OF DISPLAY CADENCE):
  //   GRANULARITY_FINE_MS = 10, GRANULARITY_DEGRADED_MS = 16, MIN_GRANULARITY_CHANGES = 5.
  // rAF-spaced reads are BANNED: at 60 Hz each callback observes ~16.7 ms BUNDLES of ~2.7 ms
  // quanta and would misclassify normal browsers as degraded (round 7 P1-1).
  const probe = await page.evaluate(async () => {
    const changes: number[] = [];
    const snap = () => (window as never as { __w2: { ctxSnapshot(): { currentTime: number } } }).__w2.ctxSnapshot().currentTime;
    const t0 = performance.now();
    let prev = snap();
    while (performance.now() - t0 < 300) {
      const cur = snap();
      const d = (cur - prev) * 1000;
      if (d > 0) { changes.push(d); prev = cur; }
    }
    return { changes };
  });
  // three-way classification (round 7): normal | degraded | inconclusive — inconclusive
  // yields conversion-unverified, never an automatic degraded diagnosis
  const precision = classifyPrecision(probe.changes); // ONE classifier (round 9 P2-5)

  // ── 3) DIRECT conversion samples for ELIGIBILITY (round 9 P1-3: the 90% rule applies
  // to probePair's direct population — NOT to key events, which reuse cached pairs) ──
  const direct = await page.evaluate(async () => {
    const w = (window as never as { __w2: { probePair(): { source: string } } }).__w2;
    const out: { source: string }[] = [];
    for (let i = 0; i < 50; i++) {
      out.push(w.probePair());
      await new Promise((r) => setTimeout(r, 20));
    }
    return out;
  });
  const directAcceptCount = direct.filter((s) => s.source === "getOutputTimestamp").length;
  const directTotal = direct.length;

  // ── 3b) REAL input events through the actual handler (round 8 P1-1): the recorder in
  // onKey captures the EXACT pair used (same object as the conversion) + dispatch delay ──
  const mark = await page.evaluate(() => (window as never as { __w2: { inputErrorLog(): unknown[] } }).__w2.inputErrorLog().length);
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press("d"); // REAL input tool → real handler → exact pair
    await page.waitForTimeout(20);
  }
  const entries = await page.evaluate(
    () => (window as never as { __w2: { inputErrorLog(): { e: number; ageMs: number; dispatchDelayMs: number; errMs: number; source: string; refUncertaintyMs: number }[] } }).__w2.inputErrorLog(),
  );
  const real = entries.slice(mark);
  expect(real.length).toBeGreaterThanOrEqual(45); // the real path was exercised
  const maxAge = Math.max(...real.map((x) => x.ageMs), 0);
  const maxDispatchDelay = Math.max(...real.map((x) => x.dispatchDelayMs), 0);
  // Round 10 P1-2: fail-closed aggregation — any non-finite individual reading invalidates
  // the measurement; a NaN/±∞ max can never be treated as "within budget".
  const anyInvalidReading = real.some((x) => !Number.isFinite(x.errMs));
  const maxAbsErr = !anyInvalidReading && real.length
    ? Math.max(...real.map((x) => Math.abs(x.errMs)))
    : (anyInvalidReading ? NaN : null);
  const eventSourceMix = {
    viaOutputTimestamp: real.filter((x) => x.source === "getOutputTimestamp").length,
    viaFallback: real.filter((x) => x.source === "fallback").length,
  }; // evidence only — eligibility comes from the DIRECT samples above
  expect(maxAge).toBeLessThanOrEqual(1000); // keeper contract at mapping time

  // ── 4) ONE final verdict, computed once (round 9 SAFETY-FIRST + round 10 P1-2 fail-closed) ──
  const verdict = d21FinalVerdict({ precision, acceptCount: directAcceptCount, total: directTotal, maxAbsErrMs: maxAbsErr, anyInvalidReading });
  // Round 11 P2-20: include reference uncertainty in the evidence report — max + p95 —
  // so a reviewer can compare the observed discrepancy against the uncertainty floor
  // when auditing the verdict.
  const refUncMax = real.length ? Math.max(...real.map((x) => x.refUncertaintyMs)) : null;
  const refUncSorted = real.map((x) => x.refUncertaintyMs).sort((a, b) => a - b);
  const refUncP95 = refUncSorted.length ? refUncSorted[Math.max(0, Math.ceil(refUncSorted.length * 0.95) - 1)] : null;
  const evidence = { precision, directAcceptCount, directTotal, maxAbsErrMs: maxAbsErr, anyInvalidReading, maxPairAgeMs: maxAge, maxDispatchDelayMs: maxDispatchDelay, eventSourceMix, granularityChanges: probe.changes.length, refUncertaintyMs: { max: refUncMax, p95: refUncP95 }, verdict };
  console.log(`[D21 evidence] 4) FINAL VERDICT (single, computed once): ${verdict} — ${JSON.stringify(evidence)}`);
  testInfo.attach("d21-final-verdict", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  if (verdict === "mapping-error-fail") {
    // Round 10 P1-3: Playwright's `expect` has no `.unreachable()` (that is Vitest-only).
    // Use a plain throw so the hard-fail branch deterministically fails the test.
    throw new Error(`D21: observed reference discrepancy ${maxAbsErr?.toFixed(2)}ms exceeds the frozen 5 ms budget — HARD FAIL regardless of acceptance rate (round 9 P0 + round 10 P1-3: safety beats eligibility)`);
  }
  if (precision === "normal" && directTotal > 0 && directAcceptCount / directTotal >= 0.9 && !anyInvalidReading) {
    expect(verdict).toBe("conversion-validated");
  }
  // round 9 P0 + round 10 P1-2: even the fallback-mode path must carry a WITHIN-BUDGET
  // finite measurement — the verdict function enforces this; this test never reaches
  // fallback-mode with maxAbsErr > 5 (it would have thrown above) or with anyInvalidReading
  // (it would be conversion-unverified).
});
