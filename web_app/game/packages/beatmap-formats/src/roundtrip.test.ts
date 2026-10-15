import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsu, candidateFromParsed } from "./osu-import.js";
import { exportOsu, exportDbm, importDbm } from "./export.js";
import { canonicalizeBeatmap, canonicalJson } from "@airhythm/shared";

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");

for (const name of ["roundtrip-taps.osu", "roundtrip-holds-multibpm.osu", "roundtrip-meta.osu"]) {
  describe(`round-trip ${name} (§12.2)`, () => {
    it("import → canonical → export → import → canonical is idempotent", () => {
      const first = canonicalizeBeatmap(candidateFromParsed(parseOsu(fixture(name)), "file:missing-audio"));
      const exported = exportOsu(first, "track.mp3");
      const second = canonicalizeBeatmap({
        // cast: candidateFromParsed returns unknown (spread needs object type for tsc)
        ...(candidateFromParsed(parseOsu(exported), first.song.songKey) as object),
        song: { ...first.song }, // transport metadata pinned (duration derivation is deterministic but slacked +1)
      });
      // bpm: float double-reciprocal — compare to 1e-9; everything else byte-exact
      const strip = (b: typeof first) => JSON.parse(canonicalJson({ ...b, timing: b.timing.map((t) => ({ ...t, bpm: 0 })) }));
      expect(strip(second)).toEqual(strip(first));
      expect(second.timing.map((t) => t.bpm)).toHaveLength(first.timing.length);
      second.timing.forEach((t, i) => expect(t.bpm).toBeCloseTo(first.timing[i]!.bpm, 9));
      // metadata incl. Tags + PreviewTime round-trips exactly (roundtrip-meta.osu)
      expect(second.meta).toEqual(first.meta);
    });

    it("exported file re-parses as Mode 3 / CircleSize 4 (self-consistency)", () => {
      const first = canonicalizeBeatmap(candidateFromParsed(parseOsu(fixture(name)), "file:missing-audio"));
      const parsed = parseOsu(exportOsu(first, "track.mp3"));
      expect(parsed.mode).toBe(3);
      expect(parsed.circleSize).toBe(4);
      expect(parsed.warnings).toHaveLength(0); // A8: no drops remain — inherit/uninherited rows must be well-formed
    });
  });
}

describe(".dbm.json", () => {
  it("export → import round-trips exactly", () => {
    const first = canonicalizeBeatmap(candidateFromParsed(parseOsu(fixture("roundtrip-taps.osu")), "file:x"));
    expect(canonicalJson(importDbm(exportDbm(first)))).toBe(canonicalJson(first));
  });
});
