import { describe, expect, it } from "vitest";
import type { Beatmap } from "@airhythm/shared";
import { GameEngine } from "./engine.js";
import { PerformanceClock } from "./clock.js";
import { PerfMonitor } from "./perf.js";
import type { Renderer } from "./types.js";

const chart: Beatmap = {
  version: 1,
  meta: { title: "t", artist: "a", creator: "c", difficulty: "d", tags: [], previewMs: 0 },
  song: { songKey: "file:t", durationMs: 10_000, audioOffsetMs: 0 },
  timing: [{ t: 0, bpm: 120, meter: 4 }],
  keys: 4,
  notes: [{ id: 0, t: 1000, lane: 0, type: "tap" }],
  pulses: [],
  gen: { source: "manual", timingSource: "manual" },
};
class FakeTime {
  t = 0;
  nowMs() { return this.t; }
}
const renderer: Renderer = { render: () => {}, dispose: () => {} };

it("engine.update records render duration through an attached PerfMonitor", () => {
  const perf = new PerfMonitor();
  const src = new FakeTime();
  const clock = new PerformanceClock(src);
  const engine = new GameEngine({ chart, clock, renderer, perf });
  clock.start(0);
  engine.update();
  expect(perf.sampleCounts().renders).toBe(1); // fails if this.perf?.recordRenderDuration(...) is deleted from update()
  expect(perf.p95RenderDurationMs()).toBeGreaterThanOrEqual(0);
});