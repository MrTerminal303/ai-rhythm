import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsu, candidateFromParsed } from "./osu-import.js";
import { canonicalizeBeatmap, canonicalJson } from "@airhythm/shared";

const fix = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");

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

  it("SV line → sv-dropped warning, still imports", () => {
    const p = parseOsu(fix("sv-warning.osu"));
    expect(p.warnings.some((w) => w.code === "sv-dropped")).toBe(true);
    expect(p.notes.length).toBeGreaterThan(0);
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

  it("no usable timing points → fallback { t: 0, bpm: 120, meter: 4 }", () => {
    const text = fix("basic-4k.osu").replace("0,500,4,2,0,60,1,0", "");
    const p = parseOsu(text);
    expect(p.timing).toEqual([{ t: 0, bpm: 120, meter: 4 }]);
  });

  it("rejects non-4K with clear error", () => {
    expect(() => parseOsu(fix("reject-non4k.osu"))).toThrow(/only 4K \(CircleSize 4\)/);
  });
  it("rejects non-mania mode with clear error", () => {
    expect(() => parseOsu(fix("reject-standard.osu"))).toThrow(/osu!mania \(Mode 3\)/);
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
    // beatLength 0.01 ms → 6 MHz "BPM" passes the finite/positive guard; without a
    // pulses cap the nested loop iterates span/beatLength (or spins forever once
    // float64 stops absorbing the increment)
    const p = parseOsu(
      `[General]\nMode: 3\n[Difficulty]\nCircleSize: 4\n[TimingPoints]\n0,0.01,4,2,0,60,1,0\n[HitObjects]\n64,192,5000,1,0,`,
    );
    expect(p.timing).toHaveLength(1);
    expect(() => candidateFromParsed(p, "file:missing-audio")).toThrow(/too many pulses/);
  });
});
