import { describe, expect, it } from "vitest";
import { rankFor, type Rank } from "./rank.js";

describe("rankFor", () => {
  const cases: [number, Rank][] = [
    [0.995, "SS"],
    [0.994, "S"],
    [0.98, "S"],
    [0.979, "A"],
    [0.95, "A"],
    [0.949, "B"],
    [0.9, "B"],
    [0.899, "C"],
    [0.85, "C"],
    [0.849, "D"],
    [0, "D"],
  ];

  it.each(cases)("rankFor(%s) = %s", (frac, rank) => {
    expect(rankFor(frac)).toBe(rank);
  });
});
