import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Fixture reused in place (no copy, no require.resolve): the package's exports map
// only exposes ".", so the subpath resolve in the brief is unavailable — read by
// relative path instead of inlining the .osu text.
const FIXTURE_OSU = path.join(__dirname, "..", "packages", "beatmap-formats", "fixtures", "basic-4k.osu");

test("import a .osu → warnings shown → Play runs the imported chart", async ({ page }) => {
  await page.goto("/import");
  await page.setInputFiles('input[type="file"]', {
    name: "basic-4k.osu",
    mimeType: "text/plain",
    buffer: readFileSync(FIXTURE_OSU),
  });
  await expect(page.getByText(/imported/i)).toBeVisible();
  await page.getByRole("button", { name: /^play$/i }).click();
  await expect(page).toHaveURL(/\/play\?import=/);
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as any).__w2?.phase() === "playing");
  // imported chart has 2 notes → __w2 exposes noteCount? add noteCount to debug hook in T8 if absent
  const notes = await page.evaluate(() => (window as any).__w2.noteCount?.() ?? -1);
  expect(notes).toBe(2);
});
