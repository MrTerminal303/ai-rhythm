// e2e/w3-settings.spec.ts
// W3 T22 (B5): the settings→playfield contract. Edits land on the /settings route (each
// control writes its envelope immediately — local-first), survive a reload, and reach the
// running game. The playfield assertion reads the renderer's own `__w2.appliedPresentation()`
// readback (the presentation opts the instance resolved), never a screenshot — a picture of
// a note can't distinguish a scroll-speed change from a paused frame.
//
// Driven against a real browser via the committed @playwright/test package (workspace e2e
// script — not an ad-hoc verification script). Input goes through the real input APIs
// (fill / check), never synthesized dispatchEvent.
import { expect, test } from "@playwright/test";

type W2 = {
  phase(): string;
  appliedPresentation(): { scrollSpeed: number; downscroll: boolean };
};

test("settings round-trip: scroll speed + downscroll persist across a reload", async ({ page }) => {
  await page.goto("/settings");
  const scroll = page.getByTestId("setting-scrollSpeed");
  await expect(scroll).toBeVisible();
  await scroll.fill("1.3"); // real input on the range control → the page writes its envelope
  await page.getByTestId("setting-downscroll").check();

  await page.reload();
  await expect(page.getByTestId("setting-scrollSpeed")).toHaveValue("1.3");
  await expect(page.getByTestId("setting-downscroll")).toBeChecked();
});

test("play reflects the saved scroll speed + downscroll", async ({ page }) => {
  // Save distinct-from-default values (defaults: scrollSpeed 0.5, downscroll false).
  await page.goto("/settings");
  await page.getByTestId("setting-scrollSpeed").fill("1.3");
  await page.getByTestId("setting-downscroll").check();

  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  // Start the run so startGame's setPresentation path runs too, then read the applied opts.
  await page.waitForFunction(
    () => (window as never as { __w2?: W2 }).__w2?.phase() === "playing",
    undefined,
    { timeout: 120_000 },
  );
  const applied = await page.evaluate(
    () => (window as never as { __w2: W2 }).__w2.appliedPresentation(),
  );
  expect(applied.scrollSpeed).toBeCloseTo(1.3, 5);
  expect(applied.downscroll).toBe(true);
});
