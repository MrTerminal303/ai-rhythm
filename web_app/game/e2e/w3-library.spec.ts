// e2e/w3-library.spec.ts
// W3 T19 (B2): local library page — list, play link, delete, unplayable labeling.
//
// Seeds the IndexedDB store through the page's OWN E2E hook (window.__lib.importForTest),
// gated on NEXT_PUBLIC_E2E=1 the same way __w2 is (playwright.config.ts webServer env
// inlines it into the production build the spec hits). The page renders rows, badges and
// links from the verifying listCharts — the corrupt-audio path proves the badge is the
// hash-flipped state, not a manual markDamaged.
//
// The seam's importForTest accepts a pre-built beatmap object + audio bytes. The e2e
// builds both on the page side using a public asset (w3-e2e-audio.wav) and a committed
// beatmap fixture (w3-e2e-chart.json served under public/), so no node-side fs is needed
// in the browser process. Each seed variant mutates the fetched bytes first (xor a
// suffix-dependent mask) so every chart lands on a DISTINCT audioHash — corrupting one
// asset's bytes must flip only that row's badge, never a sibling sharing the hash.
import { expect, test } from "@playwright/test";

async function seedChart(page: import("@playwright/test").Page, suffix: string): Promise<string> {
  return page.evaluate(async (sfx: string) => {
    const hook = (window as {
      __lib?: {
        importForTest(
          chart: unknown,
          audioBytes: ArrayBuffer,
          audioMeta?: { durationMs: number; sampleRate: number; channels: number },
        ): Promise<string>;
      };
    }).__lib;
    if (!hook) throw new Error("window.__lib seam absent — is NEXT_PUBLIC_E2E=1 in the build?");
    // Beatmap: committed fixture served by the dev server (public/w3-e2e-chart.json).
    const res = await fetch("/w3-e2e-chart.json");
    if (!res.ok) throw new Error(`cannot fetch /w3-e2e-chart.json: ${res.status}`);
    const chart: Record<string, unknown> = await res.json();
    (chart.song as Record<string, unknown>).songKey = `w3-e2e-${sfx}`;
    // Audio: real 8 kHz mono WAV fixture served at /w3-e2e-audio.wav (public/), masked
    // per suffix → distinct audioHash per seeded chart (see header).
    const audio = await fetch("/w3-e2e-audio.wav");
    if (!audio.ok) throw new Error(`cannot fetch /w3-e2e-audio.wav: ${audio.status}`);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const mask = 0x40 + sfx.charCodeAt(0); // 'a'→0x46, 'b'→0x47 — distinct, non-zero
    for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ mask;
    return hook.importForTest(chart, bytes.buffer, { durationMs: 60_000, sampleRate: 8_000, channels: 1 });
  }, suffix);
}

test("library list, unplayable labeling, delete, and play-link target", async ({ page }) => {
  // Fresh context → empty store → empty state visible first
  await page.goto("/library");
  await expect(page.getByTestId("library-empty")).toBeVisible();
  await expect(page.getByRole("link", { name: /import a song/i })).toHaveAttribute("href", "/import");

  // Seed two charts through the page's own seam
  const idA = await seedChart(page, "a");
  const idB = await seedChart(page, "b");
  expect(idA).toBeTruthy();
  expect(idB).toBeTruthy();
  expect(idA).not.toBe(idB);

  // Reload → both rows present
  await page.reload();
  await expect(page.getByTestId("library-list")).toBeVisible();
  const rows = page.getByTestId("library-row");
  await expect(rows).toHaveCount(2);

  // Both rows carry a Play link pointing at ?libraryChartId= (T15 scheme, never ?chart=)
  const playLinks = page.locator('a[href^="/play?libraryChartId="]');
  await expect(playLinks).toHaveCount(2);
  for (const id of [idA, idB]) {
    await expect(page.locator(`a[href="/play?libraryChartId=${id}"]`)).toHaveCount(1);
  }
  // No row ever links via ?chart=benchmark
  await expect(page.locator('a[href*="chart=benchmark"]')).toHaveCount(0);

  // Corrupt B's stored audio bytes → the verifying list read must flip B to "damaged"
  // (badge + disabled Play), without any manual markDamaged call.
  await page.evaluate(async (chartId: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("duelbeat-library", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const tx = db.transaction(["charts", "audioAssets"], "readwrite");
      const chartStore = tx.objectStore("charts");
      const audioStore = tx.objectStore("audioAssets");
      const rec = await new Promise<{ audioHash: string }>((res, rej) => {
        const r = chartStore.get(chartId);
        r.onsuccess = () => res(r.result as { audioHash: string });
        r.onerror = () => rej(r.error);
      });
      if (!rec) throw new Error("chart record not found");
      const asset = await new Promise<{ bytes: ArrayBuffer; [k: string]: unknown } | undefined>((res, rej) => {
        const r = audioStore.get(rec.audioHash);
        r.onsuccess = () => res(r.result as { bytes: ArrayBuffer; [k: string]: unknown } | undefined);
        r.onerror = () => rej(r.error);
      });
      if (!asset) throw new Error("audio asset not found");
      const corrupted = new Uint8Array(asset.bytes.slice(0));
      corrupted[0] = corrupted[0]! ^ 0xff;
      audioStore.put({ ...asset, bytes: corrupted.buffer as ArrayBuffer });
      await new Promise<void>((res, rej) => {
        tx.addEventListener("complete", () => res());
        tx.addEventListener("abort", () => rej(tx.error ?? new Error("tx aborted")));
      });
    } finally {
      db.close();
    }
  }, idB);

  // Reload → B shows the unplayable badge, Play disabled; A is healthy
  await page.reload();
  await expect(page.getByTestId("library-list")).toBeVisible();
  await expect(page.getByTestId("unplayable-badge")).toHaveCount(1);
  const damagedRow = page.locator('[data-testid="library-row"]', { has: page.getByTestId("unplayable-badge") });
  await expect(damagedRow.locator(`a[href="/play?libraryChartId=${idB}"]`)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  // The healthy row's Play is NOT disabled
  await expect(page.locator(`a[href="/play?libraryChartId=${idA}"]`)).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );

  // Delete: accept the confirm dialog, remove B's row
  page.once("dialog", (dialog) => void dialog.accept());
  await damagedRow.getByRole("button", { name: /delete/i }).click();
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  await expect(page.getByTestId("unplayable-badge")).toHaveCount(0);
});

test("empty library shows import CTA (fresh context)", async ({ page }) => {
  // Playwright creates a fresh context per test — IndexedDB is clean
  await page.goto("/library");
  await expect(page.getByTestId("library-empty")).toBeVisible();
  await expect(page.getByRole("link", { name: /import a song/i })).toHaveAttribute("href", "/import");
});
