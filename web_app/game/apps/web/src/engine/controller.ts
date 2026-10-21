export const KEY_TO_LANE: Record<string, number> = { d: 0, f: 1, j: 2, k: 3 };

export function laneForKey(key: string): number | undefined {
  return KEY_TO_LANE[key.toLowerCase()];
}

/**
 * W3 T22: lowercase key → lane index for the CONFIGURED lane binds. The settings document
 * holds display-case strings ("D"); the handler compares lowercased event keys, so build the
 * map once per run at startGame and hand the SAME map to judging, held-lane tracking and the
 * input-latency probe (they must agree on what counts as a lane key).
 */
export function lanesToKeyMap(lanes: readonly string[]): Record<string, number> {
  const map: Record<string, number> = {};
  lanes.forEach((key, lane) => {
    map[key.toLowerCase()] = lane;
  });
  return map;
}

export interface KeyHandlerDeps {
  inputChartTime: (timeStampMs: number) => number;
  engine: {
    judge(lane: number, inputMs: number): void;
    isFrozen(): boolean;
  };
  onAccepted?: (lane: number) => void;
  /** W3 T22: resolved lane map (settings `keybinds`); omitted → the default D F J K map */
  lanes?: Record<string, number>;
}

export function createKeyHandler(deps: KeyHandlerDeps): (event: KeyboardEvent) => void {
  const lanes = deps.lanes ?? KEY_TO_LANE;
  return (event: KeyboardEvent) => {
    if (event.repeat) return; // Review Focus #1
    const lane = lanes[event.key.toLowerCase()];
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
