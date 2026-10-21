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
  // Value assertions (final review F24): the old `not.toBeEmpty()` accepted ANY text, so a
  // field that rendered the WRONG value (e.g. results-max-combo rendering the score) passed.
  // This run is the seeded one: a guest plays the 60-tap w1 chart with NO lane input, so every
  // note auto-misses — maxCombo 0, score 0, accuracy 0.0%, rank D, and MISS == the chart's note
  // count (read from the app, not hardcoded). Each field is asserted by its EXACT rendered text
  // (label + value), and max-combo is additionally pinned NOT to render the score.
  const noteCount = await page.evaluate(
    () => (window as never as { __w2?: { noteCount(): number } }).__w2?.noteCount() ?? 0,
  );
  expect(noteCount).toBeGreaterThan(0);
  await expect(overlay.getByTestId("results-score")).toHaveText("Score 0");
  await expect(overlay.getByTestId("results-max-combo")).toHaveText("Max combo 0");
  await expect(overlay.getByTestId("results-accuracy")).toHaveText("Accuracy 0.0%");
  await expect(overlay.getByTestId("results-rank")).toHaveText("D");
  await expect(overlay.getByTestId("results-breakdown")).toHaveText(
    `PERFECT 0 · GREAT 0 · GOOD 0 · MISS ${noteCount}`,
  );
  // the field the review named: max-combo must not be the score's value under the score's label
  await expect(overlay.getByTestId("results-max-combo")).not.toContainText("Score");
  await expect(overlay.getByTestId("results-score")).not.toContainText("combo");
  // pause overlay must be absent — completed ≠ paused (T13)
  await expect(page.getByTestId("pause-overlay")).toHaveCount(0);
  // guest run: nothing synced, and no sync error (nothing was attempted)
  expect(supabaseRequests).toEqual([]);
  await expect(page.getByTestId("run-sync-error")).toHaveCount(0);

  // W3 T23 (B6): a run-sync failure is a REAL visible state on the results screen, carrying the
  // runId it belongs to. Seeded through the auth module's E2E seam (same pattern as the
  // calibrate page's) because reaching the real path needs a live Supabase project; the
  // retry/backoff that produces it is proven in src/auth/auth.test.ts.
  await page.evaluate(() => {
    (window as never as { __authTest?: { forceRunSyncError(e: unknown): void } }).__authTest?.forceRunSyncError({
      runId: "e2e-run-sync-failure",
      message: "Score sync failed — will not retry this run. Saved locally only.",
    });
  });
  const syncError = page.getByTestId("run-sync-error");
  await expect(syncError).toBeVisible();
  await expect(syncError).toHaveAttribute("data-run-id", "e2e-run-sync-failure");
  await expect(syncError).toContainText("unverified personal history");

  // it clears (the user is not stuck with a stale notice) — the same path a later successful
  // sync takes
  await page.evaluate(() => {
    (window as never as { __authTest?: { forceRunSyncError(e: unknown): void } }).__authTest?.forceRunSyncError(null);
  });
  await expect(syncError).toHaveCount(0);
});
