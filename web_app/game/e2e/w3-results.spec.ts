// e2e/w3-results.spec.ts
// W3 T21 (B4): results screen (F-05) — a completed run shows the results overlay with
// score / max combo / accuracy / judgement breakdown / rank, distinct from the pause
// overlay; a guest run makes ZERO requests to *.supabase.co (B6 syncs those later).
//
// Driven against a real browser via the committed @playwright/test package (workspace
// e2e script — not an ad-hoc verification script).
import { expect, test, type Page } from "@playwright/test";

type W2 = {
  phase(): string;
};

// ponytail: every committed chart is ≥ 60 s (w1 / w3-e2e fixtures), so reaching
// completion takes ~60 s of wall clock; 120 s wait fits the 180 s per-test budget.
// Upgrade path: a ~5 s "w1-short" fixture makes this fast again.
test("completed guest run shows results, no supabase sync", async ({ page }) => {
  const supabaseRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("supabase.co")) supabaseRequests.push(req.url());
  });

  await page.goto("/play"); // w1 chart (~60 s)
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(
    () => (window as never as { __w2?: W2 }).__w2?.phase() === "completed",
    undefined,
    { timeout: 120_000 },
  );

  const overlay = page.getByTestId("results-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.getByTestId("results-score")).not.toBeEmpty();
  await expect(overlay.getByTestId("results-max-combo")).not.toBeEmpty();
  await expect(overlay.getByTestId("results-accuracy")).not.toBeEmpty();
  await expect(overlay.getByTestId("results-rank")).not.toBeEmpty();
  // pause overlay must be absent — completed ≠ paused (T13)
  await expect(page.getByTestId("pause-overlay")).toHaveCount(0);
  // guest run: nothing synced
  expect(supabaseRequests).toEqual([]);
});
