// e2e/w3-import.spec.ts
// W3 T20 (B3): the durable upload flow on /import — audio file (.mp3/.ogg/.wav/.m4a/.webm,
// ≤ 10 MB / ≤ 6 min per Q18) + chart file (.osu/.osz) → decodeAudioData caps →
// importChartWithAudio (T18 store) → success screen with a Play link to
// /play?libraryChartId=<id> + a Library link. Every rejection path renders
// data-testid="import-error" with the specific reason.
//
// Rewrites the orphan W2 spec e2e/w2-import.spec.ts (which drove the sessionStorage hand-off
// that T20 deletes). Fixtures: the committed short.osu + short.webm pair under
// apps/web/public/songs/ (the .osu's AudioFilename names short.webm, so the pair is
// self-consistent); the oversize case synthesizes an 11 MB buffer so the size gate fires
// BEFORE any decode; the corrupt chart is a real .osu with an illegal Mode.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const PUB = path.join(__dirname, "..", "apps", "web", "public", "songs");
const SHORT_OSU = path.join(PUB, "short.osu");
const SHORT_WEBM = path.join(PUB, "short.webm");

type W2Timing = {
  phase(): string;
  noteCount(): number;
};

/** Drive the /import form: pick audio + chart, submit, and return the Play link's chartId. */
async function importSong(page: Page): Promise<string> {
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
  await expect(page.getByTestId("import-done")).toBeVisible();
  // The Play link is the ?libraryChartId= scheme (T15) — never ?import= or ?chart=.
  const playLink = page.getByRole("link", { name: /^play$/i });
  const href = (await playLink.getAttribute("href")) ?? "";
  if (!href.startsWith("/play?libraryChartId=")) {
    throw new Error(`expected Play link on the ?libraryChartId= scheme, got ${href}`);
  }
  await expect(page.getByRole("link", { name: /^library$/i })).toHaveAttribute("href", "/library");
  return href.slice("/play?libraryChartId=".length);
}

test("upload short.osu + short.webm → success → Play runs the stored chart", async ({ page }) => {
  const chartId = await importSong(page);
  expect(chartId.length).toBeGreaterThan(0);
  await page.getByRole("link", { name: /^play$/i }).click();
  await expect(page).toHaveURL(new RegExp(`/play\\?libraryChartId=${chartId}$`), { timeout: 30_000 });
  // Start the run — the play page decodes the STORED short.webm bytes, not a click track.
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(
    () => (window as never as { __w2?: W2Timing }).__w2?.phase() === "playing",
  );
  // short.osu's 71 stored hit objects reach the play chart verbatim (canonical form keeps ids
  // unique; the importer drops no notes here).
  const notes = await page.evaluate(() => (window as never as { __w2: W2Timing }).__w2.noteCount());
  expect(notes).toBe(71);
});

test("oversize audio (> 10 MB) → visible actionable error, no import", async ({ page }) => {
  await page.goto("/import");
  // 11 MB of zeros, named .webm: the size gate fires before any decode, so the payload is never
  // decoded — only its declared size matters.
  const oversize = new Uint8Array(11 * 1024 * 1024);
  await page.setInputFiles('[data-testid="import-audio-input"]', {
    name: "big.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(oversize),
  });
  const err = page.getByTestId("import-error");
  await expect(err).toBeVisible();
  await expect(err).toHaveText(/too large/i);
  await expect(page.getByTestId("import-done")).toHaveCount(0);
});

test("wrong-extension chart → visible error naming the type", async ({ page }) => {
  await page.goto("/import");
  await page.setInputFiles('[data-testid="import-audio-input"]', {
    name: "short.webm",
    mimeType: "video/webm",
    buffer: readFileSync(SHORT_WEBM),
  });
  await page.setInputFiles('[data-testid="import-file-input"]', {
    name: "chart.txt",
    mimeType: "text/plain",
    buffer: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  });
  const err = page.getByTestId("import-error");
  await expect(err).toBeVisible();
  await expect(err).toHaveText(/unsupported chart type/i);
  await expect(page.getByTestId("import-done")).toHaveCount(0);
});

test("corrupt .osu (illegal Mode) → error naming the reason", async ({ page }) => {
  await page.goto("/import");
  await page.setInputFiles('[data-testid="import-audio-input"]', {
    name: "short.webm",
    mimeType: "video/webm",
    buffer: readFileSync(SHORT_WEBM),
  });
  // Mode 0 (osu!) — parseOsu rejects it with its verbatim A8 message (mode is not 3).
  const badOsu = readFileSync(SHORT_OSU).toString("utf8").replace("Mode: 3", "Mode: 0");
  await page.setInputFiles('[data-testid="import-file-input"]', {
    name: "broken.osu",
    mimeType: "text/plain",
    buffer: Buffer.from(badOsu),
  });
  const err = page.getByTestId("import-error");
  await expect(err).toBeVisible();
  await expect(err).toHaveText(/osu!mania/i);
  await expect(page.getByTestId("import-done")).toHaveCount(0);
});

// Grep gate (brief Step 4): the W2 sessionStorage hand-off key is GONE from the app source.
// Assert it absent so a regression that re-introduces the path fails here.
test("the w2-import sessionStorage hand-off is removed from the app source", async () => {
  // This assertion runs in the node context (no page) — it pins the grep gate as an executable
  // check rather than a manual step. The source paths are resolved relative to the spec.
  // The search is scoped to apps/web/src — the APP source. A broader sweep would hit this
  // spec's own needle list (and the architecture doc, which documents the removed W2 shape
  // on purpose), so the scope is deliberately narrow: the gate is about app code.
  const srcDir = path.join(__dirname, "..", "apps", "web", "src");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readDir(dir)) {
      const full = path.join(dir, entry);
      if (isDir(full)) walk(full);
      else if (/\.(ts|tsx|js|jsx|json|css|html)$/.test(entry)) {
        const text = readFileSync(full, "utf8");
        if (text.includes("w2-import")) hits.push(full);
      }
    }
  };
  walk(srcDir);
  expect(hits, `expected no reference to the W2 hand-off, found: ${hits.join(", ")}`).toEqual([]);
});

// Minimal node:fs helpers kept inline (no extra deps): readdir + statSync-based directory check.
import { readdirSync, statSync } from "node:fs";
const readDir = (dir: string): string[] => readdirSync(dir);
const isDir = (full: string): boolean => statSync(full).isDirectory();
