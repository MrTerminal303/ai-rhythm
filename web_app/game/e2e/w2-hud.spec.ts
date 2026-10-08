import { expect, test, type Locator, type Page } from "@playwright/test";

// W2 design-review fix wave 4: F-08 (HUD collision <848px), F-04 (Esc + pause control), M-01 (favicon).

type Box = { x: number; y: number; width: number; height: number };

// Strict overlap: shared edges (gap === 0) do NOT count as intersection
function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `expected ${locator} to have a bounding box`).not.toBeNull();
  return box!;
}

async function startPlaying(page: Page): Promise<void> {
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as any).__w2?.phase() === "playing");
}

for (const viewport of [
  { width: 800, height: 600 },
  { width: 320, height: 560 },
]) {
  test(`F-08: HUD readouts never intersect D F J K indicators at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await startPlaying(page);
    const readouts = ["score", "accuracy", "combo"].map((id) => page.getByTestId(id));
    const keys = ["D", "F", "J", "K"].map((label) => page.locator(`[data-key="${label}"]`));
    for (const key of keys) {
      const kb = await boxOf(key);
      for (const readout of readouts) {
        const rb = await boxOf(readout);
        expect(
          intersects(rb, kb),
          `${viewport.width}x${viewport.height}: ${String(readout)} ${JSON.stringify(rb)} intersects key ${JSON.stringify(kb)}`,
        ).toBe(false);
      }
    }
    // same collision class, other side: F-04's top-left pause button vs the readouts
    const pauseBtn = page.getByTestId("pause-button");
    await expect(pauseBtn).toBeVisible(); // playing phase only
    const pb = await boxOf(pauseBtn);
    for (const readout of readouts) {
      const rb = await boxOf(readout);
      expect(
        intersects(rb, pb),
        `${viewport.width}x${viewport.height}: ${String(readout)} ${JSON.stringify(rb)} intersects pause-button ${JSON.stringify(pb)}`,
      ).toBe(false);
    }
  });
}

test("F-04: Escape pauses during play and resumes; pause button is user-invokable", async ({ page }) => {
  await startPlaying(page);
  // (a) Escape → paused (fails today: no Esc binding — 3 controller presses dead)
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (window as any).__w2?.phase() === "paused", undefined, { timeout: 5000 });
  await expect(page.getByTestId("pause-overlay")).toBeVisible();
  // Escape again → resume path: 3-2-1 countdown → playing
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (window as any).__w2?.phase() === "playing", undefined, { timeout: 8000 });
  // (b) visible pause control while playing
  await expect(page.getByTestId("pause-button")).toBeVisible();
  await page.getByTestId("pause-button").click();
  await page.waitForFunction(() => (window as any).__w2?.phase() === "paused", undefined, { timeout: 5000 });
  await expect(page.getByTestId("pause-overlay")).toBeVisible();
  // existing overlay resume affordance still works
  await page.getByRole("button", { name: /click to resume/i }).click();
  await page.waitForFunction(() => (window as any).__w2?.phase() === "playing", undefined, { timeout: 8000 });
});

test("M-01: page head carries an icon link (no /favicon.ico 404)", async ({ page }) => {
  const favicon404: string[] = [];
  page.on("response", (res) => {
    if (res.url().includes("favicon.ico") && res.status() === 404) favicon404.push(res.url());
  });
  await page.goto("/");
  await expect(page.locator('head link[rel="icon"]')).not.toHaveCount(0);
  expect(favicon404, `favicon.ico 404s: ${favicon404.join(", ")}`).toEqual([]);
});
