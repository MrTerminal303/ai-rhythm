import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Round 10 P1-6: sha256Hex is exported from db.js and used by the atomicity/quota tests
// to compute the expected audioHash without calling the implementation under test.
import { importChartWithAudio, getChart, listCharts, getAudioBytes, deleteChart, evictAudio, markDamaged, openLibraryDb, DB_NAME, SCHEMA_VERSION, sha256Hex } from "./db.js";

// Round 11 P2-21: validChart references the EXACT existing shared fixture — read
// packages/shared/src/beatmap-fixtures.ts (or the file T18's test file already
// imports for chart literals) and use its exported minimal-beatmap constant.
// Do not use a pseudo-object; the test must be runnable verbatim.
// SUBSTITUTION (report §concerns): @airhythm/shared/beatmap-fixtures does not exist;
// the exact existing valid beatmap literal in this tree is apps/web/fixtures/w1-chart.json
// (parseBeatmap-valid, 60 s, taps only — asserted in fixtures.test.ts). It is imported
// through the repo-established JSON fixture pattern (with { type: "json" }), same shape as
// fixtures.test.ts. The dedup tests' `{ ...validChart, song: {...} }` copies remain valid.
import validChart from "../../fixtures/w1-chart.json" with { type: "json" }; // a Beatmap literal accepted by parseBeatmap
const audioA = new Uint8Array([1, 2, 3, 4]).buffer;
const audioB = new Uint8Array([9, 8, 7]).buffer;
const meta = { durationMs: 30_000, sampleRate: 44_100, channels: 1 };
// Round 12 P1-4: importA() is a test-local closure that routes through testDb
// (set in beforeEach). It does NOT use the default DB_NAME.
let testDb: IDBDatabase;
const importA = () => importChartWithAudio({ chart: validChart, audioBytes: audioA, audioMeta: meta }, testDb);

describe("B1 store round-trip", () => {
  // Review P0 + round 10 P2-8 + round 11 P1-8: per-test isolation via a store instance
  // that owns an explicit DB name. The operations below (importChartWithAudio, getChart,
  // listCharts, getAudioBytes) all open the DEFAULT DB_NAME unless a name is passed —
  // so a unique testDbName alone has no effect. Instead:
  //   • openLibraryDb(testDbName) returns the isolated connection;
  //   • the store API must be re-exported or parameterised so tests route through it.
  // The cleanest contract: `importChartWithAudio` and all read/delete operations accept
  // an optional `db?: IDBDatabase` parameter (default = openLibraryDb() with DB_NAME).
  // In tests, pass the isolated connection explicitly. Round 12 P1-4: EVERY test
  // operation below routes through `testDb` — including `deleteChart`, `evictAudio`,
  // `getAudioForChart`, and the dedup test — no helper falls back to the default DB.
  let dbCounter = 0;
  let testDbName: string;
  beforeEach(async () => {
    dbCounter++;
    testDbName = `duelbeat-library-test-${dbCounter}`;
    testDb = await openLibraryDb(testDbName);
  });
  afterEach(async () => {
    testDb.close();
  });

  // All test operations below use the isolated `testDb` explicitly.
  // Example (adapted for each test):
  //   importChartWithAudio({ chart, audioBytes, audioMeta }, testDb)
  //   getChart(id, testDb)
  //   listCharts(testDb)
  //   getAudioBytes(hash, testDb)
  //
  // Round 11 P1-8: add a cross-test isolation assertion:
  it("writes to the isolated test DB are INVISIBLE in a second isolated DB", async () => {
    const r = await importChartWithAudio({ chart: validChart, audioBytes: audioA, audioMeta: meta }, testDb);
    // Open a second isolated DB and confirm the chart is NOT there
    const otherDb = await openLibraryDb(`duelbeat-library-isolation-check`);
    const rec = await getChart(r.chartId, otherDb);
    expect(rec).toBeUndefined(); // isolation confirmed
    otherDb.close();
  });

  it("add → get: distinct audio/chart hashes recorded, schema version present", async () => {
    const r = await importChartWithAudio({ chart: validChart, audioBytes: audioA, audioMeta: meta }, testDb);
    expect(r.audioHash).not.toBe(r.chartHash); // both hashes stored (W5 SongIdentity = rename)
    const rec = await getChart(r.chartId, testDb);
    expect(rec?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(rec?.audioHash).toBe(r.audioHash);
    expect(rec?.durationMs).toBe(validChart.song.durationMs); // ChartRecord holds beatmap.song.durationMs
    expect((await getAudioBytes(r.audioHash, testDb))?.byteLength).toBe(4);
  });

  it("ATOMICITY: forced tx abort rolls back BOTH stores — no chart row AND no audio row for the failed hash", async () => {
    // Round 11 P1-8: the monkey-patch throws a synchronous error inside the tx.
    // The implementation MUST catch that error and call tx.abort() explicitly —
    // a thrown JS error does not automatically abort an IndexedDB transaction.
    // The assertion below proves both stores rolled back; if the implementation
    // omits the explicit abort, the audio row would survive and the test fails.
    const origPut = IDBObjectStore.prototype.put;
    let armed = true;
    try {
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
        if (armed && args[0] && typeof args[0] === "object" && "chartId" in (args[0] as object)) {
          armed = false;
          throw new Error("injected put failure");
        }
        return origPut.apply(this, args);
      };
      await expect(
        importChartWithAudio({ chart: validChart, audioBytes: audioB, audioMeta: meta }, testDb)
      ).rejects.toThrow();
    } finally {
      IDBObjectStore.prototype.put = origPut; // always restore (review P0)
    }
    const bHash = await sha256Hex(audioB);
    expect(await getAudioBytes(bHash, testDb)).toBeUndefined(); // audio row rolled back too
    const charts = await listCharts(testDb);
    expect(charts.some((c) => c.audioHash === bHash)).toBe(false);
  });

  it("duplicate audio import dedups (same bytes → same hash, refCount grows)", async () => {
    const a = await importA();
    const b = await importChartWithAudio({ chart: { ...validChart, song: { ...validChart.song, songKey: "second" } }, audioBytes: audioA, audioMeta: meta }, testDb);
    expect(b.audioHash).toBe(a.audioHash);
    expect(b.dedupedAudio).toBe(true);
  });

  it("deleting one chart keeps audio another still references; refcount eviction refuses while referenced", async () => {
    const a = await importA();
    const b = await importChartWithAudio({ chart: { ...validChart, song: { ...validChart.song, songKey: "b" } }, audioBytes: audioA, audioMeta: meta }, testDb);
    await deleteChart(a.chartId, testDb);
    expect(await getAudioBytes(a.audioHash, testDb)).toBeDefined(); // shared audio survived
    await expect(evictAudio(a.audioHash, testDb)).rejects.toThrow(/still referenced/);
    await deleteChart(b.chartId, testDb);
    await evictAudio(a.audioHash, testDb);
    expect(await getAudioBytes(a.audioHash, testDb)).toBeUndefined();
  });

  it("corruption after successful import → markDamaged → listed as damaged (separate state)", async () => {
    const r = await importA();
    await markDamaged(r.chartId, testDb);
    expect((await getChart(r.chartId, testDb))?.state).toBe("damaged");
  });

  it("fresh-context persistence: close, reopen, still there", async () => {
    const r = await importA();
    testDb.close();
    const reopened = await openLibraryDb(testDbName);
    expect(await getChart(r.chartId, reopened)).toBeDefined();
    reopened.close();
  });

  it("quota failure → LibraryQuotaError, no partial rows", async () => {
    const origPut = IDBObjectStore.prototype.put;
    try {
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
        if (args[0] && typeof args[0] === "object" && "audioHash" in (args[0] as object)) {
          const e = new Error("quota") as Error & { name: string };
          e.name = "QuotaExceededError";
          throw e;
        }
        return origPut.apply(this, args);
      };
      await expect(importChartWithAudio({ chart: validChart, audioBytes: audioB, audioMeta: meta }, testDb)).rejects.toThrow(/Storage full|LibraryQuota/);
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
    expect(await getAudioBytes(await sha256Hex(audioB), testDb)).toBeUndefined();
    expect((await listCharts(testDb)).length).toBe(0);
  });

  it("store-level sample cap rejects direct callers that bypass the UI (round 4 P2-7)", async () => {
    // durationMs 600000 (10 min) × 48000 × 2ch = 57.6M estimated samples > 40M → reject pre-tx
    await expect(
      importChartWithAudio({
        chart: validChart,
        audioBytes: audioB,
        audioMeta: { durationMs: 600_000, sampleRate: 48_000, channels: 2 },
      }, testDb),
    ).rejects.toThrow(/sample cap|decoded/);
    expect(await getAudioBytes(await sha256Hex(audioB), testDb)).toBeUndefined(); // nothing written
    expect((await listCharts(testDb)).length).toBe(0);
  });
});
