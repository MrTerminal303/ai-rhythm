export const KEY_TO_LANE: Record<string, number> = { d: 0, f: 1, j: 2, k: 3 };

export function laneForKey(key: string): number | undefined {
  return KEY_TO_LANE[key.toLowerCase()];
}

export interface KeyHandlerDeps {
  inputChartTime: (timeStampMs: number) => number;
  engine: {
    judge(lane: number, inputMs: number): void;
    isFrozen(): boolean;
  };
  onAccepted?: (lane: number) => void;
}

export function createKeyHandler(deps: KeyHandlerDeps): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    if (event.repeat) return; // Review Focus #1
    const lane = laneForKey(event.key);
    if (lane === undefined) return; // Review Focus #1
    event.preventDefault(); // accepted gameplay key only
    if (deps.engine.isFrozen()) return; // frozen engine ignores gameplay input
    deps.engine.judge(lane, deps.inputChartTime(event.timeStamp)); // input time, never clock.chartTimeMs()
    deps.onAccepted?.(lane);
  };
}

// W2 T17: defined in release.ts (Files list); re-exported here per brief Interfaces
export { createReleaseHandler } from "./release.js";

/**
 * Review Focus 4 (W2 T17): release held lanes BEFORE pause records position.
 * Releases run over a copy, then the set is cleared, then pause — order asserted by test.
 */
export function flushHeldLanesBeforePause(deps: {
  heldLanes: Set<number>;
  releaseAt: (lane: number) => void;
  pause: () => void;
}): void {
  for (const lane of [...deps.heldLanes]) deps.releaseAt(lane);
  deps.heldLanes.clear();
  deps.pause();
}
