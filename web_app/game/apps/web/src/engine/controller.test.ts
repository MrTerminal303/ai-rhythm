// @vitest-environment jsdom // KeyboardEvent + defaultPrevented need a DOM (config default is node)
import { describe, expect, it, vi } from "vitest";
import { createKeyHandler, laneForKey } from "./controller.js";

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
    const handler = createKeyHandler({
      inputChartTime: (ts) => ts, // identity — provenance test below pins the raw value
      engine: { judge, isFrozen: () => frozen },
    });
    return { judge, handler };
  };

  it("judges with the value mapped from event.timeStamp (Review Focus 1)", () => {
    const seen: number[] = [];
    const handler = createKeyHandler({
      inputChartTime: (ts) => {
        seen.push(ts);
        return 999;
      },
      engine: {
        judge: (lane, ms) => {
          expect(ms).toBe(999);
        },
        isFrozen: () => false,
      },
    });
    handler({ key: "d", repeat: false, timeStamp: 12_345, preventDefault() {} } as KeyboardEvent);
    expect(seen).toEqual([12_345]); // provenance: the raw timeStamp, not clock.chartTimeMs()
  });

  it("accepted key: preventDefault + judge(lane, inputChartTime(timeStamp)) at keydown", () => {
    const { judge, handler } = mk();
    const ev = keyEvent({ key: "d" });
    handler(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(judge).toHaveBeenCalledWith(0, ev.timeStamp);
  });

  it("onAccepted fires only for accepted lane keys", () => {
    const onAccepted = vi.fn();
    const handler = createKeyHandler({
      inputChartTime: (ts) => ts,
      engine: { judge: vi.fn(), isFrozen: () => false },
      onAccepted,
    });
    handler(keyEvent({ key: "j" }));
    expect(onAccepted).toHaveBeenCalledWith(2);
    handler(keyEvent({ key: "a" }));
    expect(onAccepted).toHaveBeenCalledTimes(1);
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
