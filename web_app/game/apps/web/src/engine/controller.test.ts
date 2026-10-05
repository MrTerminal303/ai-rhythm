// @vitest-environment jsdom // KeyboardEvent + defaultPrevented need a DOM (config default is node)
import { describe, expect, it, vi } from "vitest";
import { createKeyHandler, laneForKey } from "./controller.js";
import { PerformanceClock } from "./clock.js";

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

describe("laneForKey", () => {
  it("maps D F J K case-insensitively, nothing else", () => {
    expect(laneForKey("d")).toBe(0);
    expect(laneForKey("F")).toBe(1);
    expect(laneForKey("j")).toBe(2);
    expect(laneForKey("K")).toBe(3);
    expect(laneForKey("a")).toBeUndefined();
    expect(laneForKey("Shift")).toBeUndefined();
  });
});

describe("createKeyHandler (§2.3 input filtering)", () => {
  const mk = (frozen = false) => {
    const judge = vi.fn();
    let t = 0; // start wall clock at 0 so setTime(1000) advances chartTime to 1000 (brief had t=1000 → setTime no-op, judge got 0)
    const src = { nowMs: () => t };
    const clock = new PerformanceClock(src);
    clock.start(0);
    const handler = createKeyHandler({ clock, engine: { judge, isFrozen: () => frozen } });
    return { judge, handler, setTime: (v: number) => { t = v; } };
  };

  it("accepted key: preventDefault + judge(lane, chartTimeMs) at keydown time", () => {
    const { judge, handler, setTime } = mk();
    setTime(1000);
    const ev = keyEvent({ key: "d" });
    handler(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(judge).toHaveBeenCalledWith(0, 1000);
  });

  it("Review Focus #1: repeat events ignored (no judge, no preventDefault)", () => {
    const { judge, handler } = mk();
    const ev = keyEvent({ key: "d", repeat: true });
    handler(ev);
    expect(judge).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("Review Focus #1: non-gameplay keys ignored entirely", () => {
    const { judge, handler } = mk();
    for (const key of ["a", "Shift", "Enter", "1", " ", "ArrowLeft"]) {
      const ev = keyEvent({ key });
      handler(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(judge).not.toHaveBeenCalled();
  });

  it("frozen engine: accepted key prevented but NOT judged", () => {
    const { judge, handler } = mk(true);
    const ev = keyEvent({ key: "k" });
    handler(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(judge).not.toHaveBeenCalled();
  });
});
