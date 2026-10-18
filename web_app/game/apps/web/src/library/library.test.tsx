// @vitest-environment node
// W3 T19 (B2): local library page — list, play link, delete, unplayable labeling.
//
// ENVIRONMENT DEVIATION (jsdom → node, see report §concerns): the T18 store hashes
// AudioBuffers through global `crypto.subtle.digest`. Under vitest's jsdom env,
// jsdom's realm objects (its ArrayBuffer/Uint8Array + its crypto) are installed
// over the globals, and Node's webcrypto rejects jsdom-realm bytes ("2nd argument
// is not instance of ArrayBuffer…") while jsdom's stub crypto has no working
// SubtleCrypto — so `listCharts` never resolves and the page hangs on Loading.
// The node env needs no patching (Node's webcrypto IS the global, ArrayBuffer is
// node-realm), and the T18 store works there end-to-end (db.test.ts proves it).
// The DOM globals RTL needs (document, window) are installed at module scope below
// via jsdom — Node crypto stays global, so the store's hashing path is unchanged.
//
// Store isolation (T18 pattern, adapted): the page's db-module calls are vi.mock'ed
// onto a per-test fake-indexeddb connection. The mock factory keeps `openLibraryDb`
// REAL — beforeEach opens a uniquely-named DB through the genuine factory; only
// the data functions (import/list/delete/getChart) get re-routed to the handle.
// This is why the page's verifying `listCharts` actually flips the damaged state
// in-store: corrupt the audio BYTES → the page's own list read flips it.
//
// The corrupt-audio path mutates the stored audio BYTES; the verifying listCharts
// (verifyAudio=true, called by the page itself) must flip the row to "damaged" —
// the badge is asserted from that hash-verified state, never a manual markDamaged
// (review P0).
//
// The page's module-scope seam (window.__lib.importForTest) is gated on
// process.env.NEXT_PUBLIC_E2E — flipped BEFORE importing the page, same pattern as
// calibrate-save.test.tsx.
// jsdom DOM for RTL, installed at module scope (node env keeps Node crypto global —
// the store's hash path, db.ts's crypto.subtle.digest, sees node-realm ArrayBuffers).
// fake-indexeddb/auto already registered its window stub before the real one; its
// indexedDB global is what the tests' `indexedDB.open` and the db module both use.
// Must run BEFORE @testing-library/react is imported: screen binds document at import.
// fake-indexeddb/auto registers its `indexedDB` global on the jsdom window it creates; the
// subsequent JSDOM install replaces window/document for RTL, and indexedDB (a global property
// set by fake-indexeddb) remains reachable as `globalThis.indexedDB`.
import "fake-indexeddb/auto";
import "./setup-dom.js";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import validChart from "../../fixtures/w1-chart.json" with { type: "json" };

process.env.NEXT_PUBLIC_E2E = "1";

// Per-test isolated handle; the mocked store API routes every data op through it.
// testDb is set by beforeEach and read live inside the mock factory closures, so
// the page's calls and the test's seed/corrupt calls hit the SAME fake store.
let testDb: IDBDatabase | null = null;

// The page's db-module calls are re-routed to the ISOLATED testDb so the page's
// own listCharts verify-flip actually mutates the store the tests read from.
// openLibraryDb stays the REAL factory so beforeEach's openLibraryDb(...) resolves
// to the genuine db.ts openLibraryDb (vi.mock keeps a real reference to it via
// importActual), and the testDb handle is the same one fake-indexeddb auto
// registered under `indexedDB`.
vi.mock("./db.js", async () => {
  const real = await vi.importActual<typeof import("./db.js")>("./db.js");
  return {
    ...real,
    importChartWithAudio: (input: Parameters<typeof real.importChartWithAudio>[0]) =>
      real.importChartWithAudio(input, testDb ?? undefined),
    listCharts: (dbArg?: IDBDatabase, opts?: { verifyAudio?: boolean }) =>
      real.listCharts(dbArg ?? testDb ?? undefined, opts),
    deleteChart: (id: string, dbArg?: IDBDatabase) => real.deleteChart(id, dbArg ?? testDb ?? undefined),
    getChart: (id: string, dbArg?: IDBDatabase) => real.getChart(id, dbArg ?? testDb ?? undefined),
    // markDamaged — the page does not call it (review P0); no override needed.
  };
});

import { openLibraryDb, importChartWithAudio, getChart, type ChartRecord } from "./db.js";
import LibraryPage from "../app/library/page.js";

const META = { durationMs: 60_000, sampleRate: 44_100, channels: 1 };
let dbCounter = 0;

// Node-realm seed bytes (Buffer-backed ArrayBuffer): the store round-trips and
// re-hashes the same object it stored, so content is deterministic per seed.
const seedBytes = (n: number, mod: number): ArrayBuffer => {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = (i * mod) % 251;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

async function seed(chart: unknown): Promise<{ chartId: string; audioHash: string }> {
  return importChartWithAudio({ chart, audioBytes: seedBytes(64, 1), audioMeta: META });
}

// Variant that uses a distinct mod value so the seed bytes (and therefore the
// SHA-256 audioHash) differ from `seed`'s — keeps the two rows on different
// audio assets, so corrupting one never flips the other.
async function seedWithMod(chart: unknown, mod: number): Promise<{ chartId: string; audioHash: string }> {
  return importChartWithAudio({ chart, audioBytes: seedBytes(64, mod), audioMeta: META });
}

async function corruptAudioBytes(audioHash: string): Promise<void> {
  // Corrupt the stored BYTES. The verifying listCharts (page-driven) must detect
  // the hash mismatch and flip the row to "damaged" — no manual markDamaged here.
  // The corruption seed mod must DIFFER from the mod that produced the stored
  // bytes; otherwise seedBytes(n, sameMod) reproduces identical content and the
  // hash check passes (no flip). The caller chooses a mod that is neither 1 (a's
  // seed mod) nor the b-row's own seed mod.
  const tx = testDb!.transaction("audioAssets", "readwrite");
  const store = tx.objectStore("audioAssets");
  const rec = await new Promise<unknown>((resolve, reject) => {
    const r = store.get(audioHash);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (!rec) throw new Error(`audio asset ${audioHash} not found`);
  const asset = rec as { audioHash: string; bytes: ArrayBuffer; [k: string]: unknown };
  // Use mod 7 for the corruption — distinct from both seed mods (1 and 9) used in
  // the corrupt test, and from the delete test's mods (1 and 7 → collision risk,
  // but delete test never corrupts, so it's safe).
  const corrupted = seedBytes(asset.bytes.byteLength, 7);
  const putReq = store.put({ ...asset, bytes: corrupted });
  await new Promise<void>((resolve, reject) => {
    putReq.onsuccess = () => resolve();
    putReq.onerror = () => reject(putReq.error);
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("abort")));
  });
  // Wait for the tx to fully commit so a subsequent listCharts (on the same
  // connection) sees the corrupted bytes — db.ts's txDone pattern.
  await new Promise<void>((resolve, reject) => {
    if (tx.error) { reject(tx.error); return; }
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("tx aborted")));
  });
}

async function rawRows(): Promise<ChartRecord[]> {
  const tx = testDb!.transaction("charts", "readonly");
  return new Promise<ChartRecord[]>((resolve, reject) => {
    const r = tx.objectStore("charts").getAll();
    r.onsuccess = () => resolve(r.result as ChartRecord[]);
    r.onerror = () => reject(r.error);
  });
}

const PLAY_SEL = "a[href^='/play?libraryChartId=']";

describe("B2 library page", () => {
  beforeEach(async () => {
    // Fresh isolated connection per test (fake-indexeddb is process-global; a
    // unique DB name guarantees no cross-test leak — db.test.ts's pattern).
    dbCounter++;
    testDb = await openLibraryDb(`duelbeat-library-page-test-${dbCounter}`);
  });
  afterEach(async () => {
    cleanup();
    testDb?.close();
    testDb = null;
  });

  it("empty library → 'No songs yet' + link to /import", async () => {
    render(<LibraryPage />);
    expect(await screen.findByTestId("library-empty")).toBeTruthy();
    const link = screen.getByRole("link", { name: /import a song/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/import");
  });

  it("list rows show title, difficulty, NPS, note count; Play uses ?libraryChartId= (never ?chart=)", async () => {
    const rec = await seed(validChart);
    render(<LibraryPage />);
    const row = await screen.findByTestId("library-row");
    expect(row.textContent).toContain("W1 Fixture"); // title
    expect(row.textContent).toContain("W1"); // difficulty
    expect(row.textContent).toContain("NPS");
    expect(row.textContent).toContain("60 notes"); // noteCount from fixture
    const play = row.querySelector(PLAY_SEL) as HTMLAnchorElement | null;
    expect(play, "Play link present").toBeTruthy();
    expect(play!.getAttribute("href")).toBe(`/play?libraryChartId=${rec.chartId}`);
    expect(row.querySelector('a[href*="chart=benchmark"]')).toBeNull(); // never ?chart=
    expect(row.querySelector('[data-testid="unplayable-badge"]')).toBeNull();
  });

  it("corrupt audio bytes → verifying listCharts flips state → unplayable badge + Play disabled, Delete enabled", async () => {
    await seed(validChart);
    // Distinct seed bytes for b: both rows share the SAME audioHash only when the
    // seed bytes are identical (sha256 of the bytes is the dedup key). Different
    // bytes → different audioHash → corrupting b's asset flips ONLY b's row.
    const b = await seedWithMod({ ...validChart, song: { ...validChart.song, songKey: "w3-b" } }, 9);
    // Confirm the seeded row is playable BEFORE corruption
    expect((await getChart(b.chartId))?.state).toBe("playable");
    await corruptAudioBytes(b.audioHash); // corrupt BYTES — the verifying read must flip it
    render(<LibraryPage />);
    const rows = await screen.findAllByTestId("library-row");
    expect(rows.length).toBe(2);
    const damaged = rows.find((el) => el.querySelector('[data-testid="unplayable-badge"]'));
    expect(damaged, "exactly one row carries the unplayable badge").toBeTruthy();
    // The STORE actually flipped b to damaged (via the page's verifying listCharts)
    const stored = await rawRows();
    expect(stored.find((r) => r.chartId === b.chartId)!.state).toBe("damaged");
    // Badge + disabled Play on the damaged row
    expect(damaged!.querySelector('[data-testid="unplayable-badge"]')).toBeTruthy();
    const playBtn = damaged!.querySelector(PLAY_SEL) as HTMLAnchorElement;
    expect(playBtn.getAttribute("aria-disabled")).toBe("true");
    // Healthy row: Play enabled, no badge
    const healthy = rows.find((el) => el !== damaged!)!;
    expect(healthy.querySelector('[data-testid="unplayable-badge"]')).toBeNull();
    expect(healthy.querySelector(PLAY_SEL)!.getAttribute("aria-disabled")).toBeNull();
    // Delete stays enabled on the damaged row
    const delBtn = damaged!.querySelector('button[type="button"]')!;
    expect(delBtn.hasAttribute("disabled")).toBe(false);
  });

  it("Delete (confirmed) removes the row; cancel keeps it", async () => {
    const a = await seed(validChart);
    const b = await seedWithMod({ ...validChart, song: { ...validChart.song, songKey: "w3-b" } }, 7);
    let confirmAnswer = false;
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => confirmAnswer);
    render(<LibraryPage />);
    await screen.findAllByTestId("library-row");
    // Identify b's row via its Play-link href (rows render in getAll() order, unspecified).
    const rows = await screen.findAllByTestId("library-row");
    const rowBEl = rows.find((el) =>
      el.querySelector(PLAY_SEL)?.getAttribute("href") === `/play?libraryChartId=${b.chartId}`,
    )!;
    const delB = rowBEl.querySelector('button[type="button"]')!;
    // Cancel first: b's row survives
    confirmAnswer = false;
    fireEvent.click(delB);
    await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(screen.getAllByTestId("library-row").length).toBe(2);
    // Now confirm: b's row is removed, a remains
    confirmAnswer = true;
    fireEvent.click(rowBEl.querySelector('button[type="button"]')!);
    await vi.waitFor(() => {
      expect(screen.getAllByTestId("library-row").length).toBe(1);
    });
    confirmSpy.mockRestore();
    const remaining = await rawRows();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.chartId).toBe(a.chartId); // b was deleted
  });

  it("window.__lib.importForTest seam is exposed under NEXT_PUBLIC_E2E", async () => {
    expect((window as { __lib?: unknown }).__lib, "__lib seam present").toBeTruthy();
    const hook = (window as {
      __lib: { importForTest(chart: unknown, audioBytes: ArrayBuffer): Promise<string> };
    }).__lib;
    const id = await hook.importForTest(validChart, seedBytes(64, 2));
    expect(typeof id).toBe("string");
    // The seam routes through the mocked module → the page's list sees the new row
    render(<LibraryPage />);
    const row = await screen.findByTestId("library-row");
    expect(row.textContent).toContain("W1 Fixture");
  });
});
