import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsu, candidateFromParsed } from "./osu-import.js";
import { canonicalizeBeatmap, canonicalJson } from "@airhythm/shared";

const fix = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");

// A8 (T11) helpers — all section-scoped: searches STOP at the next section
// header, never skip over one; every data-line search is bounded to its section.
function findSection(lines: string[], header: string): number {
  return lines.findIndex((l) => l.trim() === header);
}
function sectionEnd(lines: string[], sectionIdx: number): number {
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("[")) return i;
  }
  return lines.length;
}
function firstDataLineIn(lines: string[], sectionIdx: number): number {
  const end = sectionEnd(lines, sectionIdx);
  for (let i = sectionIdx + 1; i < end; i++) {
    if (lines[i]!.trim() !== "") return i;
  }
  return -1;
}
function findLineInSection(lines: string[], sectionIdx: number, pred: (f: string[]) => boolean): number {
  const end = sectionEnd(lines, sectionIdx);
  for (let i = sectionIdx + 1; i < end; i++) {
    const l = lines[i]!;
    if (l.trim() !== "" && pred(l.split(","))) return i;
  }
  return -1;
}

const baseOsu = () => fix("basic-4k.osu");

describe("parseOsu", () => {
  it("parses basic 4K: lanes, hold duration, timing bpm", () => {
    const p = parseOsu(fix("basic-4k.osu"));
    expect(p.mode).toBe(3); // osu!mania = Mode 3 (0=osu!, 1=taiko, 2=catch, 3=mania)
    expect(p.circleSize).toBe(4);
    expect(p.audioFilename).toBe("track.mp3");
    expect(p.timing).toEqual([{ t: 0, bpm: 120, meter: 4 }]);
    expect(p.notes).toEqual([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      { id: 1, t: 1500, lane: 3, type: "hold", d: 500 },
    ]);
    expect(p.warnings).toEqual([]);
  });

  it("multi-BPM produces multiple timing entries sorted by t", () => {
    const p = parseOsu(fix("multi-bpm.osu"));
    expect(p.timing.length).toBeGreaterThanOrEqual(2);
    expect([...p.timing].sort((a, b) => a.t - b.t)).toEqual(p.timing);
  });

  it("inherited (uninherited=0) timing point → sliderVelocity = -100/beatLength, bpm/meter inherited", () => {
    // round 14 P1: official 8-field form time,beatLength,meter,sampleSet,sampleIndex,
    // volume,uninherited,effects. Inherited point: uninherited (field 6) = 0 with
    // a NEGATIVE beatLength; slider velocity = -100/beatLength.
    const lines = fix("basic-4k.osu").split("\n");
    const tpIdx = findSection(lines, "[TimingPoints]");
    if (tpIdx === -1) throw new Error("test setup: no [TimingPoints] section in basic-4k.osu");
    const end = sectionEnd(lines, tpIdx);
    lines.splice(end, 0, "5000,-100,4,0,0,100,0,0", "6000,-50,4,0,0,100,0,0");
    const r = parseOsu(lines.join("\n"));
    expect(r.warnings).toEqual([]); // inherited rows are now first-class, not dropped
    const inherited = r.timing.filter((t) => t.sliderVelocity !== undefined);
    expect(inherited.map((t) => t.sliderVelocity)).toEqual([1.0, 2.0]);
    expect(inherited.every((t) => t.bpm === r.timing[0]!.bpm)).toBe(true);
    // a genuinely broken inherited row still fails the parse (guards against over-acceptance)
    const linesBad = fix("basic-4k.osu").split("\n");
    const endBad = sectionEnd(linesBad, findSection(linesBad, "[TimingPoints]"));
    linesBad.splice(endBad, 0, "7000,xx,4,0,0,100,0,0"); // non-numeric beatLength
    expect(() => parseOsu(linesBad.join("\n"))).toThrow(/timing points line \d+: inherited beatLength=xx/);
  });

  it("[Events] storyboard/background content → storyboard-dropped warning, still imports", () => {
    const text = fix("basic-4k.osu").replace("[Metadata]", `[Events]\n// a comment line — filtered, not warned\n0,0,"bg.jpg",0,0\nSprite,Background,"sb.png",0,0\n\n[Metadata]`);
    const p = parseOsu(text);
    expect(p.warnings.some((w) => w.code === "storyboard-dropped")).toBe(true);
    expect(p.notes).toHaveLength(2); // chart data unaffected
  });

  it("nonzero hitSound → feature-dropped warning", () => {
    const text = fix("basic-4k.osu").replace("64,192,1000,1,0,", "64,192,1000,1,8,");
    const p = parseOsu(text);
    expect(p.warnings.some((w) => w.code === "feature-dropped" && w.message.includes("hitsound"))).toBe(true);
  });

  it("non-default hitSample → feature-dropped warning", () => {
    const text = fix("basic-4k.osu").replace("64,192,1000,1,0,0:0:0:0:", "64,192,1000,1,0,0:0:2:0:");
    const p = parseOsu(text);
    expect(p.warnings.some((w) => w.code === "feature-dropped" && w.message.includes("hitSample"))).toBe(true);
  });

  it("unsupported hit-object type bits → feature-dropped warning, object dropped", () => {
    const text = fix("basic-4k.osu").replace("64,192,1000,1,0,", "64,192,1000,2,0,");
    const p = parseOsu(text);
    expect(p.warnings.some((w) => w.code === "feature-dropped" && w.message.includes("flags"))).toBe(true);
    expect(p.notes).toHaveLength(1); // unsupported object dropped, hold kept
  });

  it("unsupported type bits co-occurring with tap bit (flags=3) → warning, note still parses", () => {
    const text = fix("basic-4k.osu").replace("64,192,1000,1,0,", "64,192,1000,3,0,");
    const p = parseOsu(text);
    expect(p.warnings.some((w) => w.code === "feature-dropped" && w.message.includes("unsupported type bits") && w.message.includes("(3)"))).toBe(true);
    expect(p.notes).toEqual([
      { id: 0, t: 1000, lane: 0, type: "tap" }, // unsupported bit stripped, object kept
      { id: 1, t: 1500, lane: 3, type: "hold", d: 500 },
    ]);
  });

  it("flags=129 (tap|hold, all core bits) → no warning, hold parses", () => {
    const text = fix("basic-4k.osu").replace("448,192,1500,128,0,2000:0:0:0:0:", "448,192,1500,129,0,2000:0:0:0:0:");
    const p = parseOsu(text);
    expect(p.warnings).toEqual([]);
    expect(p.notes).toHaveLength(2);
    expect(p.notes[1]).toEqual({ id: 1, t: 1500, lane: 3, type: "hold", d: 500 });
  });

  it("unsupported type bits co-occurring with hold bit (flags=130) → warning, hold still parses with d", () => {
    const text = fix("basic-4k.osu").replace("448,192,1500,128,0,2000:0:0:0:0:", "448,192,1500,130,0,2000:0:0:0:0:");
    const p = parseOsu(text);
    expect(p.warnings.some((w) => w.code === "feature-dropped" && w.message.includes("unsupported type bits") && w.message.includes("(130)"))).toBe(true);
    expect(p.notes).toEqual([
      { id: 0, t: 1000, lane: 0, type: "tap" },
      { id: 1, t: 1500, lane: 3, type: "hold", d: 500 }, // hold kept, unsupported bit stripped
    ]);
  });

  it("hold with endTime <= t → invalid-hold warning, object dropped", () => {
    const text = fix("basic-4k.osu").replace("448,192,1500,128,0,2000:0:0:0:0:", "448,192,1500,128,0,1500:0:0:0:0:");
    const p = parseOsu(text);
    expect(p.warnings.some((w) => w.code === "feature-dropped" && w.message.includes("invalid hold"))).toBe(true);
    expect(p.notes).toHaveLength(1); // tap kept, broken hold dropped
  });

  it("malformed hit-object line → parse succeeds, one invalid-line warning; malformed time is a throw", () => {
    // A8 (T11) split: non-numeric x still warns + drops (hit-object malformed-line
    // contract kept); a non-numeric time is now a hard reject — the silent
    // `0 → 1` coercion was indistinguishable from a real time 0.
    const text = fix("basic-4k.osu").replace("64,192,1000,1,0,", "not-a-number,192,1000,1,0,");
    const p = parseOsu(text);
    const skipped = p.warnings.filter((w) => w.code === "invalid-line");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.message).toMatch(/\[HitObjects\] line \d+/);
    expect(p.notes).toHaveLength(1); // corrupted tap dropped, hold kept
    expect(p.timing).toEqual([{ t: 0, bpm: 120, meter: 4 }]);

    expect(() =>
      parseOsu(fix("basic-4k.osu").replace("64,192,1000,1,0,", "64,192,garbage,1,0,")),
    ).toThrow(/hit objects line \d+: time=garbage must be an integer/);
  });

  it("no usable timing points → fallback { t: 0, bpm: 120, meter: 4 }", () => {
    const text = fix("basic-4k.osu").replace("0,500,4,2,0,60,1,0", "");
    const p = parseOsu(text);
    expect(p.timing).toEqual([{ t: 0, bpm: 120, meter: 4 }]);
  });

  // I1 (round-2 sweep): fabricated default timing must never be silent —
  // never-silent contract (spec §5.2), same class as the ba15a98 malformed-line warnings.
  const noTimingBody = (section: string) =>
    `[General]\nMode: 3\n[Difficulty]\nCircleSize: 4\n${section}\n[HitObjects]\n64,192,1000,1,0,`;

  it("absent [TimingPoints] section → parse succeeds, one warning that 120 BPM timing was synthesized", () => {
    const p = parseOsu(noTimingBody(""));
    expect(p.timing).toEqual([{ t: 0, bpm: 120, meter: 4 }]);
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]!.code).toBe("feature-dropped");
    expect(p.warnings[0]!.message).toMatch(/120/);
    expect(p.warnings[0]!.message).toMatch(/TimingPoints/);
    expect(p.warnings[0]!.message).toMatch(/absent|empty/);
  });

  it("empty [TimingPoints] section → parse succeeds, one warning that 120 BPM timing was synthesized", () => {
    const p = parseOsu(noTimingBody("[TimingPoints]"));
    expect(p.timing).toEqual([{ t: 0, bpm: 120, meter: 4 }]);
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]!.code).toBe("feature-dropped");
    expect(p.warnings[0]!.message).toMatch(/120/);
    expect(p.warnings[0]!.message).toMatch(/TimingPoints/);
    expect(p.warnings[0]!.message).toMatch(/absent|empty/);
  });

  it("rejects non-4K with clear error", () => {
    expect(() => parseOsu(fix("reject-non4k.osu"))).toThrow(/only 4K \(CircleSize 4\)/);
  });
  it("rejects non-mania mode with clear error", () => {
    expect(() => parseOsu(fix("reject-standard.osu"))).toThrow(/osu!mania \(Mode 3\)/);
  });

  // A8 (T11): the silent clamp/soft drop paths are deleted — bad values reject
  // with an actionable error naming section, line, and value.

  it("REJECTS out-of-range x with an actionable error (no silent clamp)", () => {
    const lines = baseOsu().split("\n");
    const hoIdx = findSection(lines, "[HitObjects]");
    if (hoIdx === -1) throw new Error("test setup: no [HitObjects] section in baseOsu()");
    const hitLineIdx = firstDataLineIn(lines, hoIdx);
    if (hitLineIdx === -1) throw new Error("test setup: no hit-object data line found");
    const fields = lines[hitLineIdx]!.split(",");
    const originalX = fields[0];
    fields[0] = "600"; // x out of range
    lines[hitLineIdx] = fields.join(",");
    expect(fields[0]).toBe("600");
    expect(fields[0]).not.toBe(originalX);
    expect(() => parseOsu(lines.join("\n"))).toThrow(/hit objects line \d+: x=600 outside 0\.\.512/);
  });

  it("REJECTS zero beatLength on an UNINHERITED (BPM) timing point", () => {
    const lines = baseOsu().split("\n");
    const tpIdx = findSection(lines, "[TimingPoints]");
    if (tpIdx === -1) throw new Error("test setup: no [TimingPoints] section in baseOsu()");
    // round 14 P1: `uninherited` is FIELD 6 of the 8-field form (field 5 is
    // volume — reading f[5] would classify ordinary BPM rows as inherited).
    const bpmIdx = findLineInSection(lines, tpIdx, (f) => f.length === 8 && f[6] === "1");
    if (bpmIdx === -1) {
      const idx = firstDataLineIn(lines, tpIdx);
      if (idx === -1) throw new Error("test setup: no timing-point data line found");
      const f = lines[idx]!.split(",");
      f[1] = "0";
      lines[idx] = f.join(",");
      expect(f[1]).toBe("0");
      expect(() => parseOsu(lines.join("\n"))).toThrow(/timing points line \d+: beatLength=0 must be a finite positive number/);
      return;
    }
    const f = lines[bpmIdx]!.split(",");
    f[1] = "0";
    lines[bpmIdx] = f.join(",");
    expect(f[1]).toBe("0");
    expect(() => parseOsu(lines.join("\n"))).toThrow(/timing points line \d+: beatLength=0 must be a finite positive number/);
  });

  it("REJECTS negative beatLength on an UNINHERITED (BPM) timing point", () => {
    const lines = baseOsu().split("\n");
    const tpIdx = findSection(lines, "[TimingPoints]");
    if (tpIdx === -1) throw new Error("test setup: no [TimingPoints] section in baseOsu()");
    let i = findLineInSection(lines, tpIdx, (f) => f.length === 8 && f[6] === "1");
    if (i === -1) i = firstDataLineIn(lines, tpIdx);
    if (i === -1) throw new Error("test setup: no uninherited timing point in baseOsu()");
    const fields = lines[i]!.split(",");
    fields[1] = "-100";
    lines[i] = fields.join(",");
    expect(fields[1]).toBe("-100");
    expect(() => parseOsu(lines.join("\n"))).toThrow(/timing points line \d+: beatLength=-100 must be a finite positive number/);
  });

  it("REJECTS a non-negative beatLength on an inherited timing point", () => {
    const lines = baseOsu().split("\n");
    const tpIdx = findSection(lines, "[TimingPoints]");
    if (tpIdx === -1) throw new Error("test setup: no [TimingPoints] section in baseOsu()");
    const end = sectionEnd(lines, tpIdx);
    lines.splice(end, 0, "5000,100,4,0,0,100,0,0"); // positive beatLength + uninherited=0
    expect(() => parseOsu(lines.join("\n"))).toThrow(/timing points line \d+: inherited beatLength/);
  });

  it("REJECTS an invalid uninherited flag", () => {
    const lines = baseOsu().split("\n");
    const tpIdx = findSection(lines, "[TimingPoints]");
    if (tpIdx === -1) throw new Error("test setup: no [TimingPoints] section in baseOsu()");
    const i = firstDataLineIn(lines, tpIdx);
    if (i === -1) throw new Error("test setup: no timing-point data line found");
    const f = lines[i]!.split(",");
    f[6] = "7"; // anything other than 0/1
    lines[i] = f.join(",");
    expect(() => parseOsu(lines.join("\n"))).toThrow(/timing points line \d+: invalid uninherited flag 7/);
  });

  it("does NOT coerce an invalid meter to 4 — drops the line with a warning instead", () => {
    const lines = baseOsu().split("\n");
    const tpIdx = findSection(lines, "[TimingPoints]");
    if (tpIdx === -1) throw new Error("test setup: no [TimingPoints] section in baseOsu()");
    const tpLineIdx = firstDataLineIn(lines, tpIdx);
    if (tpLineIdx === -1) throw new Error("test setup: no timing-point data line found");
    const fields = lines[tpLineIdx]!.split(",");
    const originalMeter = fields[2];
    fields[2] = "xx"; // meter = garbage
    lines[tpLineIdx] = fields.join(",");
    expect(fields[2]).toBe("xx");
    expect(fields[2]).not.toBe(originalMeter);
    const r = parseOsu(lines.join("\n"));
    expect(JSON.stringify(r.warnings)).toMatch(/invalid-line/);
    // no timing point carries a meter fabricated from the garbage field
    expect(r.timing.every((t) => t.meter === 4 || t.meter === undefined)).toBe(true);
  });

  // Security caps (W2 final security review C2/I4): DoS guards, spec has no explicit cap
  const minimal = (section: string, lines: string) =>
    `[General]\nMode: 3\n[Difficulty]\nCircleSize: 4\n${section}\n${lines}`;

  it("over-cap hit objects → throws (DoS guard)", () => {
    const lines = Array.from({ length: 10_001 }, (_, i) => `${i % 512},192,${1000 + i},1,0,`).join("\n");
    expect(() => parseOsu(minimal("[HitObjects]", lines))).toThrow(/too many hit objects/);
  });

  it("hit objects exactly at cap → parses", () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `${i % 512},192,${1000 + i},1,0,`).join("\n");
    const p = parseOsu(minimal("[HitObjects]", lines));
    expect(p.notes).toHaveLength(10_000);
  });

  it("over-cap timing points → throws (DoS guard)", () => {
    const lines = Array.from({ length: 10_001 }, (_, i) => `${i * 500},500,4,2,0,60,1,0`).join("\n");
    expect(() => parseOsu(minimal("[TimingPoints]", lines))).toThrow(/too many timing points/);
  });

  it("Tags over cap → truncated to 64 with warning", () => {
    const tags = Array.from({ length: 65 }, (_, i) => `tag${i}`).join(" ");
    const text = fix("basic-4k.osu").replace("[Metadata]", `[Metadata]\nTags: ${tags}`);
    const p = parseOsu(text);
    expect(p.meta.tags).toHaveLength(64);
    expect(p.warnings.some((w) => w.message.includes("Tags truncated"))).toBe(true);
  });
});

describe("roundtrip fixtures (T16 ahead-of-time)", () => {
  it("roundtrip-taps: taps only, one timing, no warnings", () => {
    const p = parseOsu(fix("roundtrip-taps.osu"));
    expect(p.notes).toHaveLength(4);
    expect(p.notes.every((n) => n.type === "tap")).toBe(true);
    expect(p.notes.map((n) => n.lane)).toEqual([0, 1, 2, 3]);
    expect(p.timing).toHaveLength(1);
    expect(p.warnings).toEqual([]);
  });

  it("roundtrip-holds-multibpm: holds across two timing points, no warnings", () => {
    const p = parseOsu(fix("roundtrip-holds-multibpm.osu"));
    expect(p.timing).toHaveLength(2);
    expect(p.notes.filter((n) => n.type === "hold")).toHaveLength(2);
    expect(p.notes).toHaveLength(4);
    expect(p.warnings).toEqual([]);
  });

  it("roundtrip-meta: Tags and PreviewTime parsed", () => {
    const p = parseOsu(fix("roundtrip-meta.osu"));
    expect(p.meta.tags).toEqual(["tagA", "tagB"]);
    expect(p.meta.previewMs).toBe(12345);
    expect(p.meta.title).toBe("Roundtrip Meta");
    expect(p.meta.difficulty).toBe("Meta");
  });
});

describe("candidateFromParsed → canonicalize", () => {
  it("round-trips through canonicalization without throwing; pulses derived from timing", () => {
    const p = parseOsu(fix("basic-4k.osu"));
    const c = canonicalizeBeatmap(candidateFromParsed(p, "file:missing-audio"));
    expect(c.notes).toHaveLength(2);
    expect(c.pulses.length).toBeGreaterThan(0);
    expect(c.gen).toEqual({ source: "import", importedFrom: "osu", timingSource: "imported" });
    expect(typeof canonicalJson(c)).toBe("string");
  });

  it("pulses: bar-first s=1.0, other beats s=0.5", () => {
    const p = parseOsu(fix("basic-4k.osu"));
    const c = canonicalizeBeatmap(candidateFromParsed(p, "file:missing-audio"));
    expect(c.pulses[0]).toMatchObject({ t: 0, s: 1 });
    expect(c.pulses[1]!.s).toBe(0.5);
    expect(c.pulses[4]!.s).toBe(1); // beat 4 = next bar (meter 4)
  });

  it("insane beatLength (sub-ms) → pulse derivation throws instead of hanging (C2 compound)", () => {
    // beatLength 0.01 ms → 6 MHz "BPM" — the MIN_EFF_BEAT_MS guard rejects
    // before the pulse loop ever runs; MAX_PULSES is the backstop for anything
    // that slips through.
    const p = parseOsu(
      `[General]\nMode: 3\n[Difficulty]\nCircleSize: 4\n[TimingPoints]\n0,0.01,4,2,0,60,1,0\n[HitObjects]\n64,192,5000,1,0,`,
    );
    expect(p.timing).toHaveLength(1);
    expect(() => candidateFromParsed(p, "file:missing-audio")).toThrow(/beat rate too fast|too many pulses/);
  });

  it("inherited SV point → candidateFromParsed uses sliderVelocity for beat spacing", () => {
    // beatLength -50 → sv = -100/-50 = 2.0 → beatMs = 100/2 = 50 ms.
    // With bpm-only spacing the beat after 4000 would be at 4000 + 500
    // (bpm=120 → 500 ms per beat), far outside the [4000,4200] window.
    // With sv spacing: 4000, 4050, 4100, 4150, 4200.
    // A later BPM point at 5000 extends durationMs so the sv window is covered.
    const p = parseOsu(
      `[General]\nMode: 3\n[Difficulty]\nCircleSize: 4\n[TimingPoints]\n0,500,4,2,0,60,1,0\n4000,-50,4,0,0,100,0,0\n5000,500,4,2,0,60,1,0\n[HitObjects]\n64,192,1000,1,0,`,
    );
    const c = candidateFromParsed(p, "file:missing-audio") as { pulses: { t: number }[] };
    const inWindow = c.pulses.filter((x) => x.t >= 4000 && x.t <= 4200).map((x) => x.t);
    expect(inWindow).toEqual([4000, 4050, 4100, 4150, 4200]);
  });
});
