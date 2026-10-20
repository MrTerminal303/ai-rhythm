// e2e/w3-journey-library.spec.ts
// W3 T26 — spec §7 journey 2: the LIBRARY journey, end to end with REAL AUDIO asserted.
//
//   import → reload → /library lists the song with real metadata → Play →
//   while `playing`: (a) the expected signal is PRESENT IN THE PLAYBACK GRAPH — the
//   analyser tapped on the master gain reads RMS > 0.01 for N consecutive samples, and
//   a negative control shows the same probe reads < 0.001 with master volume at 0;
//   (b) |chartTime − playbackPosition| ≤ 10 ms on every sample (chart-clock consistency)
//   → the song ENDS → results overlay → back to the library.
//
// WHAT THIS IS: audio-path / real-browser workflow verification, NOT physical audibility.
// The tap is pre-DAC (AnalyserNode on the master GainNode inside startGame), so it proves
// the decoded stored asset reached the playback graph. Acoustic certification needs the
// loopback method (spec §7, deferred to W11) and is NOT claimed here.
import { expect, test } from "@playwright/test";
import {
  analyserSamples,
  chartWithoutAudio,
  clockDeltas,
  importSong,
  readStore,
  shot,
  startRun,
  waitCompleted,
} from "./journey-helpers";

const RMS_PRESENT = 0.01; // positive assertion (brief Step 3): real signal in the graph
const RMS_SILENT = 0.001; // negative control ceiling: silence must read as silence
const CLOCK_TOLERANCE_MS = 10; // chart-clock consistency bound (brief journey 2)

test("journey 2: library lists the real song → play → analyser RMS > 0 + clock consistent → results → back", async ({
  page,
}) => {
  // short.osu's 71 notes end at t=29.5 s; the engine freezes 110 ms later — the whole
  // journey fits well inside the config's 180 s per-test budget.
  const chartId = await importSong(page);

  // ---- Library: a RELOAD first (the row must come from storage, not from import-page state).
  await page.reload();
  await page.goto("/library");
  await expect(page.getByTestId("library-list")).toBeVisible();
  const row = page.locator('[data-testid="library-row"]', {
    has: page.locator(`a[href="/play?libraryChartId=${chartId}"]`),
  });
  await expect(row).toHaveCount(1);
  // Real metadata rendered from the stored canonical chart.
  await expect(row).toContainText("short");
  await expect(row).toContainText("W3 Fix");
  await expect(row).toContainText("71 notes");
  await expect(row).toContainText(/NPS/);
  await expect(row.getByTestId("unplayable-badge")).toHaveCount(0);
  await shot(page, "w3-journey-2-library.png");
  // The stored pair is still consistent after the round trip.
  expect(chartWithoutAudio(await readStore(page))).toEqual([]);

  await row.locator(`a[href="/play?libraryChartId=${chartId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/play\\?libraryChartId=${chartId}$`), { timeout: 30_000 });

  // ---- Negative control first (silence reads as silence): master volume 0 through the
  // REAL /settings control (the app's own setSetting writes the envelope), then a run.
  await page.goto("/settings");
  await page.getByTestId("setting-masterVolume").fill("0");
  await page.goto(`/play?libraryChartId=${chartId}`);
  await startRun(page);
  // Let the signal path settle past the countdown, then sample the SAME probe.
  // The control window STARTS AT THE SAME chart time as the positive window below (1000 ms)
  // — a quiet first second would otherwise make the negative control pass trivially.
  await page.waitForFunction(
    () => {
      const w = (window as unknown as { __w2?: { chartTimeMs(): number } }).__w2;
      return (w?.chartTimeMs() ?? 0) > 1000;
    },
    undefined,
    { timeout: 30_000 },
  );
  const silent = await analyserSamples(page, 10);
  for (const rms of silent) expect(rms).toBeLessThan(RMS_SILENT);
  const silentMax = Math.max(...silent);

  // ---- Restore the real master volume (same control) and run the play phase for real.
  await page.goto("/settings");
  await page.getByTestId("setting-masterVolume").fill("1");
  await page.goto(`/play?libraryChartId=${chartId}`);
  await startRun(page);
  await page.waitForFunction(
    () => {
      const w = (window as unknown as { __w2?: { chartTimeMs(): number } }).__w2;
      return (w?.chartTimeMs() ?? 0) > 1000;
    },
    undefined,
    { timeout: 30_000 },
  );

  // (a) signal present: 10 consecutive frame-spaced samples all show real energy.
  const loud = await analyserSamples(page, 10);
  expect(loud).toHaveLength(10);
  for (const rms of loud) {
    expect(Number.isFinite(rms)).toBe(true);
    expect(rms).toBeGreaterThan(RMS_PRESENT);
  }
  // (b) chart clock vs playback position: bounded on every sample.
  const deltas = await clockDeltas(page, 10);
  for (const d of deltas) expect(d).toBeLessThanOrEqual(CLOCK_TOLERANCE_MS);
  // Measured values for the evidence checklist (the assertions above are the gate).
  console.log(
    `[w3-journey-2] silentMaxRms=${silentMax.toFixed(6)} (ceiling ${RMS_SILENT}) · ` +
      `loudMinRms=${Math.min(...loud).toFixed(6)} loudMaxRms=${Math.max(...loud).toFixed(6)} ` +
      `(floor ${RMS_PRESENT}) · maxClockDeltaMs=${Math.max(...deltas).toFixed(3)} (bound ${CLOCK_TOLERANCE_MS})`,
  );
  await shot(page, "w3-journey-2-playing.png");

  // ---- The song ends on its own → results → back to the library.
  await waitCompleted(page, 90_000);
  await expect(page.getByTestId("results-score")).not.toBeEmpty();
  await expect(page.getByTestId("results-rank")).not.toBeEmpty();
  await shot(page, "w3-journey-2-results.png");
  await page.getByRole("link", { name: /back to library/i }).click();
  // The results overlay's link targets `/` (a pre-existing label, not changed here).
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/library");
  await expect(page.locator('[data-testid="library-row"]')).toHaveCount(1);
});
