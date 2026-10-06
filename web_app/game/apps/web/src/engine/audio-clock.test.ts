// apps/web/src/engine/audio-clock.test.ts
import { describe, expect, it } from "vitest";
import { AudioClock, type AudioClockCtx } from "./audio-clock.js";
import type { ClockPair } from "./time-math.js";

function makeCtx() {
  const calls: { when: number; offset?: number }[] = [];
  const ctx = {
    currentTime: 100,
    createBufferSource() {
      return {
        buffer: null as unknown,
        start(when: number, offset?: number) { calls.push({ when, offset }); },
        stop() {},
      };
    },
  } as AudioClockCtx;
  const pair: ClockPair = { performanceTimeMs: 0, contextTimeSeconds: 100, source: "getOutputTimestamp", sampledAt: 0 };
  return { ctx, calls, keeper: { get: () => pair } };
}

describe("AudioClock", () => {
  it("throws before start (GameClock contract)", () => {
    const { ctx, keeper } = makeCtx();
    const c = new AudioClock(ctx, keeper, () => 0);
    c.load({}, 0);
    expect(() => c.chartTimeMs()).toThrow(/not started/);
  });

  it("start(0): schedules source at ctx time with offset 0; chartTime ≈ 0", () => {
    const { ctx, calls, keeper } = makeCtx();
    const c = new AudioClock(ctx, keeper, () => 0);
    c.load({}, 0);
    c.start(0);
    expect(calls).toEqual([{ when: 100, offset: 0 }]);
    expect(c.chartTimeMs()).toBe(0);
    ctx.currentTime = 103.5;
    expect(c.chartTimeMs()).toBe(3500);
    expect(c.playbackPositionMs()).toBe(3500);
  });

  it("RESTART BOOKKEEPING (Review Focus 2): start(30050) with offset 50 → buffer 30000 scheduled, chart 30050", () => {
    const { ctx, calls, keeper } = makeCtx();
    const c = new AudioClock(ctx, keeper, () => 0);
    c.load({}, 50);
    c.start(30_050);
    expect(calls[0]!.offset).toBe(30);           // 30000 ms = 30 s raw buffer — NOT 30.05
    expect(c.chartTimeMs()).toBe(30_050);        // at restart instant (offset applied once)
    expect(c.playbackPositionMs()).toBe(30_000); // raw domain
  });

  it("negative start chart clamps buffer to 0", () => {
    const { ctx, calls, keeper } = makeCtx();
    const c = new AudioClock(ctx, keeper, () => 0);
    c.load({}, 100);
    c.start(-50);
    expect(calls[0]!.offset).toBe(0);
  });

  it("restart stops the previous source first", () => {
    const { ctx, keeper } = makeCtx();
    let stops = 0;
    const orig = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = () => { const s = orig(); const stopS = s.stop.bind(s); s.stop = () => { stops++; stopS(); }; return s; };
    const c = new AudioClock(ctx, keeper, () => 0);
    c.load({}, 0);
    c.start(0); c.start(1000);
    expect(stops).toBe(1);
  });

  it("pause freezes chartTime and playbackPosition (no throw); resume continues from frozen position", () => {
    const { ctx, calls, keeper } = makeCtx();
    const c = new AudioClock(ctx, keeper, () => 0);
    c.load({}, 50);
    c.start(0);
    ctx.currentTime = 104;              // 4 s played
    expect(c.chartTimeMs()).toBe(4050);
    c.pause();                          // source stopped, state paused
    expect(c.chartTimeMs()).toBe(4050); // frozen — T10 e2e reads this while paused
    expect(c.playbackPositionMs()).toBe(4000);
    ctx.currentTime = 109;              // wall advances while paused — chartTime must NOT move
    expect(c.chartTimeMs()).toBe(4050);
    c.start(c.chartTimeMs());           // resume
    expect(calls.at(-1)!.offset).toBeCloseTo(4.0, 6); // buffer 4000 ms — offset subtracted ONCE
    ctx.currentTime = 110;
    expect(c.chartTimeMs()).toBe(5050); // continues, not restart-from-0
  });

  it("stop() is teardown-only: chartTime throws afterwards", () => {
    const { ctx, keeper } = makeCtx();
    const c = new AudioClock(ctx, keeper, () => 0);
    c.load({}, 0);
    c.start(0);
    c.stop();
    expect(() => c.chartTimeMs()).toThrow(/not started/);
  });
});
