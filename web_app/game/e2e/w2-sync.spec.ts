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
