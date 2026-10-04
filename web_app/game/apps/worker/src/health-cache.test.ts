import { describe, expect, it } from "vitest";
import { HEALTH_TTL_MS, isFresh, nextCache } from "./health-cache.js";

describe("health cache (D6)", () => {
  it("TTL is 60 s", () => {
    expect(HEALTH_TTL_MS).toBe(60_000);
  });

  it("no cache → miss; within TTL → hit", () => {
    expect(isFresh(null, 1_000)).toBe(false);
    expect(isFresh(nextCache(1_000), 60_999)).toBe(true); // expires 61_000; 1 ms before → fresh
  });

  it("stale at and after the exact expiry instant (strict >)", () => {
    const cache = nextCache(1_000); // expires = 61_000
    expect(isFresh(cache, 61_000)).toBe(false);
    expect(isFresh(cache, 61_001)).toBe(false);
  });
});
