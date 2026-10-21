// @vitest-environment jsdom
// apps/web/src/calibration-store.test.ts
import { describe, expect, it } from "vitest";
import { associateTaps, computeCalibration, loadCalibration, readCalibrationValue, saveCalibration } from "./calibration-store.js";

describe("readCalibrationValue", () => {
  it("empty store → 0 (A2: contract-implied fallback; D21 supersedes outputLatency×1000)", () => {
    expect(readCalibrationValue(null)).toBe(0);
  });
  it("invalid stored → 0", () => {
    expect(readCalibrationValue("abc")).toBe(0);
    expect(readCalibrationValue("999999")).toBe(0);
    expect(readCalibrationValue("-900")).toBe(0);
    expect(readCalibrationValue("Infinity")).toBe(0);
  });
  it("stored value still wins", () => expect(readCalibrationValue("42.5")).toBe(42.5));
  it("out-of-range stored (corrupt localStorage) → fallback, never gameplay offset", () => {
    expect(readCalibrationValue("99999")).toBe(0);
    expect(readCalibrationValue("-800")).toBe(0);
    expect(readCalibrationValue("Infinity")).toBe(0);
    expect(readCalibrationValue("42")).toBe(42); // in-range survives
  });
});

describe("loadCalibration / saveCalibration", () => {
  it("loadCalibration reads localStorage (no latency arg)", () => {
    localStorage.setItem("deviceCalibrationOffsetMs", "42");
    expect(loadCalibration()).toBe(42);
  });
  it("save rejects out-of-range / non-finite values before touching storage", () => {
    expect(() => saveCalibration(600)).toThrow();
    expect(() => saveCalibration(Number.NaN)).toThrow();
  });
});

describe("computeCalibration — median of (input − beat)", () => {
  it("16 samples, even count → average of middle two", () => {
    const samples = Array.from({ length: 16 }, (_, i) => ({ inputMs: 1000 + i * 500 + 30, beatMs: 1000 + i * 500 }));
    expect(computeCalibration(samples)).toBe(30);
  });
  it("rejects empty", () => expect(() => computeCalibration([])).toThrow());
  it("uses median not mean (one outlier tap does not move it)", () => {
    const samples = [
      ...Array.from({ length: 15 }, (_, i) => ({ inputMs: 1000 + i * 500 + 20, beatMs: 1000 + i * 500 })),
      { inputMs: 1000 + 15 * 500 + 900, beatMs: 1000 + 15 * 500 },
    ];
    expect(computeCalibration(samples)).toBe(20);
  });
});

describe("associateTaps — nearest-beat matching (missed-tap must not cascade)", () => {
  const beats = [0, 500, 1000, 1500, 2000];
  it("a missed beat shifts pairing, not the whole series", () => {
    const pairs = associateTaps([1030, 1530, 2030], beats);
    expect(pairs.map((p) => p.beatMs)).toEqual([1000, 1500, 2000]);
    expect(pairs.every((p) => p.inputMs - p.beatMs === 30)).toBe(true);
  });
  it("rejects taps outside the window (>250 ms from nearest free beat)", () => {
    const pairs = associateTaps([200, 1030], beats);
    expect(pairs.find((p) => p.inputMs === 200)?.beatMs).toBe(0);
    const far = associateTaps([2300], beats);
    expect(far).toEqual([]);
  });
  it("each beat consumed at most once", () => {
    const pairs = associateTaps([510, 520], beats);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.beatMs).toBe(500);
  });
});
