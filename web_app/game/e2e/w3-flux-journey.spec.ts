// e2e/w3-flux-journey.spec.ts
// W3 T25 (B8b): spec §7 journey 6 — the flux-v1 journey.
//
//   real song (long.webm, audio only) → /import Generate → chart in the library →
//   Play → the RESULTS screen is reached → back to library → Generate the SAME file
//   again → the resulting chart hash equals the first one.
//
// This is the WHOLE fallback loop, playable end to end: the chart the generator
// produces is the chart the library stores and the play page plays.
//
// TIMEOUT: `test.setTimeout(320_000)` — the 240 s long.webm play-through to the
// results screen exceeds Playwright's 30 s per-test default (Round 11 P1-9). A
// nested `waitForFunction` timeout does NOT extend the outer test timeout, so the
// outer budget is raised here.
//
// HASH COMPARISON (phase 3) — the field actually compared:
//   the stored chart record's `audioHash` (the content address of the audio asset
//   the chart was generated from) and its `chartHash` (the canonical-chart digest).
//   The seeded generator derives the lane seed from
//   `SHA-256(canonical JSON({audioHash, generationOptions, generatorId, generatorVersion}))`,
//   so the same audio bytes + the same options must yield a byte-identical chart.
//   The record is read straight from the T18 IndexedDB store (the same store the
//   library page lists) — a READ, never a synthesized input event.
//
// INPUT: every gesture uses the real Playwright locators (`setInputFiles`,
// `click`, `waitForFunction`) — never a synthesized `page.evaluate` event.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const PUB = path.join(__dirname, "..", "apps", "web", "public", "songs");
const LONG_WEBM = path.join(PUB, "long.webm");

type W2Timing = {
  phase(): string;
};

/** The chart record the T18 library store holds for `chartId`. */
type StoredChart = { chartId: string; audioHash: string; chartHash: string; noteCount: number };

/** Evidence PNG path (the gitignored `apps/web/evidence/` dir — the same dir the
 *  B6 evidence files live in). cwd is `apps/web` when the spec runs through
 *  `pnpm --filter @airhythm/web exec playwright test`. */
function evidencePath(name: string): string {
  const p = path.resolve(process.cwd(), "evidence", name);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/** Upload long.webm on /import and click Generate; returns the resulting chartId. */
async function generateChart(page: Page): Promise<string> {
  await page.goto("/import");
  await page.setInputFiles('[data-testid="import-audio-input"]', {
    name: "long.webm",
    mimeType: "video/webm",
    buffer: readFileSync(LONG_WEBM),
  });
  await expect(page.getByTestId("audio-selected")).toBeVisible();
  // NO chart file — journey 6 generates the chart, it does not import one.
  const generate = page.getByTestId("generate-button");
  await expect(generate).toBeEnabled();
  await generate.click();
  // The progress surface is captured while the run is in flight (it is removed once
  // the run settles, so the shot has to be taken during the run).
  await expect(page.getByTestId("generate-progress")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: evidencePath("w3-b8-flux-journey-01-generating.png") });
  await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 120_000 });
  // The success block says the chart was GENERATED (not imported) — the two paths
  // share the boundary but not the wording.
  await expect(page.getByTestId("import-summary")).toHaveText("Chart generated.");
  const playLink = page.getByRole("link", { name: /^play$/i });
  const href = (await playLink.getAttribute("href")) ?? "";
  if (!href.startsWith("/play?libraryChartId=")) {
    throw new Error(`expected Play link on the ?libraryChartId= scheme, got ${href}`);
  }
  return href.slice("/play?libraryChartId=".length);
}

/** Read the stored chart record for `chartId` from the page's own store seam. */
async function readStoredChart(page: Page, chartId: string): Promise<StoredChart> {
  return page.evaluate(async (id: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("duelbeat-library", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const tx = db.transaction(["charts"], "readonly");
      const store = tx.objectStore("charts");
      const rec = await new Promise<StoredChart | undefined>((resolve, reject) => {
        const r = store.get(id);
        r.onsuccess = () => resolve(r.result as StoredChart | undefined);
        r.onerror = () => reject(r.error);
      });
      if (!rec) throw new Error(`no stored chart for ${id}`);
      return rec;
    } finally {
      db.close();
    }
  }, chartId);
}

test("flux-v1 journey: generate from a real song → library → play → results → identical re-generate", async ({
  page,
}) => {
  // The 240 s play-through to the results screen exceeds the 30 s default.
  test.setTimeout(320_000);

  // ---- Phase 1: /import → Generate (audio only) → the chart is persisted.
  const chartId = await generateChart(page);
  expect(chartId.length).toBeGreaterThan(0);
  const first = await readStoredChart(page, chartId);
  expect(first.noteCount).toBeGreaterThan(0);

  // ---- Phase 2: /library lists the generated song → Play → the results overlay.
  await page.goto("/library");
  await expect(page.getByTestId("library-list")).toBeVisible();
  const row = page.locator('[data-testid="library-row"]', { hasText: "Generated chart" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(`a[href="/play?libraryChartId=${chartId}"]`)).toHaveCount(1);
  await page.screenshot({ path: evidencePath("w3-b8-flux-journey-03-library.png") });

  await row.locator(`a[href="/play?libraryChartId=${chartId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/play\\?libraryChartId=${chartId}$`), { timeout: 30_000 });
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(
    () => (window as never as { __w2?: W2Timing }).__w2?.phase() === "playing",
    undefined,
    { timeout: 60_000 },
  );
  // The generated chart is the chart that plays (never the click track).
  await expect
    .poll(
      async () => page.evaluate(() => (window as never as { __w2?: W2Timing }).__w2?.noteCount()),
      { timeout: 30_000 },
    )
    .toBe(first.noteCount);
  // The run reaches the results screen (the whole fallback loop is playable).
  await page.waitForFunction(
    () => (window as never as { __w2?: W2Timing }).__w2?.phase() === "completed",
    undefined,
    { timeout: 280_000 },
  );
  await expect(page.getByTestId("results-overlay")).toBeVisible();
  await expect(page.getByTestId("results-rank")).not.toBeEmpty();
  await page.screenshot({ path: evidencePath("w3-b8-flux-journey-02-results.png") });
  // Back out of the results screen through its OWN link (the results overlay's
  // "Back to library" link targets the landing route `/` — a pre-existing app
  // label, not something this journey changes), then open the library itself.
  await page.getByRole("link", { name: /back to library/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/library");
  await expect(page.locator('[data-testid="library-row"]')).toHaveCount(1);

  // ---- Phase 3: generate the SAME file again → the seeded chart is identical.
  const secondId = await generateChart(page);
  const second = await readStoredChart(page, secondId);
  expect(second.audioHash).toBe(first.audioHash); // same audio bytes → same content hash
  expect(second.chartHash).toBe(first.chartHash); // same seeded chart → byte-identical
  expect(second.noteCount).toBe(first.noteCount);
});
