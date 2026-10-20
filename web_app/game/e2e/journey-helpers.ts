// e2e/journey-helpers.ts
// W3 T26 shared steps for the §7 journey specs. Not a spec itself (no tests registered) —
// Playwright only collects `*.spec.ts`, so this module is inert for `playwright test`.
//
// Every gesture here goes through a REAL Playwright locator (`setInputFiles`, `click`,
// `getByRole`). `page.evaluate` appears only where the journey must READ state: the T18
// IndexedDB store and the play page's `__w2` hook (analyser RMS / chart clock / playback
// position). No synthetic clicks, keys or file inputs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

const PUB = path.join(__dirname, "..", "apps", "web", "public", "songs");
export const SHORT_OSU = path.join(PUB, "short.osu");
export const SHORT_WEBM = path.join(PUB, "short.webm");

/** The play page's E2E hook (T26 adds `analyserRms`; the rest exist since W2/W3). */
export type W2 = {
  phase(): string;
  noteCount(): number;
  analyserRms(): number;
  chartTimeMs(): number;
  playbackPositionMs(): number;
};

/** The subset of the T18 chart record the journeys assert on. */
export type StoredChart = {
  chartId: string;
  title: string;
  difficulty: string;
  audioHash: string;
  chartHash: string;
  nps: number;
  noteCount: number;
  state: "playable" | "damaged";
};

export type StoredStore = { charts: StoredChart[]; audioHashes: string[] };

/** The library store name (apps/web/src/library/db.ts DB_NAME) — asserted equal across phases. */
export const DB_NAME = "duelbeat-library";

/**
 * Evidence screenshot under `e2e/screenshots/` (gitignored). `__dirname` is the e2e dir, so
 * the path is independent of the runner's cwd (the config is loaded from apps/web).
 */
export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(__dirname, "screenshots", name) });
}

/**
 * Import the committed short.osu + short.webm pair on /import and return the new chartId.
 * The fixtures are the same pair the import page tests use (the .osu's AudioFilename names
 * short.webm, so the pair is self-consistent).
 */
export async function importSong(page: Page): Promise<string> {
  await page.goto("/import");
  await page.setInputFiles('[data-testid="import-audio-input"]', {
    name: "short.webm",
    mimeType: "video/webm",
    buffer: readFileSync(SHORT_WEBM),
  });
  await expect(page.getByTestId("audio-selected")).toBeVisible();
  await page.setInputFiles('[data-testid="import-file-input"]', {
    name: "short.osu",
    mimeType: "text/plain",
    buffer: readFileSync(SHORT_OSU),
  });
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 60_000 });
  const href = (await page.getByRole("link", { name: /^play$/i }).getAttribute("href")) ?? "";
  if (!href.startsWith("/play?libraryChartId=")) {
    throw new Error(`expected a ?libraryChartId= Play link, got ${href}`);
  }
  return href.slice("/play?libraryChartId=".length);
}

/** Read both stores of the T18 library (charts + audio content hashes) from the page. */
export async function readStore(page: Page): Promise<StoredStore> {
  return page.evaluate(async (dbName: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const tx = db.transaction(["charts", "audioAssets"], "readonly");
      const charts = await new Promise<StoredChart[]>((resolve, reject) => {
        const r = tx.objectStore("charts").getAll();
        r.onsuccess = () => resolve(r.result as StoredChart[]);
        r.onerror = () => reject(r.error);
      });
      const audioHashes = await new Promise<string[]>((resolve, reject) => {
        const r = tx.objectStore("audioAssets").getAllKeys();
        r.onsuccess = () => resolve(r.result as string[]);
        r.onerror = () => reject(r.error);
      });
      return { charts, audioHashes };
    } finally {
      db.close();
    }
  }, DB_NAME);
}

/** Chart ids whose `audioHash` has NO `audioAssets` row — the atomicity/consistency walk. */
export function chartWithoutAudio(store: StoredStore): string[] {
  const hashes = new Set(store.audioHashes);
  return store.charts.filter((c) => !hashes.has(c.audioHash)).map((c) => c.chartId);
}

/** Names of the IndexedDB databases visible to the page (persistence: same DB in both phases). */
export async function dbNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
}

/** Press the real Start control and wait until the run is actually playing. */
export async function startRun(page: Page): Promise<void> {
  // The play page mounts the renderer inside `runMount`, which for the ?libraryChartId=
  // path runs only AFTER the async IndexedDB read resolves — so wait for the B6 readiness
  // signal (canvas.dataset.webglReady) before clicking, or the click can land before the
  // chart exists and startGame would fail with "play page not initialized".
  await page.locator('canvas[data-webgl-ready="true"]').waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(
    () => (window as unknown as { __w2?: W2 }).__w2?.phase() === "playing",
    undefined,
    { timeout: 60_000 },
  );
}

/** Wait for the run to complete and return the results overlay locator (asserted visible). */
export async function waitCompleted(page: Page, timeoutMs = 90_000): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __w2?: W2 }).__w2?.phase() === "completed",
    undefined,
    { timeout: timeoutMs },
  );
  await expect(page.getByTestId("results-overlay")).toBeVisible();
}

/** N consecutive `analyserRms()` readings, one per animation frame (sample spacing ≈ render cadence). */
export async function analyserSamples(page: Page, count: number): Promise<number[]> {
  return page.evaluate(async (n: number) => {
    const w = (window as unknown as { __w2?: W2 }).__w2;
    if (!w) throw new Error("window.__w2 seam absent — is NEXT_PUBLIC_E2E=1 in the build?");
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      out.push(w.analyserRms());
    }
    return out;
  }, count);
}

/** N samples of |chartTime − playbackPosition| (ms) — the chart-clock consistency measurement. */
export async function clockDeltas(page: Page, count: number): Promise<number[]> {
  return page.evaluate(async (n: number) => {
    const w = (window as unknown as { __w2?: W2 }).__w2;
    if (!w) throw new Error("window.__w2 seam absent — is NEXT_PUBLIC_E2E=1 in the build?");
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      out.push(Math.abs(w.chartTimeMs() - w.playbackPositionMs()));
    }
    return out;
  }, count);
}
