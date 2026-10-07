// e2e/w2-style-check.spec.ts — W2 T23 early style check (spec §6.5)
// Produces the 1920x1080 evidence PNG the operator judges ("clean minimal", not
// "cartoon"). The verdict is a HUMAN gate: this spec only captures; the committed
// report template carries `Verdict: PENDING OPERATOR` until the operator answers.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("style check capture: highway + notes + HUD + panels at 1920x1080", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as any).__w2?.phase() === "playing");
  await page.waitForTimeout(2500); // notes well into scroll, HUD populated

  // cwd is apps/web when run via `pnpm --filter @airhythm/web exec playwright test` —
  // resolve to the workspace-root evidence/ dir (gitignored), same rationale as
  // w1-highway.spec.ts resolving ../../e2e/screenshots/
  const evidencePath = path.resolve(process.cwd(), "../../evidence/task-style-check.png");
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  await page.screenshot({ path: evidencePath });

  await expect(page.getByTestId("highway")).toBeVisible();
});
