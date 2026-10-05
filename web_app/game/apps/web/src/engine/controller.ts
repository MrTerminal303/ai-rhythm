import type { GameClock } from "./clock.js";

export const KEY_TO_LANE: Record<string, number> = { d: 0, f: 1, j: 2, k: 3 };

export function laneForKey(key: string): number | undefined {
  return KEY_TO_LANE[key.toLowerCase()];
}

export interface KeyHandlerDeps {
  clock: GameClock;
  engine: {
    judge(lane: number, chartTimeMs: number): void;
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
    deps.engine.judge(lane, deps.clock.chartTimeMs()); // judged at keydown, not next frame
    deps.onAccepted?.(lane);
  };
}
