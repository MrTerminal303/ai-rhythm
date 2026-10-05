import { useSyncExternalStore } from "react";
import type { GameSnapshot } from "../engine/types.js";

export class SnapshotStore {
  private snapshot: GameSnapshot | null = null;
  private listeners = new Set<() => void>();

  // arrow-function class properties: stable identity across renders — useSyncExternalStore
  // resubscribes whenever the subscribe function's reference changes (a new closure per
  // render would tear down and rebuild the subscription every frame)
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): GameSnapshot | null => {
    return this.snapshot;
  };

  set(next: GameSnapshot): void {
    if (next === this.snapshot) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

export function useGameSnapshot(store: SnapshotStore): GameSnapshot | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
}
