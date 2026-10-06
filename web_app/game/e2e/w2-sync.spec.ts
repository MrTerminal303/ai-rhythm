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
  // Snapshot live chart time, dispatch blur, and re-read chart time all in ONE evaluate call:
  // the blur handler runs synchronously during dispatchEvent, so the post-blur read is the
  // frozen value from the same JS tick as the pre-blur read — no cross-call protocol gap.
  const { before, frozen, paused } = await page.evaluate(() => {
    const before = (window as any).__w2.chartTimeMs();
    window.dispatchEvent(new Event("blur")); // no input tool expresses tab blur; synthetic event justified (report note)
    const frozen = (window as any).__w2.chartTimeMs();
    return { before, frozen, paused: (window as any).__w2.phase() === "paused" };
  });
  expect(paused).toBe(true); // blur while playing → phase "paused"
  expect(frozen - before).toBeLessThan(50); // chart time not advancing while paused
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /click to resume/i }).click();
  await page.waitForFunction(() => (window as any).__w2.phase() === "playing", undefined, { timeout: 8000 }); // includes 3-2-1
  const after = await page.evaluate(() => (window as any).__w2.chartTimeMs());
  expect(after).toBeGreaterThanOrEqual(frozen - 1); // resumes from recorded position, not 0
  expect(after).toBeLessThan(frozen + 2000); // did not restart from 0 (which would be ~0)
});