// apps/web/src/chart-source.test.ts
// W3 T15 (A5) ordering contract + T20 (B3): T20 removed the `?import` sessionStorage path, so
// the chart source collapses to benchmark > default. Each row pins ONE precedence decision;
// a reordering in chart-source.ts fails exactly the affected rows.
import { describe, expect, it } from "vitest";
import { isSafeFixtureName, resolveAudioSource, resolveChartSource, type SourceParams } from "./chart-source.js";

const params = (over: Partial<SourceParams> = {}): SourceParams => ({
  benchmark: false,
  fixtureAudio: null,
  ...over,
});
const E2E = { fixtureEnabled: true };
const PROD = { fixtureEnabled: false };

describe("chart source precedence: benchmark > default w1 (T20 removed ?import)", () => {
  it("default: no params → w1", () => {
    expect(resolveChartSource(params())).toEqual({ kind: "default" });
  });
  it("benchmark beats the default", () => {
    expect(resolveChartSource(params({ benchmark: true }))).toEqual({ kind: "benchmark" });
  });
});

describe("audio source precedence: fixtureAudio > click track", () => {
  it("default → click track", () => {
    expect(resolveAudioSource(params(), E2E)).toEqual({ kind: "clickTrack" });
  });
  it("fixtureAudio selects the real .webm regardless of the chart source (A6 mix-and-match)", () => {
    expect(resolveAudioSource(params({ fixtureAudio: "long" }), E2E)).toEqual({
      kind: "fixture",
      name: "long",
    });
    expect(resolveAudioSource(params({ fixtureAudio: "long", benchmark: true }), E2E)).toEqual({
      kind: "fixture",
      name: "long",
    });
  });
  it("fixture audio is inert outside dev/E2E builds (production cannot select a fixture)", () => {
    expect(resolveAudioSource(params({ fixtureAudio: "long" }), PROD)).toEqual({ kind: "clickTrack" });
  });
});

describe("fixture name guard", () => {
  it("accepts the committed fixture names and rejects traversal/absolute shapes", () => {
    for (const ok of ["long", "short", "medium", "long-2"]) expect(isSafeFixtureName(ok)).toBe(true);
    for (const bad of ["../secrets", "/etc/passwd", "a/b", "long.webm", ""]) expect(isSafeFixtureName(bad)).toBe(false);
  });
});
