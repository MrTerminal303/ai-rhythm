import { describe, expect, it } from "vitest";
import { grade, scoreFromWeights, accuracyFraction } from "./judgement.js";
import { JUDGE_WINDOWS, SCORE_WEIGHTS, PULSE_DURATION_MS, KEY_COUNT } from "./constants.js";

describe("grade boundary matrix", () => {
  it("perfect boundaries: inclusive at 35", () => {
    expect(grade(34)).toBe("perfect");
    expect(grade(35)).toBe("perfect");
    expect(grade(-35)).toBe("perfect");
    expect(grade(36)).toBe("great");
    expect(grade(-36)).toBe("great");
  });
  it("great boundaries: inclusive at 70", () => {
    expect(grade(69)).toBe("great");
    expect(grade(70)).toBe("great");
    expect(grade(-70)).toBe("great");
    expect(grade(71)).toBe("good");
    expect(grade(-71)).toBe("good");
  });
  it("good boundaries: inclusive at 110", () => {
    expect(grade(109)).toBe("good");
    expect(grade(110)).toBe("good");
    expect(grade(-110)).toBe("good");
    expect(grade(111)).toBe("miss");
    expect(grade(-111)).toBe("miss");
  });
});

describe("constants", () => {
  it("matches spec windows, weights, and key count", () => {
    expect(JUDGE_WINDOWS.perfect).toBe(35);
    expect(JUDGE_WINDOWS.great).toBe(70);
    expect(JUDGE_WINDOWS.good).toBe(110);
    expect(SCORE_WEIGHTS).toEqual({ perfect: 1, great: 0.75, good: 0.5, miss: 0 });
    expect(PULSE_DURATION_MS).toBe(80);
    expect(KEY_COUNT).toBe(4);
  });
});

describe("scoreFromWeights", () => {
  it("all perfect = 1_000_000", () => {
    expect(scoreFromWeights(10 * 1, 10)).toBe(1_000_000);
  });
  it("empty chart = 0 (no NaN)", () => {
    expect(scoreFromWeights(0, 0)).toBe(0);
    expect(scoreFromWeights(5, 0)).toBe(0);
  });
  it("floors fractional results", () => {
    // 1e6 * 3.75 / 7 = 535714.285… → 535714
    expect(scoreFromWeights(3.75, 7)).toBe(535_714);
  });
  it("misses contribute 0", () => {
    expect(scoreFromWeights(8 * 1 + 2 * 0, 10)).toBe(800_000);
  });
});

describe("accuracyFraction", () => {
  it("empty chart = 0", () => {
    expect(accuracyFraction(0, 0)).toBe(0);
  });
  it("all perfect = 1", () => {
    expect(accuracyFraction(4, 4)).toBe(1);
  });
  it("mixed", () => {
    expect(accuracyFraction(1 + 0.75, 4)).toBe(0.4375);
  });
});
