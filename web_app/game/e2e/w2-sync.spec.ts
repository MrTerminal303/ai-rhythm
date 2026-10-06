// apps/web/src/engine/audio-clock.ts
import { expect, test } from "@playwright/test";

test("clock-bookkeeping invariant: chartTime ≡ playbackPosition (+offset) within 10 ms over ≥60 frames", async ({ page }) => {
  // LAYER 1 of the ±10 ms acceptance (spec §4.7): audio/chart-clock bookkeeping only — both values
  // derive from ctx.currentTime, so this catches offset/restart bugs, NOT speaker perception.
  // Layer 3 (perceptual proof) is the operator slow-mo procedure in T24.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.getByRole("button", { name: /start/i }).click().catch(() => {}); // countdown may be implicit
  await page.waitForFunction(() => (window as any).__w2?.phase() === "playing");
  await page.waitForTimeout(1000); // let audio run past decode + lead
  const samples = await page.evaluate(async () => {
    const out: number[] = [];
    for (let i = 0; i < 60; i++) {
      const w = (window as any).__w2;
      out.push(Math.abs(w.chartTimeMs() - w.playbackPositionMs()));
      await new Promise((r) => requestAnimationFrame(r));
    }
    return out;
  });
  expect(samples.length).toBe(60);
  for (const d of samples) expect(d).toBeLessThanOrEqual(10);
});

test("tab blur pauses; resume after 3-2-1 continues from recorded position", async ({ page }) => {
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as any).__w2?.phase() === "playing");
  await page.waitForTimeout(1500);
  // Pre-blur chart time + blur dispatch share one JS tick, so the frozen-vs-before delta measures
  // the clock freeze itself, not Playwright cross-evaluate round-trip overhead (~150 ms under
  // trace recording). Synthetic blur: no input tool expresses tab blur.
  const before = await page.evaluate(() => {
    const b = (window as any).__w2.chartTimeMs();
    window.dispatchEvent(new Event("blur"));
    return b;
  });
  await page.waitForFunction(() => (window as any).__w2.phase() === "paused");
  await page.waitForTimeout(500);
  const frozen = await page.evaluate(() => (window as any).__w2.chartTimeMs());
  expect(frozen).toBeLessThan(before + 50); // chart time not advancing while paused
  await page.getByRole("button", { name: /click to resume/i }).click();
  await page.waitForFunction(() => (window as any).__w2.phase() === "playing", undefined, { timeout: 8000 }); // includes 3-2-1
  const after = await page.evaluate(() => (window as any).__w2.chartTimeMs());
  expect(after).toBeGreaterThanOrEqual(frozen - 1); // resumes from recorded position, not 0
  expect(after).toBeLessThan(frozen + 2000); // did not restart from 0 (which would be ~0)
});