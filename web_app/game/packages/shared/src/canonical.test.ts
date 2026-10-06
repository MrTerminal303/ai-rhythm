import { describe, expect, it } from "vitest";
import { canonicalizeBeatmap, canonicalJson, hashBeatmap } from "./canonical.js";
// static JSON imports: shared package has no @types/node, so the brief's readFileSync
// loader fails typecheck; same fixture-import pattern as apps/web/src/fixtures.test.ts
import caseDefaults from "../fixtures/canonical/case-defaults.json" with { type: "json" };
import caseSort from "../fixtures/canonical/case-sort.json" with { type: "json" };
import caseTimingPulses from "../fixtures/canonical/case-timing-pulses.json" with { type: "json" };

const caseNames = ["case-defaults", "case-sort", "case-timing-pulses"] as const;
const fixtures: Record<(typeof caseNames)[number], { input: unknown; expected: string }> = {
  "case-defaults": caseDefaults,
  "case-sort": caseSort,
  "case-timing-pulses": caseTimingPulses,
};

describe("canonicalizeBeatmap — golden fixtures (§12.1)", () => {
  for (const caseName of caseNames) {
    it(`${caseName}: canonical bytes match golden exactly`, async () => {
      const { input, expected } = fixtures[caseName];
      const actual = canonicalJson(canonicalizeBeatmap(input));
      expect(actual).toBe(expected); // exact bytes — sorted keys, no whitespace
      expect(await hashBeatmap(actual)).toBe(await hashBeatmap(expected));
    });
  }

  it("regression pin: hash of case-defaults canonical bytes (fill after first green run)", async () => {
    const { input } = fixtures["case-defaults"];
    const h = await hashBeatmap(canonicalJson(canonicalizeBeatmap(input)));
    expect(h).toBe("0fa4ff607db7a6b18b73362f8d060eca0a4219b66151d6483da7999945e77e1e"); // pinned after first green run
  });
});

describe("canonicalizeBeatmap — behavior", () => {
  const base = {
    version: 1,
    meta: { title: "t", artist: "a", creator: "c", difficulty: "d", tags: [], previewMs: 0 },
    song: { songKey: "file:missing-audio", durationMs: 60_000, audioOffsetMs: 0 },
    timing: [{ t: 0, bpm: 120, meter: 4 }],
    keys: 4,
    notes: [],
    pulses: [],
    gen: { source: "import", importedFrom: "osu", timingSource: "imported" },
  };

  it("assigns tier=primary and reassigns ids 0..n-1 after (t,lane,type,tier,sourceId) sort", () => {
    const c = canonicalizeBeatmap({
      ...base,
      notes: [
        { id: 7, t: 200, lane: 3, type: "tap" }, // → sorted by t: first
        { id: 2, t: 100, lane: 1, type: "hold", d: 50 }, // t=100 first actually
        { id: 5, t: 200, lane: 3, type: "tap", tier: "secondary" },
      ],
    });
    expect(c.notes.map((n) => [n.t, n.lane, n.type, n.tier ?? "primary", n.id])).toEqual([
      [100, 1, "hold", "primary", 0],
      [200, 3, "tap", "primary", 1],
      [200, 3, "tap", "secondary", 2],
    ]);
  });

  it("rejects duplicate input ids BEFORE reassignment is trusted (schema superRefine)", () => {
    expect(() => canonicalizeBeatmap({ ...base, notes: [
      { id: 1, t: 10, lane: 0, type: "tap" },
      { id: 1, t: 20, lane: 1, type: "tap" },
    ] })).toThrow(/Duplicate note id/);
  });

  it("accepts valid-but-unsorted notes — canonicalization owns ordering (no caller pre-sort contract)", () => {
    const unsorted = {
      ...base,
      notes: [
        { id: 9, t: 300, lane: 2, type: "tap" },
        { id: 4, t: 100, lane: 0, type: "tap" },
        { id: 1, t: 200, lane: 1, type: "hold", d: 50 },
      ],
    };
    const c = canonicalizeBeatmap(unsorted);
    expect(c.notes.map((n) => n.t)).toEqual([100, 200, 300]);
    expect(c.notes.map((n) => n.id)).toEqual([0, 1, 2]);
  });

  it("orders t numerically across mixed digit counts (ruling: never string-compare numeric tuple fields)", () => {
    // string compare would invert: "1000" < "999"; numeric gives 999 first
    const c = canonicalizeBeatmap({
      ...base,
      notes: [
        { id: 0, t: 1000, lane: 0, type: "tap" },
        { id: 1, t: 999, lane: 0, type: "tap" },
        { id: 2, t: 1000, lane: 0, type: "tap" },
      ],
    });
    expect(c.notes.map((n) => [n.t, n.id])).toEqual([
      [999, 0], // numeric t ascending; sourceId 1 re-ids to 0
      [1000, 1], // t=1000 tie broken by earlier sourceId (0 before 2)
      [1000, 2],
    ]);
  });

  it("malformed external input fails with 'Invalid beatmap: …', never a TypeError", () => {
    expect(() => canonicalizeBeatmap({ ...base, notes: "nope" })).toThrow(/Invalid beatmap/);
    expect(() => canonicalizeBeatmap({ ...base, notes: [null, 42] })).toThrow(/Invalid beatmap/);
    expect(() => canonicalizeBeatmap({ notes: [{ t: "NaN-as-string" }] })).not.toThrow(TypeError);
    // NaN/Infinity t must be treated as structurally invalid (skip pre-sort → schema rejects),
    // never enter the sort stage where they would corrupt ordering
    expect(() => canonicalizeBeatmap({ ...base, notes: [{ id: 0, t: NaN, lane: 0, type: "tap" }] })).toThrow(/Invalid beatmap/);
    expect(() => canonicalizeBeatmap({ ...base, notes: [{ id: 0, t: Infinity, lane: 0, type: "tap" }] })).toThrow(/Invalid beatmap/);
  });

  it("any future string-ordered canonical structure uses code-unit compare (no locale)", () => {
    // covered structurally: canonicalJson key order + pulse k order both go through cmpStr/Object.keys.sort
    const withK = { ...base, pulses: [{ t: 0, s: 1, k: "Zebra" }, { t: 1, s: 1, k: "apple" }] };
    const c = canonicalizeBeatmap(withK);
    expect(c.pulses.map((p) => p.k)).toEqual(["Zebra", "apple"]); // code-unit: uppercase "Z"(90) < "a"(97)
  });

  it("hash never derives from content_hash — songKey sentinel passes through untouched", () => {
    const c = canonicalizeBeatmap(base);
    expect(c.song.songKey).toBe("file:missing-audio");
    expect(canonicalJson(c)).not.toContain("content_hash");
  });
});
