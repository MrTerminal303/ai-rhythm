// e2e/w3-context-loss.spec.ts
// W3 T10 (A7): WebGL context loss takes the standard pause path; restore+resume preserves
// score/position. Simulated via the WEBGL_lose_context extension (gl.getExtension +
// loseContext/restoreContext) — the same event path a real GPU/context loss drives.
//
// The brief's "short" hold fixture does not exist in this tree (neither w1 nor benchmark
// charts contain holds), so the D7 flush-then-freeze assertion is exercised with a LIVE
// tap judgment on lane 1 (t=1500, note id 1 in w1-chart.json): pressing "f" at t≈1500 hits
// the tap, adds lane 1 to heldLanesRef; the context loss triggers enterPause("paused")
// whose flushHeldLanesBeforePause releases that lane BEFORE clock.pause (D7 order).
import { expect, test } from "@playwright/test";

type W2 = {
  phase(): string;
  chartTimeMs(): number;
};

test("context loss takes the standard pause path; restore preserves score/combo/position (A7)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: W2 }).__w2?.phase() === "playing");

  // live tap on lane 1 (t=1500, w1-chart note id 1): judge it, keep the key held so
  // heldLanesRef contains lane 1 when the context is lost — D7 flush releases it pre-pause
  await page.waitForFunction(() => (window as never as { __w2: W2 }).__w2.chartTimeMs() >= 1490);
  await page.keyboard.down("f");
  await page.waitForFunction(() => {
    const w = (window as never as { __w2: W2 }).__w2;
    return w.chartTimeMs() > 1560; // past the tap's judgement window
  });

  const scoreBefore = await page.locator('[data-testid="score"]').textContent();
  // real webglcontextlost event via the extension — the renderer's preventDefault allows restore.
  // The extension object is captured ONCE, in the same evaluate that loses the context: after
  // loss the live context returns null from getExtension until restore (a fresh evaluate would
  // re-fetch it and get null).
  await page.evaluate(() => {
    const gl = (document.querySelector("canvas") as HTMLCanvasElement).getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_lose_context")!;
    window.__a7 = { ext, canvas: document.querySelector("canvas") as HTMLCanvasElement };
    ext.loseContext();
  });
  await page.waitForFunction(() => (window as never as { __w2?: W2 }).__w2?.phase() === "paused");
  // D7 ordering: the held lane's release ran BEFORE clock.pause — release the key for real
  await page.keyboard.up("f");

  const pausedChart = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.chartTimeMs());
  await page.waitForTimeout(600);
  const stillPaused = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.chartTimeMs());
  expect(stillPaused).toBe(pausedChart); // audio clock frozen on loss

  // wait for the REAL webglcontextrestored event before resuming — listen on the CANVAS
  // (the element the real events dispatch on); the extension object was captured at loss
  // (a fresh getExtension call after loss returns null until the context is restored)
  await page.evaluate(() => new Promise<void>((resolve) => {
    const { canvas, ext } = (window as { __a7: { ext: { restoreContext(): void }; canvas: HTMLCanvasElement } }).__a7;
    canvas.addEventListener("webglcontextrestored", () => resolve(), { once: true });
    ext.restoreContext();
  }));
  await page.getByRole("button", { name: /click to resume/i }).click();
  await page.waitForFunction(
    () => (window as never as { __w2?: W2 }).__w2?.phase() === "playing",
    undefined,
    { timeout: 10_000 },
  );
  const after = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.chartTimeMs());
  expect(after).toBeGreaterThanOrEqual(stillPaused - 1); // position preserved, not restarted
  expect(after).toBeLessThan(stillPaused + 3000);
  const scoreAfter = await page.locator('[data-testid="score"]').textContent();
  expect(scoreAfter).toBe(scoreBefore); // score preserved (no reset)
});
