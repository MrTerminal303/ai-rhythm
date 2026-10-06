import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("WebGL2 context exists, page is alive, then screenshot the highway", async ({ page }) => {
  // capture uncaught page errors BEFORE navigation — a React/renderer throw leaves a live
  // <canvas> with a valid WebGL2 context, so WebGL2 alone would pass on a blank page
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("/play");

  // Review Focus #5: the app sets data-webgl-ready ONLY after `new WebGLRenderer(...)`
  // succeeds (page.tsx) — waiting on it proves the game initialized, whereas this test's
  // own getContext() would return a valid context even if the app never did anything
  await expect(page.locator("canvas[data-webgl-ready='true']")).toBeVisible();

  // belt-and-braces: confirm the same canvas also exposes a live WebGL2 context
  const hasWebgl2 = await page.evaluate(() => {
    const canvas = document.querySelector("canvas[data-testid='highway']") as HTMLCanvasElement | null;
    if (!canvas) return "canvas missing";
    const gl = canvas.getContext("webgl2");
    return gl ? "ok" : "webgl2 context null (no GPU/SwiftShader)";
  });
  expect(hasWebgl2, `WebGL2 pre-flight failed: ${hasWebgl2}`).toBe("ok");
  expect(pageErrors, `uncaught page errors on /play: ${pageErrors.join(" | ")}`).toEqual([]);

  // HUD mounted and shows 0 before any judgement (snapshot-less default too)
  await expect(page.getByTestId("score")).toHaveText("0");

  // W2 T8: play starts behind a click-to-start gesture (autoplay policy) — start it,
  // then let the audio clock run so notes are mid-highway (~2.5 s after playing)
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as any).__w2?.phase() === "playing");
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("highway")).toBeVisible();

  // cwd is apps/web when run via the package script — resolve explicitly to the repo e2e dir;
  // mkdir because e2e/screenshots/ does not exist on a clean checkout (git ignores empty dirs)
  const screenshotPath = path.resolve(process.cwd(), "../../e2e/screenshots/w1-highway.png");
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: false });
});
