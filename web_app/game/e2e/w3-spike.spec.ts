import { expect, test } from "@playwright/test";

test("B7 spike runs end-to-end and REPORTS both parity numbers (verdicts recorded, not gated)", async ({ page }) => {
  await page.goto("/spike");
  await page.getByRole("button", { name: /run spike/i }).click();
  await expect(page.getByTestId("spike-done")).toBeVisible({ timeout: 120_000 });
  const melMae = Number(await page.getByTestId("mel-mae").textContent());
  const logitsDiff = Number(await page.getByTestId("logits-maxdiff").textContent());
  // experiment validity only (review P0 + spec §4 B7): finite measurements, correctly rendered.
  // PASS/FAIL vs the tolerances is DATA the report records — a genuine NO-GO must NOT fail W3's gate.
  expect(Number.isFinite(melMae)).toBe(true);
  expect(Number.isFinite(logitsDiff)).toBe(true);
  await expect(page.getByTestId("mel-verdict")).toHaveText(/PASS|FAIL/);
  await expect(page.getByTestId("logits-verdict")).toHaveText(/PASS|FAIL/);
  await expect(page.getByTestId("infer-ms")).toBeVisible(); // timing fields present for D26
  // round 3 P1-1: the analysis rate must be the pinned 22050, asserted before transfer.
  await expect(page.getByTestId("analysis-rate")).toHaveText("22050");
  // review round 2 P0: dynamic-T proof — the SAME session must run inference at BOTH lengths
  await expect(page.getByTestId("shape-short")).toHaveText(/^\(1,1,128,\d+\) -> \(1,\d+,1\)$/);
  await expect(page.getByTestId("shape-long")).toHaveText(/^\(1,1,128,\d+\) -> \(1,\d+,1\)$/);
  const tShort = Number((await page.getByTestId("shape-short").textContent())!.match(/-> \(1,(\d+),1\)/)![1]);
  const tLong = Number((await page.getByTestId("shape-long").textContent())!.match(/-> \(1,(\d+),1\)/)![1]);
  expect(tLong).toBeGreaterThan(tShort * 10); // genuinely different sequence lengths
});
