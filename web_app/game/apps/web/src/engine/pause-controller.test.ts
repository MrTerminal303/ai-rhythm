import { describe, expect, it } from "vitest";
import { SoloPauseController } from "./pause-controller.js";

describe("SoloPauseController", () => {
  it("records position once; idempotent", () => {
    const p = new SoloPauseController();
    expect(p.pausedAtMs).toBeNull();
    expect(p.pause(12_345)).toBe(12_345);
    expect(p.pause(99_999)).toBe(12_345); // second pause while paused keeps first
    p.clear();
    expect(p.pausedAtMs).toBeNull();
  });
});
