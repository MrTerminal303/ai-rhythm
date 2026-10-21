// e2e/w3-perf.spec.ts
// W3 T16 (A6) — full-frame perf certification. The GATE and the measurement window are declared in
// apps/web/evidence-templates/w3-perf-protocol.md, committed BEFORE this file's first measurement
// (commit ac5d84d). Two modes, both in one spec:
//   * CI (structure-only, default): race the [perf] console event against a 160 s force-cap; on
//     timeout call __w2.forcePerfReport() and assert STRUCTURE only. CI never asserts the p95 gate
//     (software WebGL there measures the rasterizer, not the app) — recorded in the protocol.
//   * Certification (PERF_CERT=1): wait 300 s for the NATURAL freeze; assert completion === "natural"
//     BEFORE evaluating p95 ≤ 16.7 ms. A forced report is labeled and excluded from the verdict.
// RUNNER: apps/web/playwright.config.ts (production build via webServer; only the chromium project
// matches this file — firefox/webkit are grep-scoped to the evidence specs).
import { expect, test } from "@playwright/test";

test("A6 perf report: structure (+ certification: NATURAL completion + p95 gate)", async ({ page }, testInfo) => {
  const cert = process.env.PERF_CERT === "1";
  // Round 11 P1-9: Playwright's default per-test timeout is 30 s. The 240 s fixture +
  // warm-up + decode headroom requires an explicit longer timeout on the test itself —
  // a longer nested waitForEvent timeout does NOT extend the outer test timeout.
  test.setTimeout(cert ? 320_000 : 200_000);
  await page.goto("/play?chart=benchmark&fixtureAudio=long"); // T15 param scheme — separate identities
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing");
  // round 4 + round 11 P1-10: CI may force early (structure-only); certification WAITS for natural freeze.
  // The forced-report path registers its listener BEFORE calling forcePerfReport — otherwise
  // the report can be emitted before the listener starts waiting (the old code raced the event).
  // The log contract is explicit: `__w2` logs the report as `console.log("[perf] " + JSON.stringify(report))`
  // so `msg.text().replace("[perf] ", "")` is a parseable JSON string — not an arbitrary console object.
  const waitMs = cert ? 300_000 : 160_000;
  const reportPromise = page.waitForEvent("console", { predicate: (m) => m.text().startsWith("[perf]"), timeout: waitMs });
  const timedOut = await reportPromise.then(() => false).catch(() => true);
  if (timedOut && cert) {
    throw new Error("certification run never reached NATURAL freeze within 300 s — protocol requires natural completion; forced reports are excluded from the verdict");
  }
  let msg: import("@playwright/test").ConsoleMessage;
  if (timedOut) {
    // Register the listener BEFORE forcing the report (round 11 P1-10): the report fires
    // synchronously from forcePerfReport, so a listener armed after the call can miss it.
    const forcedPromise = page.waitForEvent("console", { predicate: (m) => m.text().startsWith("[perf]"), timeout: 10_000 });
    await page.evaluate(() => (window as never as { __w2: { forcePerfReport(): void } }).__w2.forcePerfReport());
    msg = await forcedPromise;
  } else {
    msg = await reportPromise;
  }
  const report = JSON.parse(msg.text().replace("[perf] ", "")) as {
    p95FrameIntervalMs: number; inputLatencySamples: number; heapUsedMB: number | null;
    tail: { over16_7Count: number; over16_7Share: number; p99FrameIntervalMs: number; maxFrameIntervalMs: number };
    samples: { frames: number }; pass: boolean; completion: "natural" | "forced";
  };
  // Frame-count floor: the FROZEN protocol (evidence-templates/w3-perf-protocol.md) fixes the CI
  // structure check at `samples.frames > 5000`. Derivation: the CI force-cap window is 160 s and
  // the protocol discards the first PERF_WARMUP_MS (5 s) of frames, so ≥155 s of frames are
  // measured — 5000 frames over that window means the render loop averaged ≥ ~32 fps. It is a
  // STRUCTURE floor (the loop actually ran), not a performance gate; the p95 gate below is that.
  expect(report.samples.frames).toBeGreaterThan(5000);
  expect(report.tail).toBeDefined();
  expect(report.completion).toBeDefined();
  expect(report.p95FrameIntervalMs).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(report.tail.over16_7Share)).toBe(true);
  expect(report.inputLatencySamples).toBeGreaterThanOrEqual(0); // A13 present
  // Attach BEFORE the certification assertions (T16 fix): a RED cert run throws at the gate below,
  // and an attach placed after that throw never reaches the Playwright artifact — the numbers then
  // had to be scraped from the trace. Every cert run now leaves its report behind.
  testInfo.attach("perf-report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  if (cert) {
    expect(report.completion).toBe("natural");          // protocol match BEFORE the verdict (round 4)
    expect(report.p95FrameIntervalMs).toBeLessThanOrEqual(16.7); // THE GATE (report.pass must equal this)
    expect(report.pass).toBe(true);
  }
});
