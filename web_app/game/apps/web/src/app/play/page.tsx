"use client";

import { useEffect, useRef, useState } from "react";
import w1Chart from "../../../fixtures/w1-chart.json";
import benchChart from "../../../fixtures/w1-benchmark-chart.json";
import { parseBeatmap, type Beatmap } from "@airhythm/shared";
import { PerfMonitor, RENDER_BUDGET_MS } from "../../engine/perf.js";
import { GameEngine } from "../../engine/engine.js";
import { AudioClock } from "../../engine/audio-clock.js";
import { ClockPairKeeper } from "../../engine/clock-pair.js";
import { createKeyHandler } from "../../engine/controller.js";
import { loadCalibration } from "../../calibration-store.js";
import { WebGLRenderer } from "../../engine/renderer-webgl.js";
import { SnapshotStore, useGameSnapshot } from "../../ui/snapshot-store.js";
import { Hud } from "../../ui/hud.js";

const FLASH_MS = 120; // key-label highlight duration; per-lane so chords light independently

// Play phases: idle → loading → countdown → playing (pause lands in T10 — keep extensible)
type Phase = "idle" | "loading" | "countdown" | "playing";

// debug hook for e2e (w2-sync) — set on mount, reads live refs
declare global {
  interface Window {
    __w2?: {
      chartTimeMs(): number;
      playbackPositionMs(): number;
      phase(): string;
    };
  }
}

export default function PlayPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const storeRef = useRef<SnapshotStore | null>(null);
  if (storeRef.current === null) storeRef.current = new SnapshotStore();
  const store = storeRef.current;
  const snapshot = useGameSnapshot(store);
  const [activeLanes, setActiveLanes] = useState<number[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(3);

  // refs bridging the mount effect, the click-start flow, and cleanup
  const phaseRef = useRef<Phase>("idle");
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const chartRef = useRef<Beatmap | null>(null);
  const benchmarkRef = useRef(false);
  const perfRef = useRef<PerfMonitor | null>(null);
  const clockRef = useRef<AudioClock | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined); // countdown chain
  const onKeyRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const activeTimers = useRef(new Set<number>()); // key-flash timeout ids
  const mountedRef = useRef(true); // false after unmount — aborts startGame's await chain

  const applyPhase = (p: Phase): void => {
    phaseRef.current = p; // sync first — guards re-entry before React re-renders
    setPhase(p);
  };

  // renderer + debug hook at mount: dataset.webglReady must be set BEFORE any click/await (B6 contract)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    mountedRef.current = true; // re-arm on (Strict Mode) remount
    const benchmark = new URLSearchParams(window.location.search).get("chart") === "benchmark";
    const chart = parseBeatmap(benchmark ? benchChart : w1Chart);
    const renderer = new WebGLRenderer(canvas, chart);
    // signal ONLY after the renderer's constructor succeeded (it throws if WebGL2 is
    // unavailable) — the B6 e2e waits on this attribute instead of calling getContext()
    // itself, which would succeed even if the app never initialized the renderer
    canvas.dataset.webglReady = "true";
    // PerfMonitor created INSIDE the mount effect (stable for the effect's lifetime),
    // never at component scope — React re-renders driven by snapshot updates would
    // otherwise reset the metrics every frame (p95 would be garbage).
    const perf = new PerfMonitor();
    rendererRef.current = renderer;
    chartRef.current = chart;
    benchmarkRef.current = benchmark;
    perfRef.current = perf;
    window.__w2 = {
      chartTimeMs: () => {
        if (!clockRef.current) throw new Error("__w2.chartTimeMs: clock not created yet");
        return clockRef.current.chartTimeMs();
      },
      playbackPositionMs: () => {
        if (!clockRef.current) throw new Error("__w2.playbackPositionMs: clock not created yet");
        return clockRef.current.playbackPositionMs();
      },
      phase: () => phaseRef.current,
    };
    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);
    return () => {
      mountedRef.current = false; // abort startGame's in-flight awaits before tearing down
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      if (onKeyRef.current) window.removeEventListener("keydown", onKeyRef.current);
      window.removeEventListener("resize", onResize);
      for (const t of activeTimers.current) window.clearTimeout(t); // key-flash timers must not outlive the effect
      activeTimers.current.clear();
      const audioCtx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
      // null the init-chain refs so a continuation that slips past mountedRef fails the init guard
      clockRef.current = null;
      rendererRef.current = null;
      chartRef.current = null;
      perfRef.current = null;
      delete window.__w2;
      renderer.dispose(); // release GL program/buffer (Strict Mode double-mount would leak them)
    };
  }, [store]);

  // click-to-start: AudioContext is created INSIDE this handler (autoplay policy)
  const startGame = async (): Promise<void> => {
    if (phaseRef.current !== "idle") return; // defensive second clicks (e2e) are no-ops
    applyPhase("loading");
    try {
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      await audioCtx.resume(); // user gesture from the click unlocks playback
      if (!mountedRef.current) return; // unmounted mid-await: cleanup already closed the ctx
      const res = await fetch("/audio/click-track.wav");
      const audioData = await res.arrayBuffer();
      if (!mountedRef.current) return;
      const buffer = await audioCtx.decodeAudioData(audioData); // "Preparing…" while decoding
      if (!mountedRef.current) return; // never schedule the countdown on a dead page
      const chart = chartRef.current;
      const renderer = rendererRef.current;
      const perf = perfRef.current;
      if (!chart || !renderer || !perf) throw new Error("play page not initialized");
      const pairKeeper = new ClockPairKeeper(audioCtx, {
        // lib.dom types AudioTimestamp fields as optional; incomplete readings fall back (§4.1)
        readOutputTimestamp: () => {
          const t = audioCtx.getOutputTimestamp();
          return t.performanceTime !== undefined && t.contextTime !== undefined
            ? { performanceTime: t.performanceTime, contextTime: t.contextTime }
            : null;
        },
      });
      const clock = new AudioClock(audioCtx, pairKeeper);
      clock.load(buffer, chart.song.audioOffsetMs);
      clockRef.current = clock;
      // outputLatency → first-run default guess (spec §4.5); stored calibration wins inside loadCalibration
      const engine = new GameEngine({
        chart,
        clock,
        renderer,
        perf,
        deviceCalibrationOffsetMs: loadCalibration(audioCtx.outputLatency),
      });
      store.set(engine.snapshot()); // HUD shows 0s once the game is built

      // 3-2-1 countdown (wall-clock, solo form), then AudioClock.start(0)
      applyPhase("countdown");
      setCountdown(3);
      let remaining = 3;
      const tick = (): void => {
        if (!mountedRef.current) return; // timer fired after unmount — do nothing
        remaining -= 1;
        if (remaining > 0) {
          setCountdown(remaining);
          timerRef.current = window.setTimeout(tick, 1000);
          return;
        }
        clock.start(0);
        applyPhase("playing");
        const onKey = createKeyHandler({
          inputChartTime: (ts) => clock.chartTimeAt(ts),
          engine: {
            // wrap judge: emit snapshot at keydown so HUD updates without waiting a frame (§2.3)
            isFrozen: () => engine.isFrozen(),
            judge: (lane, time) => {
              engine.judge(lane, time);
              store.set(engine.snapshot());
            },
          },
          onAccepted: (lane) => {
            setActiveLanes((cur) => (cur.includes(lane) ? cur : [...cur, lane]));
            const flashId = window.setTimeout(() => {
              activeTimers.current.delete(flashId); // fired timers leave the set — only pending ids accumulate (cleanup only needs those)
              setActiveLanes((cur) => cur.filter((l) => l !== lane)); // per-lane expiry — chords never overwrite each other
            }, FLASH_MS);
            activeTimers.current.add(flashId);
          },
        });
        onKeyRef.current = onKey;
        window.addEventListener("keydown", onKey);
        let lastRaf: number | undefined;
        const frame = (rafMs: number) => {
          if (lastRaf !== undefined) perf.recordFrameInterval(rafMs - lastRaf);
          lastRaf = rafMs;
          if (engine.isFrozen()) {
            const report = {
              p95RenderDurationMs: perf.p95RenderDurationMs(),
              p95UpdateDurationMs: perf.p95UpdateDurationMs(),
              p95FrameIntervalMs: perf.p95FrameIntervalMs(),
              samples: perf.sampleCounts(),
              pass: perf.p95RenderDurationMs() <= RENDER_BUDGET_MS,
              chart: benchmarkRef.current ? "benchmark" : "w1",
            };
            console.log("[perf]", report);
            store.set(engine.snapshot()); // final frozen snapshot reaches HUD
            return;
          }
          const t0 = performance.now();
          store.set(engine.update());
          perf.recordUpdateDuration(performance.now() - t0);
          rafRef.current = requestAnimationFrame(frame);
        };
        rafRef.current = requestAnimationFrame(frame);
      };
      timerRef.current = window.setTimeout(tick, 1000);
    } catch (err) {
      console.error("[play] start failed:", err);
      const audioCtx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
      applyPhase("idle"); // allow retry
    }
  };

  return (
    <main className="fixed inset-0" style={{ background: "var(--bg)" }}>
      <canvas ref={canvasRef} className="h-full w-full" data-testid="highway" />
      <Hud snapshot={snapshot} activeLanes={activeLanes} />
      {phase !== "playing" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ background: "var(--bg)" }}
          data-testid="start-overlay"
        >
          {phase === "loading" && (
            <p style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>Preparing…</p>
          )}
          {phase === "countdown" && (
            <p
              data-testid="countdown"
              style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "4rem", lineHeight: 1 }}
            >
              {countdown}
            </p>
          )}
          {/* button stays mounted through loading/countdown (removed at playing): a defensive
              second click in e2e resolves against it and no-ops via the phase guard */}
          <button
            type="button"
            onClick={() => void startGame()}
            className="cursor-pointer rounded-[6px] border px-6 py-3 text-lg"
            style={{
              borderColor: "var(--line)",
              background: "var(--surface)",
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Click to start
          </button>
        </div>
      )}
    </main>
  );
}
