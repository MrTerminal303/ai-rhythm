// W2 T17: keyup → engine.release, inputChartTime provenance (never clock.chartTimeMs())
import { KEY_TO_LANE } from "./controller.js";

export interface ReleaseHandlerDeps {
  inputChartTime: (timeStampMs: number) => number;
  engine: {
    release(lane: number, inputMs: number): void;
    isFrozen(): boolean;
  };
  /** W3 T22: resolved lane map (settings `keybinds`); omitted → the default D F J K map.
   *  Must be the SAME map the keydown handler judged through, or a rebind releases
   *  lanes nobody pressed (and never releases the ones that were). */
  lanes?: Record<string, number>;
}

export function createReleaseHandler(deps: ReleaseHandlerDeps): (event: KeyboardEvent) => void {
  const lanes = deps.lanes ?? KEY_TO_LANE;
  return (event: KeyboardEvent) => {
    const lane = lanes[event.key.toLowerCase()];
    if (lane === undefined) return;
    if (deps.engine.isFrozen()) return;
    deps.engine.release(lane, deps.inputChartTime(event.timeStamp));
  };
}
