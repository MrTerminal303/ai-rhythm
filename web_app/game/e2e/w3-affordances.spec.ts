// e2e/w3-affordances.spec.ts
// W3 T13 (A9): failure/recovery affordances —
//   * atlas fetch timeout → permanent fallback; the highway still renders (code-drawn path),
//     no unhandled rejection.
//   * start failure surfaces `start-error`, phase returns to `idle`, a second attempt with the
//     route restored succeeds.
//   * a completed run shows the results overlay (`results-overlay`), DISTINCT from `pause-overlay`.
//
// These are driven against a real browser via Playwright (the committed @playwright/test package,
// run by the workspace test scripts — not an ad-hoc verification script).
import { expect, test } from "@playwright/test";

type W2 = {
  phase(): string;
};

test("atlas timeout → permanent fallback, game still playable", async ({ page }) => {
  // A9: force the atlas route to be slow/blocked. The renderer's 5 s AbortController bound then
  // aborts the fetch and commits the permanent "fallback" state; the code-drawn highway path
  // (W2) keeps rendering. We assert the game reaches "playing" and the highway is visible, and
  // that the aborted fetch surfaces NO unhandled rejection on the page (the renderer consumes it).
  await page.route("**/atlas/**", async (route) => {
    await new Promise((r) => setTimeout(r, 8000)); // outlasts the renderer's 5 s bound
    await route.abort();
  });
  const unhandled: string[] = [];
  page.on("pageerror", (err) => unhandled.push(String(err)));
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing");
  await expect(page.getByTestId("highway")).toBeVisible(); // code-drawn fallback renders
  await page.waitForTimeout(2000); // give the 5 s abort window a moment to settle
  expect(unhandled).toEqual([]); // A9: the aborted atlas fetch never throws into gameplay
});

test("start failure surfaces startError and allows retry (A9)", async ({ page }) => {
  // Abort the click-track fetch so startGame's await chain throws → startError surfaced,
  // phase back to idle. Then restore the route and retry: the second attempt succeeds.
  await page.route("**/audio/click-track.wav", (route) => route.abort());
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await expect(page.getByTestId("start-error")).toBeVisible();
  await page.unroute("**/audio/click-track.wav");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing");
});

test("completed run shows results overlay, distinct from pause (A9; B4 fills it)", async ({ page }) => {
  // Drive a run to the engine freeze (chart end) → phase "completed" → results-overlay,
  // and the pause-overlay must NOT be present (they are visually distinct).
  // ponytail: the w1 fixture is 60 s long (freeze at ~59.6 s), so the 60 s waitForFunction
  // in the brief cannot fire before its own deadline. Ceiling: use the BENCHMARK chart
  // (?chart=benchmark) with a SHORT override if one exists; otherwise a 60 s chart is the
  // minimum the fixture supports. The test below waits 120 s — within Playwright's 180 s
  // per-test budget — so the ~60 s w1 run completes and the results overlay is asserted.
  // Upgrade path: add a "w1-short" fixture (~5 s) to make this assertion fast again.
  await page.goto("/play"); // w1 chart (~60 s) runs to freeze
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(
    () => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "completed",
    undefined,
    { timeout: 120_000 }, // w1 chart freezes at ~59.6 s; 120 s covers it within the 180 s test budget
  );
  await expect(page.getByTestId("results-overlay")).toBeVisible();
  await expect(page.getByTestId("pause-overlay")).toHaveCount(0);
});
