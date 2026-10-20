// apps/web/src/app/import/generate-boundary.test.ts
// W3 T25b fix r1: the boundary a GENERATED chart crosses before it is stored.
//
// The bug this pins: `page.tsx` handed `candidate.chart` straight to
// `importChartWithAudio`, which only `parseBeatmap`s. `assembleChart` (in
// `packages/chartgen/src/flux-v1.ts`) emits notes with NO `tier`, while every
// IMPORTED row carries `tier: "primary"` (canonical.ts fills it). The two
// origins produced different chartJson shapes — and so different chartHash
// conventions — which breaks cross-origin dedupe.
//
// The rows below assert the generated row's STORED chartJson uses the same
// convention as an imported row's, through the REAL store (importChartWithAudio)
// — the thing the reviewer named.
import "fake-indexeddb/auto";
import { canonicalizeBeatmap, canonicalJson, type Beatmap } from "@airhythm/shared";
import { generateCandidate, PINNED_PREPROC } from "@airhythm/chartgen";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import validChart from "../../../fixtures/w1-chart.json" with { type: "json" };
import { canonicalizeGeneratedChart } from "./generate-boundary.js";
import { importChartWithAudio, openLibraryDb, type ChartRecord } from "../../library/db.js";

const SR = PINNED_PREPROC.sr;

/** A deterministic mono PCM with a few transients — enough for a real flux run. */
function pcm(seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = Math.floor(t / 0.5);
    const sinceBeat = t - beat * 0.5;
    out[i] =
      0.6 * Math.sin(2 * Math.PI * 60 * sinceBeat) * Math.exp(-sinceBeat * 18) +
      0.05 * Math.sin(2 * Math.PI * 440 * t);
  }
  return out;
}

/** The chart the generator produces — the UN-canonicalized candidate chart. */
function generatedChart(): Beatmap {
  const mono = pcm(6);
  return generateCandidate(
    mono,
    { sampleRate: SR, durationMs: Math.round((mono.length * 1000) / SR) },
    { audioHash: "a".repeat(64), targetNps: 7, density: 0, seed: 12345 },
  ).chart;
}

/** The chart an IMPORTED row is stored as — the import path canonicalizes too. */
function importedChart(): Beatmap {
  return canonicalizeBeatmap(validChart);
}

let testDb: IDBDatabase | null = null;
let dbCounter = 0;

const META = { durationMs: 6_000, sampleRate: SR, channels: 1 };
const seedBytes = (): ArrayBuffer => new Uint8Array([1, 2, 3, 4]).buffer;

/** Store a chart through the REAL store and read back the stored record. */
async function store(chart: unknown): Promise<ChartRecord> {
  const { chartId } = await importChartWithAudio(
    { chart, audioBytes: seedBytes(), audioMeta: META },
    testDb ?? undefined,
  );
  const tx = testDb!.transaction("charts", "readonly");
  const rec = await new Promise<ChartRecord>((resolve, reject) => {
    const r = tx.objectStore("charts").get(chartId);
    r.onsuccess = () => resolve(r.result as ChartRecord);
    r.onerror = () => reject(r.error);
  });
  return rec;
}

describe("generated-chart boundary (W3 T25b fix r1)", () => {
  beforeEach(async () => {
    dbCounter++;
    testDb = await openLibraryDb(`duelbeat-generate-boundary-test-${dbCounter}`);
  });
  afterEach(() => {
    testDb?.close();
    testDb = null;
  });

  it("the RAW generated candidate has no `tier` on its notes (the bug's root)", () => {
    // This is the shape `assembleChart` emits — it must stay tier-less: the
    // package must not absorb a web-store rule (R24).
    const raw = generatedChart();
    expect(raw.notes.length).toBeGreaterThan(0);
    expect(raw.notes.every((n) => n.tier === undefined)).toBe(true);
  });

  it("the boundary fills `tier: primary` on EVERY generated note", () => {
    const stored = canonicalizeGeneratedChart(generatedChart());
    expect(stored.notes.length).toBeGreaterThan(0);
    for (const n of stored.notes) expect(n.tier).toBe("primary");
  });

  it("a generated row's STORED chartJson uses the same note convention as an imported row's", async () => {
    // THE bug's shape, checked on the REAL stored rows: every note of both
    // origins carries `tier`, and the per-kind key sets match.
    const genRec = await store(canonicalizeGeneratedChart(generatedChart()));
    const impRec = await store(importedChart());
    const genNotes = (JSON.parse(genRec.chartJson) as Beatmap).notes;
    const impNotes = (JSON.parse(impRec.chartJson) as Beatmap).notes;
    for (const n of [...genNotes, ...impNotes]) expect(n.tier).toBe("primary");

    // Per-KIND key sets must be identical: a tap and a hold in the generated row
    // must carry exactly the same keys as a tap and a hold in the imported row.
    const keySet = (notes: Beatmap["notes"], kind: string): string =>
      Object.keys(notes.find((n) => n.type === kind) ?? {}).sort().join(",");
    for (const kind of ["tap", "hold"]) {
      const genHas = genNotes.some((n) => n.type === kind);
      const impHas = impNotes.some((n) => n.type === kind);
      if (genHas && impHas) expect(keySet(genNotes, kind)).toBe(keySet(impNotes, kind));
    }
  });

  it("canonicalizing a generated chart twice is byte-identical (idempotent)", () => {
    // `canonicalJson` is the store's hash input (stableJson sorts keys), so it —
    // not `JSON.stringify` — is the string the chartHash is computed over.
    const once = canonicalizeGeneratedChart(generatedChart());
    const twice = canonicalizeGeneratedChart(once);
    expect(canonicalJson(twice)).toBe(canonicalJson(once));
  });

  it("the boundary is deterministic: the same candidate yields the same stored chart", async () => {
    const a = await store(canonicalizeGeneratedChart(generatedChart()));
    const b = await store(canonicalizeGeneratedChart(generatedChart()));
    expect(a.chartHash).toBe(b.chartHash);
    expect(a.chartJson).toBe(b.chartJson);
  });
});
