// e2e/w3-resync.spec.ts
// W3 T7 (A11): page-level device-change continuity — the unit tests in resync.test.ts prove the
// transition table, but only the real page proves a forced device change leaves score and
// judgements untouched when alignment holds, and that a discontinuous jump takes the game to
// the recovery pause instead of guessing a chart-time correction.
//
// "Judgements unchanged" is measured as the HUD SCORE (hits only; auto-misses never add score)
// plus the D21 input-probe buffer length (inputErrorLog) — neither changes on a device change
// because the resync machine never touches the engine (brief: `__w2.dts()` length + HUD score
// identical before/after). Combo/accuracy are NOT asserted: auto-missed notes legitimately
// reset them while the game keeps playing.
import { expect, test } from "@playwright/test";

type W2 = {
  phase(): string;
  chartTimeMs(): number;
  inputErrorLog(): unknown[];
  simulateDeviceChange(fakeJump?: boolean): Promise<boolean>;
};

type HudState = { score: string; probeLen: number };

const hudState = async (page: import("@playwright/test").Page): Promise<HudState> => {
  return page.evaluate(() => {
    const w = (window as { __w2?: W2 }).__w2;
    const score = document.querySelector('[data-testid="score"]')?.textContent ?? "";
    return { score, probeLen: w ? w.inputErrorLog().length : -1 };
  });
};

test("A11 continuity holds: device change while playing keeps the game playing with no chart jump", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: W2 }).__w2?.phase() === "playing");
  await page.waitForTimeout(1000); // past the audio lead-in; judgement windows are live

  const before = await hudState(page);
  const chartBefore = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.chartTimeMs());

  // continuity-holds variant: the shared handler body measures one frame of real Δchart/Δwall
  // and dispatches alignment-ok — the game stays playing.
  const enteredRecovery = await page.evaluate(async () =>
    (window as never as { __w2: W2 }).__w2.simulateDeviceChange(false),
  );
  expect(enteredRecovery).toBe(false);

  const phase = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.phase());
  expect(phase).toBe("playing");

  const chartAfter = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.chartTimeMs());
  // no chart-time jump: the measurement interval spans one rAF (~16 ms); allow generous slack
  // for the cross-evaluate round trip, but far below the 100 ms continuity threshold
  expect(chartAfter).toBeGreaterThanOrEqual(chartBefore);
  expect(chartAfter).toBeLessThan(chartBefore + 2000);

  const after = await hudState(page);
  expect(after).toEqual(before); // score + input-probe buffer identical — the machine never touched the engine
  // device-toast fires on alignment-ok (latency may have shifted — hint recalibrate)
  await expect(page.getByTestId("device-toast")).toBeVisible();
});

test("A11 continuity lost: a discontinuous chart jump enters the recovery pause with score preserved", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: W2 }).__w2?.phase() === "playing");
  await page.waitForTimeout(1000);

  const before = await hudState(page);

  // discontinuity variant: the handler injects a 500 ms fake chart jump → |Δchart − Δwall| > 100
  // → alignment-lost → recovery pause (flush-then-freeze ordering, D7)
  const enteredRecovery = await page.evaluate(async () =>
    (window as never as { __w2: W2 }).__w2.simulateDeviceChange(true),
  );
  expect(enteredRecovery).toBe(true);

  await page.waitForFunction(() => (window as never as { __w2?: W2 }).__w2?.phase() === "recovering");

  const frozen = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.chartTimeMs());
  const frozenAgain = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.chartTimeMs());
  expect(frozenAgain).toBe(frozen); // clock actually froze — no chart-time advance in recovery

  const during = await hudState(page);
  expect(during).toEqual(before); // HUD state preserved across the recovery pause
  await expect(page.getByTestId("recovering-overlay")).toBeVisible();

  // resume path: user-resume → 3-2-1 → clock.start(pausedAt) → alignment-ok → playing
  await page.getByRole("button", { name: /resume/i }).click();
  await page.waitForFunction(
    () => (window as never as { __w2?: W2 }).__w2?.phase() === "playing",
    undefined,
    { timeout: 8000 },
  );
  const after = await page.evaluate(() => (window as never as { __w2: W2 }).__w2.chartTimeMs());
  expect(after).toBeGreaterThanOrEqual(frozen - 1); // resumed from the recorded position, not 0
  expect(after).toBeLessThan(frozen + 2000);
});
