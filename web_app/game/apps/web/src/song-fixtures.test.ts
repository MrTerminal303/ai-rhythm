import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsu } from "@airhythm/beatmap-formats";

const SONGS = [
  { file: "short.webm", sha256: "2378b418be401fca1881b7eba25464c8ad9217ad5ca5bc6a31eed6bb3e38fed6", nominalSec: 30 },
  { file: "medium.webm", sha256: "d861c4416d72759f915b9da151b134a6a81382adb4df7f8e12e19c19cb38a465", nominalSec: 90 },
  { file: "long.webm", sha256: "da7810fe47e1014542e749bca6774eca07bc42efdc8f5ea07b11eb92b0b7022f", nominalSec: 240 },
] as const;

describe("§7 real-song fixtures (committed, generated, checksummed)", () => {
  for (const s of SONGS) {
    it(`${s.file}: exists, EBML magic, checksum pinned`, () => {
      const p = new URL(`../public/songs/${s.file}`, import.meta.url);
      expect(existsSync(p)).toBe(true);
      const bytes = readFileSync(p);
      expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3"); // EBML / WebM
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(s.sha256); // stale-file guard (spec §6)
    });
  }
  it("short.osu parses and its notes align with the 120 BPM grid", () => {
    const osu = readFileSync(new URL("../public/songs/short.osu", import.meta.url), "utf8");
    const chart = parseOsu(osu);
    expect(chart.notes.length).toBeGreaterThan(20);
    for (const n of chart.notes) expect(n.t % 500).toBe(0);
  });
  it("long.osu parses and spans the 240 s track", () => {
    const osu = readFileSync(new URL("../public/songs/long.osu", import.meta.url), "utf8");
    const chart = parseOsu(osu);
    expect(chart.notes.length).toBeGreaterThan(200);
    expect(Math.max(...chart.notes.map((n) => n.t))).toBeLessThan(240_000);
  });
});
