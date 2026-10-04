import { describe, expect, it } from "vitest";
import { parseBeatmap } from "@airhythm/shared";
import w1 from "../fixtures/w1-chart.json" with { type: "json" };
import bench from "../fixtures/w1-benchmark-chart.json" with { type: "json" };

describe("w1-chart.json", () => {
  const chart = parseBeatmap(w1);
  it("is zod-valid, ~60 s, taps only, ids 0..n-1", () => {
    expect(chart.song.durationMs).toBe(60_000);
    expect(chart.notes).toHaveLength(60); // exact contract: ids 0..59, not a 55–70 range
    expect(chart.notes[59]?.id).toBe(59);
    expect(chart.notes.every((n) => n.type === "tap")).toBe(true);
    chart.notes.forEach((n, i) => expect(n.id).toBe(i));
    expect(chart.notes.every((n) => n.lane >= 0 && n.lane <= 3)).toBe(true);
    // sorted by t (schema invariant) and strictly increasing (hand-made chart)
    for (let i = 1; i < chart.notes.length; i++) {
      expect(chart.notes[i]!.t).toBeGreaterThan(chart.notes[i - 1]!.t);
    }
  });
  it("has one pulse per timing beat with durationMs 80", () => {
    expect(chart.pulses).toHaveLength(120); // 60000ms / 500ms beat @120bpm
    expect(chart.pulses[0]).toEqual({ t: 0, s: 1, durationMs: 80 });
    expect(chart.pulses[1]!.s).toBe(0.5);
    expect(chart.pulses.every((p) => p.durationMs === 80)).toBe(true);
    expect(chart.pulses.every((p, i) => p.t === i * 500)).toBe(true);
  });
});

describe("w1-benchmark-chart.json", () => {
  const chart = parseBeatmap(bench);
  it("fixed 3-minute duration, 900 unique-id taps, ends before duration", () => {
    expect(chart.song.durationMs).toBe(180_000);
    expect(chart.notes).toHaveLength(900);
    expect(new Set(chart.notes.map((n) => n.id)).size).toBe(900);
    const last = Math.max(...chart.notes.map((n) => n.t));
    expect(last + 110).toBeLessThanOrEqual(180_000); // endTime within duration, no looping needed
  });
  it("is deterministic (stdout regeneration byte-identical; test never mutates the fixture)", async () => {
    // spawn the JS generator with --stdout (no TS import, no file rewrite)
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const genPath = fileURLToPath(new URL("../scripts/gen-benchmark-fixture.mjs", import.meta.url)); // NOT url.pathname — broken on Windows (leading slash)
    const outPath = fileURLToPath(new URL("../fixtures/w1-benchmark-chart.json", import.meta.url));
    const stdout = execFileSync(process.execPath, [genPath, "--stdout"], { encoding: "utf8" });
    expect(stdout).toBe(readFileSync(outPath, "utf8"));
  });
});
