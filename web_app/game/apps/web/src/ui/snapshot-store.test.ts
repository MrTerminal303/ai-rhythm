import { describe, expect, it, vi } from "vitest";
import { SnapshotStore } from "./snapshot-store.js";
import type { GameSnapshot } from "../engine/types.js";

const snap = (score: number): GameSnapshot => ({
  chartTimeMs: 0, score, combo: 0, accuracy: 0, frozen: false,
  endTimeMs: 1000, noteStates: [], events: [],
});

describe("SnapshotStore", () => {
  it("notifies subscribers on set; unsubscribes cleanly", () => {
    const store = new SnapshotStore();
    const cb = vi.fn();
    const un = store.subscribe(cb);
    store.set(snap(1));
    expect(cb).toHaveBeenCalledTimes(1);
    un();
    store.set(snap(2));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()?.score).toBe(2);
  });

  it("ignores re-set of the same reference", () => {
    const store = new SnapshotStore();
    const cb = vi.fn();
    store.subscribe(cb);
    const s = snap(1);
    store.set(s);
    store.set(s);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
