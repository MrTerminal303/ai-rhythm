// W2 T17: keyup → engine.release, inputChartTime provenance (never clock.chartTimeMs())
import { laneForKey } from "./controller.js";

export interface ReleaseHandlerDeps {
  inputChartTime: (timeStampMs: number) => number;
  engine: {
    release(lane: number, inputMs: number): void;
    isFrozen(): boolean;
  };
}

export function createReleaseHandler(deps: ReleaseHandlerDeps): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    const lane = laneForKey(event.key);
    if (lane === undefined) return;
    if (deps.engine.isFrozen()) return;
    deps.engine.release(lane, deps.inputChartTime(event.timeStamp));
  };
}
