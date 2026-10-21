// apps/web/src/engine/d21-verdict.test.ts
import { describe, expect, it } from "vitest";
import { d21FinalVerdict, classifyPrecision } from "./d21-verdict.js";

describe("d21FinalVerdict — every acceptance-rate × observed-reference-discrepancy × precision combination (SAFETY-FIRST ordering, round 9 P0)", () => {
  it("within 5 ms + ≥90% + normal + valid reading → conversion-validated", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 48, total: 50, maxAbsErrMs: 3.1, anyInvalidReading: false })).toBe("conversion-validated"));
  it("within 5 ms + below-threshold + normal + valid reading → fallback-mode (mapping safety ALREADY established)", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 10, total: 50, maxAbsErrMs: 2.0, anyInvalidReading: false })).toBe("fallback-mode"));
  it("ROUND 9 P0: over 5 ms + below-threshold + normal + valid reading → mapping-error-fail (false-green eliminated — safety beats eligibility)", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 10, total: 50, maxAbsErrMs: 50, anyInvalidReading: false })).toBe("mapping-error-fail"));
  it("within 5 ms + ≥90% + degraded precision → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "degraded", acceptCount: 50, total: 50, maxAbsErrMs: 3, anyInvalidReading: false })).toBe("conversion-unverified"));
  it("any + inconclusive precision → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "inconclusive", acceptCount: 50, total: 50, maxAbsErrMs: 1, anyInvalidReading: false })).toBe("conversion-unverified"));
  it("no measurement + normal → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 49, total: 50, maxAbsErrMs: null, anyInvalidReading: false })).toBe("conversion-unverified"));
  // ROUND 10 P1-2 — invalid measurements fail closed, never green:
  it("NaN reading → conversion-unverified (not mapping-error-fail, not green)", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 48, total: 50, maxAbsErrMs: NaN, anyInvalidReading: true })).toBe("conversion-unverified"));
  it("+Infinity reading → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 48, total: 50, maxAbsErrMs: Infinity, anyInvalidReading: true })).toBe("conversion-unverified"));
  it("−Infinity reading → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 48, total: 50, maxAbsErrMs: -Infinity, anyInvalidReading: true })).toBe("conversion-unverified"));
  it("anyInvalidReading flag set + finite maxAbsErrMs → conversion-unverified (measurement invalid even if aggregate is finite)", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 48, total: 50, maxAbsErrMs: 2.0, anyInvalidReading: true })).toBe("conversion-unverified"));
  it("negative acceptCount (invalid counter) → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: -1, total: 50, maxAbsErrMs: 2.0, anyInvalidReading: false })).toBe("conversion-unverified"));
  // Round 11 P1-2 — additional counter-validation rows:
  it("negative total → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 0, total: -1, maxAbsErrMs: 2.0, anyInvalidReading: false })).toBe("conversion-unverified"));
  it("zero total → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 0, total: 0, maxAbsErrMs: 2.0, anyInvalidReading: false })).toBe("conversion-unverified"));
  it("fractional acceptCount → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 2.5, total: 50, maxAbsErrMs: 2.0, anyInvalidReading: false })).toBe("conversion-unverified"));
  it("acceptCount > total → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 60, total: 50, maxAbsErrMs: 2.0, anyInvalidReading: false })).toBe("conversion-unverified"));
  it("NaN total → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 48, total: NaN, maxAbsErrMs: 2.0, anyInvalidReading: false })).toBe("conversion-unverified"));
  it("Infinity acceptCount → conversion-unverified", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: Infinity, total: 50, maxAbsErrMs: 2.0, anyInvalidReading: false })).toBe("conversion-unverified"));
  // Round 13 P2-2 — negative error value is a malformed aggregate, fails closed:
  it("negative maxAbsErrMs → conversion-unverified (|E| can never be negative)", () =>
    expect(d21FinalVerdict({ precision: "normal", acceptCount: 48, total: 50, maxAbsErrMs: -3.0, anyInvalidReading: false })).toBe("conversion-unverified"));
});

describe("classifyPrecision — ONE rule (round 9 P2-5)", () => {
  it("normal: any fine step present", () => expect(classifyPrecision([2.8, 16.7, 16.7])).toBe("normal"));
  it("degraded: ≥5 changes, all ≥16", () => expect(classifyPrecision([16.67, 16.67, 16.67, 16.67, 16.67])).toBe("degraded"));
  it("mixed (no fine, not all big) → inconclusive, NOT degraded", () => expect(classifyPrecision([16.7, 12, 16.7, 16.7, 16.7])).toBe("inconclusive"));
  it("insufficient observations → inconclusive", () => expect(classifyPrecision([2.8, 2.8])).toBe("inconclusive"));
});
