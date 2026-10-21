// e2e/w3-journey-persistence.spec.ts
// W3 T26 — spec §7 journey 3: the PERSISTENCE journey, plus the two failure variants.
//
// MECHANISM (Round 11 P1-16): Playwright's `browser.newContext()` contexts are ISOLATED —
// IndexedDB does NOT carry over between two of them. The claim under test is "survives a
// browser reload / restart with the same profile", so this spec carries the store across
// contexts with `browserContext.storageState({ indexedDB: true })` (Playwright ≥ 1.29
// includes IndexedDB in the snapshot) and seeds it into a SECOND, brand-new context.
// Phase 1 and phase 2 each assert the database name list contains `duelbeat-library` —
// the same DB name in both phases is part of the assertion, not an assumption.
//
// Variant (a) — corrupt asset: overwrite `audioAssets.bytes` with garbage in the page's own
// IndexedDB, reload → `listCharts`' verifying read re-hashes → the row flips to damaged:
// labelled unplayable and deletable (and the delete really removes it).
// Variant (b) — quota: `window.__forceQuota = true` (E2E-gated seam in library/db.ts) makes
// the audio put fail with a QuotaExceededError → /import must show `import-error` and leave
// NO partial record behind (consistency walk clean).
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  analyserSamples,
  chartWithoutAudio,
  dbNames,
  importSong,
  readStore,
  shot,
  startRun,
  DB_NAME,
} from "./journey-helpers";

const PUB = path.join(__dirname, "..", "apps", "web", "public", "songs");

/** The same positive threshold journey 2 uses (signal present in the playback graph). */
const RMS_PRESENT = 0.01;

/** Overwrite the stored audio bytes of `chartId` with garbage (a read/write on IDB state). */
async function corruptAudio(page: Page, chartId: string): Promise<void> {
  await page.evaluate(
    async ({ dbName, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const tx = db.transaction(["charts", "audioAssets"], "readwrite");
        const chartStore = tx.objectStore("charts");
        const audioStore = tx.objectStore("audioAssets");
        const rec = await new Promise<{ audioHash: string }>((resolve, reject) => {
          const r = chartStore.get(id);
          r.onsuccess = () => resolve(r.result as { audioHash: string });
          r.onerror = () => reject(r.error);
        });
        if (!rec) throw new Error(`no chart row for ${id}`);
        const asset = await new Promise<{ bytes: ArrayBuffer } | undefined>((resolve, reject) => {
          const r = audioStore.get(rec.audioHash);
          r.onsuccess = () => resolve(r.result as { bytes: ArrayBuffer } | undefined);
          r.onerror = () => reject(r.error);
        });
        if (!asset) throw new Error(`no audio asset for ${rec.audioHash}`);
        const garbage = new Uint8Array(asset.bytes.slice(0));
        for (let i = 0; i < garbage.length; i++) garbage[i] = (garbage[i]! ^ 0xff) & 0xff;
        audioStore.put({ ...asset, bytes: garbage.buffer });
        await new Promise<void>((resolve, reject) => {
          tx.addEventListener("complete", () => resolve());
          tx.addEventListener("abort", () => reject(tx.error ?? new Error("tx aborted")));
        });
      } finally {
        db.close();
      }
    },
    { dbName: DB_NAME, id: chartId },
  );
}

test("journey 3: import → storageState(indexedDB) → new context → still listed and still playable", async ({
  browser,
  page,
}) => {
  const chartId = await importSong(page);
  const before = await readStore(page);
  const chartBefore = before.charts.find((c) => c.chartId === chartId);
  if (!chartBefore) throw new Error("import did not persist the chart");
  expect(await dbNames(page)).toContain(DB_NAME);

  // `indexedDB: true` is what makes the cross-context claim honest (see header).
  const state = await page.context().storageState({ indexedDB: true });

  // ---- Phase 2: a BRAND-NEW context seeded from the snapshot (a restart with the same profile).
  const context = await browser.newContext({ storageState: state, baseURL: "http://localhost:3000" });
  const page2 = await context.newPage();
  try {
    // Navigate first: IndexedDB is DENIED in the blank/opaque origin of a fresh page, so
    // every IDB read below must run on the app origin.
    await page2.goto("/library");
    // Same database in both phases — asserted, not assumed.
    expect(await dbNames(page2)).toContain(DB_NAME);
    const after = await readStore(page2);
    expect(after.charts.map((c) => c.chartId)).toContain(chartId);
    expect(after.charts.find((c) => c.chartId === chartId)?.audioHash).toBe(chartBefore.audioHash);
    expect(chartWithoutAudio(after)).toEqual([]);

    // Still listed — and still PLAYABLE (journey 2's play assertions, briefly).
    const row = page2.locator('[data-testid="library-row"]', {
      has: page2.locator(`a[href="/play?libraryChartId=${chartId}"]`),
    });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("unplayable-badge")).toHaveCount(0);
    await row.locator(`a[href="/play?libraryChartId=${chartId}"]`).click();
    await startRun(page2);
    await page2.waitForFunction(
      () => {
        const w = (window as unknown as { __w2?: { chartTimeMs(): number } }).__w2;
        return (w?.chartTimeMs() ?? 0) > 1000;
      },
      undefined,
      { timeout: 30_000 },
    );
    const rms = await analyserSamples(page2, 10);
    for (const v of rms) expect(v).toBeGreaterThan(RMS_PRESENT);
    console.log(
      `[w3-journey-3] phase1Dbs=${(await dbNames(page)).length} phase2Dbs=${(await dbNames(page2)).length} ` +
        `sameDb=${(await dbNames(page2)).includes(DB_NAME)} restoredChartId=${chartId.slice(0, 8)}… ` +
        `restoredMinRms=${Math.min(...rms).toFixed(6)} (floor ${RMS_PRESENT})`,
    );
    await shot(page2, "w3-journey-3-restored-context.png");
  } finally {
    await context.close();
  }
});

test("variant (a): corrupt stored audio → damaged on reload → labelled unplayable → deletable", async ({
  page,
}) => {
  const chartId = await importSong(page);
  await corruptAudio(page, chartId);

  // The library's verifying read (listCharts) re-hashes the bytes → the row flips to damaged.
  await page.goto("/library");
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  const damagedRow = page.locator('[data-testid="library-row"]', { has: page.getByTestId("unplayable-badge") });
  await expect(damagedRow).toHaveCount(1);
  await expect(damagedRow.locator(`a[href="/play?libraryChartId=${chartId}"]`)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await shot(page, "w3-journey-3-damaged.png");

  // Deletable: the real confirm dialog accepted, the row is GONE from the store too.
  page.once("dialog", (dialog) => void dialog.accept());
  await damagedRow.getByRole("button", { name: /delete/i }).click();
  await expect(page.getByTestId("library-row")).toHaveCount(0);
  const store = await readStore(page);
  expect(store.charts.map((c) => c.chartId)).not.toContain(chartId);
  expect(chartWithoutAudio(store)).toEqual([]);
});

test("variant (b): forced quota failure → visible import-error, no partial record", async ({ page }) => {
  await page.goto("/import");
  // The E2E-gated fault seam (library/db.ts) — production builds have no such flag.
  await page.evaluate(() => {
    (window as unknown as { __forceQuota?: boolean }).__forceQuota = true;
  });
  // Import through the ordinary form; only the store's put behaviour differs.
  await page.setInputFiles('[data-testid="import-audio-input"]', {
    name: "short.webm",
    mimeType: "video/webm",
    buffer: readFileSync(path.join(PUB, "short.webm")),
  });
  await expect(page.getByTestId("audio-selected")).toBeVisible();
  await page.setInputFiles('[data-testid="import-file-input"]', {
    name: "short.osu",
    mimeType: "text/plain",
    buffer: readFileSync(path.join(PUB, "short.osu")),
  });
  await page.getByTestId("import-submit").click();

  const err = page.getByTestId("import-error");
  await expect(err).toBeVisible({ timeout: 30_000 });
  await expect(err).toHaveText(/storage full/i);
  await expect(page.getByTestId("import-done")).toHaveCount(0);
  await shot(page, "w3-journey-3-quota.png");
  // No partial record survived the aborted transaction.
  const store = await readStore(page);
  expect(store.charts).toEqual([]);
  expect(store.audioHashes).toEqual([]);
});
