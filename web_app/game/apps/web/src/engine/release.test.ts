// @vitest-environment jsdom // KeyboardEvent needs a DOM
import { describe, expect, it, vi } from "vitest";
import { createReleaseHandler, flushHeldLanesBeforePause } from "./controller.js";
import { laneForKey } from "./controller.js";

describe("createReleaseHandler (W2 T17 keyup)", () => {
  it("keyup uses inputChartTime, not render time (mirrors T9 provenance test)", () => {
    const seen: number[] = [];
    const release = vi.fn();
    const handler = createReleaseHandler({
      inputChartTime: (ts) => {
        seen.push(ts);
        return 777;
      },
      engine: { release, isFrozen: () => false },
    });
    handler({ key: "d", timeStamp: 12_345 } as KeyboardEvent);
    expect(seen).toEqual([12_345]); // provenance: raw event.timeStamp, never clock.chartTimeMs()
    expect(release).toHaveBeenCalledWith(0, 777);
  });

  it("lane keys only; non-lane keys ignored entirely", () => {
    const release = vi.fn();
    const handler = createReleaseHandler({
      inputChartTime: (ts) => ts,
      engine: { release, isFrozen: () => false },
    });
    for (const key of ["a", "Shift", "Enter", "1", " ", "ArrowLeft"]) {
      handler({ key, timeStamp: 100 } as KeyboardEvent);
    }
    expect(release).not.toHaveBeenCalled();
    handler({ key: "K", timeStamp: 100 } as KeyboardEvent); // case-insensitive lane
    expect(release).toHaveBeenCalledWith(3, 100);
  });

  it("frozen engine: release NOT called", () => {
    const release = vi.fn();
    const handler = createReleaseHandler({
      inputChartTime: (ts) => ts,
      engine: { release, isFrozen: () => true },
    });
    handler({ key: "f", timeStamp: 50 } as KeyboardEvent);
    expect(release).not.toHaveBeenCalled();
  });

  it("laneForKey maps the same keys as createKeyHandler", () => {
    expect(laneForKey("d")).toBe(0);
    expect(laneForKey("k")).toBe(3);
  });
});

describe("flushHeldLanesBeforePause (Review Focus 4 blur order)", () => {
  it("releases judged BEFORE pause records position; heldLanes cleared", () => {
    const order: string[] = [];
    const heldLanes = new Set([0, 2]);
    flushHeldLanesBeforePause({
      heldLanes,
      releaseAt: (lane) => order.push(`release@${lane}`),
      pause: () => order.push("pause"),
    });
    expect(order).toEqual(["release@0", "release@2", "pause"]); // release loop first, then pause
    expect(heldLanes.size).toBe(0); // flushed + cleared
  });

  it("empty heldLanes still pauses", () => {
    const order: string[] = [];
    flushHeldLanesBeforePause({
      heldLanes: new Set(),
      releaseAt: (lane) => order.push(`release@${lane}`),
      pause: () => order.push("pause"),
    });
    expect(order).toEqual(["pause"]);
  });
});
