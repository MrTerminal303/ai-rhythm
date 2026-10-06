import { describe, expect, it } from "vitest";
import { grade, scoreFromWeights, accuracyFraction, comboMultiplier } from "./judgement.js";
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
    expect(SCORE_WEIGHTS).toEqual({ perfect: 1, great: 0.75, good: 0.4, miss: 0 });
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

describe("scoring re-eval (PLAN §7.3, D16)", () => {
  it("Good weight is 0.40 (PLAN §7.3, D16)", () => {
    expect(SCORE_WEIGHTS.good).toBe(0.4);
  });

  it("combo bonus: full combo → exactly +5%", () => {
    expect(comboMultiplier(100, 100)).toBeCloseTo(1.05, 10);
    expect(scoreFromWeights(100, 100, 100)).toBe(Math.floor(1_000_000 * 1.05)); // sum of weights = 100 perfects' weight 1.0 each, total 100
  });

  it("combo bonus: zero combo → +0%", () => {
    expect(comboMultiplier(0, 100)).toBe(1);
    expect(scoreFromWeights(50, 100, 0)).toBe(500_000); // base = 1e6 * 50/100
  });

  it("combo bonus is independent of hit-quality distribution at constant maxCombo", () => {
    // sumOfWeights are GRADE WEIGHT sums (≤ totalTargets), not raw score values
    const multA = scoreFromWeights(80, 100, 50) / 800_000; // base 800_000 × 1.025 = 820_000
    const multB = scoreFromWeights(40, 100, 50) / 400_000; // base 400_000 × 1.025 = 410_000
    expect(scoreFromWeights(80, 100, 50)).toBe(820_000);
    expect(scoreFromWeights(40, 100, 50)).toBe(410_000);
    expect(multA).toBeCloseTo(1.025, 6);
    expect(multB).toBeCloseTo(1.025, 6);
  });

  it("comboMultiplier clamps maxCombo into [0, totalTargets] (bonus ≤ 5% guarantee)", () => {
    expect(comboMultiplier(1_000_000, 100)).toBeCloseTo(1.05, 10);
    expect(comboMultiplier(-5, 100)).toBe(1);
  });

  it("score is capped at 1,050,000", () => {
    expect(scoreFromWeights(100, 100, 100)).toBe(1_050_000);
  });
});
