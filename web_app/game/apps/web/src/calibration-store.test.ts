// apps/web/src/calibration-store.test.ts
import { describe, expect, it } from "vitest";
import { associateTaps, computeCalibration, loadCalibration, readCalibrationValue, saveCalibration } from "./calibration-store.js";

describe("readCalibrationValue", () => {
  it("stored value wins", () => expect(readCalibrationValue("42.5", 100)).toBe(42.5));
  it("empty store + outputLatency 0.021 s → 21 ms", () => expect(readCalibrationValue(null, 0.021)).toBeCloseTo(21, 6));
  it("empty store + missing/zero latency → 0", () => {
    expect(readCalibrationValue(null, undefined)).toBe(0);
    expect(readCalibrationValue(null, 0)).toBe(0);
  });
  it("invalid stored → fallback path", () => expect(readCalibrationValue("abc", 0.03)).toBeCloseTo(30, 6));
  it("out-of-range stored (corrupt localStorage) → fallback, never gameplay offset", () => {
    expect(readCalibrationValue("99999", 0)).toBe(0);
    expect(readCalibrationValue("-800", undefined)).toBe(0);
    expect(readCalibrationValue("Infinity", undefined)).toBe(0);
    expect(readCalibrationValue("42", undefined)).toBe(42); // in-range survives
  });
});

describe("loadCalibration / saveCalibration", () => {
  it("load falls back to latency guess when localStorage unavailable", () => expect(loadCalibration(0.021)).toBeCloseTo(21, 6));
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
    // player skips beat 1, taps land at 1030, 1530, 2030 (matching beats 2..4)
    const pairs = associateTaps([1030, 1530, 2030], beats);
    expect(pairs.map((p) => p.beatMs)).toEqual([1000, 1500, 2000]);
    expect(pairs.every((p) => p.inputMs - p.beatMs === 30)).toBe(true);
  });
  it("rejects taps outside the window (>250 ms from nearest free beat)", () => {
    const pairs = associateTaps([200, 1030], beats); // 200 is within 250 of beat 0 → accepted
    expect(pairs.find((p) => p.inputMs === 200)?.beatMs).toBe(0);
    // beats are 500 ms apart, so only taps beyond the edge beats' window can reject
    const far = associateTaps([2300], beats); // 300 past beat 2000 → rejected
    expect(far).toEqual([]);
  });
  it("each beat consumed at most once", () => {
    const pairs = associateTaps([510, 520], beats);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.beatMs).toBe(500);
  });
});
