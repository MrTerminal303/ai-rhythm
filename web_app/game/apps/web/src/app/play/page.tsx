"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import w1Chart from "../../../fixtures/w1-chart.json";
import benchChart from "../../../fixtures/w1-benchmark-chart.json";
import { parseBeatmap, type Beatmap } from "@airhythm/shared";
import { PerfMonitor, RENDER_BUDGET_MS } from "../../engine/perf.js";
import { GameEngine } from "../../engine/engine.js";
import { AudioClock } from "../../engine/audio-clock.js";
import { ClockPairKeeper } from "../../engine/clock-pair.js";
import { createKeyHandler, createReleaseHandler, flushHeldLanesBeforePause, laneForKey } from "../../engine/controller.js";
import { SoloPauseController } from "../../engine/pause-controller.js";
import { DeviceChangeDetector } from "../../engine/device-change.js";
import { loadCalibration } from "../../calibration-store.js";
import { WebGLRenderer } from "../../engine/renderer-webgl.js";
import { SnapshotStore, useGameSnapshot } from "../../ui/snapshot-store.js";
import { Hud } from "../../ui/hud.js";

const FLASH_MS = 120; // key-label highlight duration; per-lane so chords light independently

// Play phases: idle → loading → countdown → playing; paused (T10) → countdown → playing (resume)
type Phase = "idle" | "loading" | "countdown" | "playing" | "paused";

// debug hook for e2e (w2-sync) — set on mount, reads live refs
declare global {
  interface Window {
    __w2?: {
      chartTimeMs(): number;
      playbackPositionMs(): number;
      phase(): string;
      noteCount(): number;
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
  const [resuming, setResuming] = useState(false); // true only during the resume 3-2-1 (hides the start button)
  const [deviceToast, setDeviceToast] = useState(false); // output-device change hint (T12)
  const [importError, setImportError] = useState(false); // W2 T18: ?import= present but w2-import unusable

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
  const onKeyUpRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const heldLanesRef = useRef<Set<number>>(new Set()); // W2 T17: lanes with key down; blur flushes releases
  const activeTimers = useRef(new Set<number>()); // key-flash timeout ids
  const mountedRef = useRef(true); // false after unmount — aborts startGame's await chain
  const pauseCtlRef = useRef<SoloPauseController | null>(null);
  if (pauseCtlRef.current === null) pauseCtlRef.current = new SoloPauseController();

  const applyPhase = (p: Phase): void => {
    phaseRef.current = p; // sync first — guards re-entry before React re-renders
    setPhase(p);
  };

  // 3-2-1 countdown (wall-clock, solo form) shared by start and resume — T8 mechanics
  const runCountdown = (onDone: () => void): void => {
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
      onDone();
    };
    timerRef.current = window.setTimeout(tick, 1000);
  };

  // blur / visibilitychange → hidden while playing: flush held-lane releases FIRST,
  // then freeze clock, record position once, show overlay (Review Focus 4, W2 T17)
  const pauseGame = (): void => {
    if (phaseRef.current !== "playing") return;
    const clock = clockRef.current;
    const engine = engineRef.current;
    if (!clock) return;
    flushHeldLanesBeforePause({
      heldLanes: heldLanesRef.current,
      releaseAt: (lane) => {
        if (!engine || engine.isFrozen()) return;
        engine.release(lane, clock.chartTimeAt(performance.now())); // input-domain time, pre-pause
        store.set(engine.snapshot());
      },
      pause: () => {
        clock.pause(); // T7: freezes chartTime/playbackPosition — never throws
        const pausedAt = clock.chartTimeMs(); // frozen value, not a live reading
        pauseCtlRef.current?.pause(pausedAt);
        applyPhase("paused");
      },
    });
  };

  const resumeGame = (): void => {
    if (phaseRef.current !== "paused") return;
    const clock = clockRef.current;
    if (!clock) return;
    const at = pauseCtlRef.current?.pausedAtMs ?? 0;
    setResuming(true);
    runCountdown(() => {
      clock.start(at);
      pauseCtlRef.current?.clear();
      setResuming(false);
      applyPhase("playing");
    });
  };

  // renderer + debug hook at mount: dataset.webglReady must be set BEFORE any click/await (B6 contract)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    mountedRef.current = true; // re-arm on (Strict Mode) remount
    const params = new URLSearchParams(window.location.search);
    const benchmark = params.get("chart") === "benchmark";
    // W2 T18: truthy ?import= → resolve chart from sessionStorage before fixture selection;
    // missing/invalid → inline error + link to /import (no renderer, no start overlay)
    let chart: Beatmap;
    if (!benchmark && params.get("import")) {
      try {
        const raw = sessionStorage.getItem("w2-import");
        if (!raw) throw new Error("w2-import missing from sessionStorage");
        chart = parseBeatmap(JSON.parse(raw));
      } catch (err) {
        console.error("[play] imported chart failed to load:", err);
        setImportError(true);
        return; // mount effect exits without renderer / __w2 / listeners
      }
    } else {
      chart = parseBeatmap(benchmark ? benchChart : w1Chart);
    }
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
      noteCount: () => chart.notes.length,
    };
    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", pauseGame); // tab/window blur while playing → pause (T10)
    const onVisibility = () => {
      if (document.visibilityState === "hidden") pauseGame();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false; // abort startGame's in-flight awaits before tearing down
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      if (onKeyRef.current) window.removeEventListener("keydown", onKeyRef.current);
      if (onKeyUpRef.current) window.removeEventListener("keyup", onKeyUpRef.current);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", pauseGame);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const t of activeTimers.current) window.clearTimeout(t); // key-flash timers must not outlive the effect
      activeTimers.current.clear();
      clockRef.current?.stop(); // teardown path — the only place stop() is used (T10)
      const audioCtx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
      // null the init-chain refs so a continuation that slips past mountedRef fails the init guard
      clockRef.current = null;
      rendererRef.current = null;
      chartRef.current = null;
      perfRef.current = null;
      engineRef.current = null;
      heldLanesRef.current = new Set();
      delete window.__w2;
      renderer.dispose(); // release GL program/buffer (Strict Mode double-mount would leak them)
    };
  }, [store]);

  // output-device change (spec §4.7): poll observe() every 2 s while playing; sinkchange
  // (best-effort, Chromium) marks dirty so the next poll fires even without a latency shift.
  // Polling runs only while playing — paused sessions don't poll (minimal choice, T12).
  useEffect(() => {
    if (phase !== "playing") return;
    const audioCtx = audioCtxRef.current;
    if (!audioCtx) return;
    const detector = new DeviceChangeDetector(() => audioCtx.outputLatency);
    const onSink = (): void => detector.markDirty();
    audioCtx.addEventListener?.("sinkchange", onSink);
    const id = window.setInterval(() => {
      if (detector.observe()) setDeviceToast(true);
    }, 2000);
    return () => {
      window.clearInterval(id);
      audioCtx.removeEventListener?.("sinkchange", onSink);
      setDeviceToast(false); // clear the toast on cleanup
    };
  }, [phase]);

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
      engineRef.current = engine;
      heldLanesRef.current = new Set();

      // 3-2-1 countdown (wall-clock, solo form), then AudioClock.start(0)
      runCountdown(() => {
        clock.start(0);
        applyPhase("playing");
        const rawKey = createKeyHandler({
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
            heldLanesRef.current.add(lane); // W2 T17: track held lanes for blur flush
            setActiveLanes((cur) => (cur.includes(lane) ? cur : [...cur, lane]));
            const flashId = window.setTimeout(() => {
              activeTimers.current.delete(flashId); // fired timers leave the set — only pending ids accumulate (cleanup only needs those)
              setActiveLanes((cur) => cur.filter((l) => l !== lane)); // per-lane expiry — chords never overwrite each other
            }, FLASH_MS);
            activeTimers.current.add(flashId);
          },
        });
        // W2 T17: keyup → engine.release via inputChartTime (never render chartTimeMs)
        const rawRelease = createReleaseHandler({
          inputChartTime: (ts) => clock.chartTimeAt(ts),
          engine: {
            isFrozen: () => engine.isFrozen(),
            release: (lane, time) => {
              engine.release(lane, time);
              store.set(engine.snapshot()); // HUD updates at keyup, same as keydown
            },
          },
        });
        const onKey = (e: KeyboardEvent): void => {
          if (phaseRef.current !== "playing") return; // paused/countdown: no judging (T10); chartTimeAt would throw
          rawKey(e);
        };
        const onKeyUp = (e: KeyboardEvent): void => {
          if (phaseRef.current !== "playing") return;
          const lane = laneForKey(e.key);
          if (lane !== undefined) heldLanesRef.current.delete(lane);
          rawRelease(e);
        };
        onKeyRef.current = onKey;
        onKeyUpRef.current = onKeyUp;
        window.addEventListener("keydown", onKey);
        window.addEventListener("keyup", onKeyUp);
        let lastRaf: number | undefined;
        const frame = (rafMs: number) => {
          if (lastRaf !== undefined) perf.recordFrameInterval(rafMs - lastRaf);
          lastRaf = rafMs;
          if (phaseRef.current !== "playing") {
            // paused/resume-countdown: skip update + render (HUD frozen), keep the loop alive (T10)
            rafRef.current = requestAnimationFrame(frame);
            return;
          }
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
      });
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
      {deviceToast && (
        <div
          role="status"
          data-testid="device-toast"
          className="absolute top-4 left-1/2 -translate-x-1/2 rounded-[6px] border px-4 py-2 text-center"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
          }}
        >
          Output device changed — <a href="/calibrate">recalibrate</a>
        </div>
      )}
      {importError && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ background: "var(--bg)" }}
          data-testid="import-error"
        >
          <p role="alert" style={{ color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
            Could not load the imported chart.
          </p>
          <Link
            href="/import"
            className="rounded-[10px] border px-6 py-3 text-sm"
            style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
          >
            Import a chart
          </Link>
        </div>
      )}
      {!importError && phase !== "playing" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ background: "var(--bg)" }}
          data-testid={phase === "paused" ? "pause-overlay" : "start-overlay"}
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
          {phase === "paused" && (
            <button
              type="button"
              onClick={resumeGame}
              className="cursor-pointer rounded-[6px] border px-6 py-3 text-lg"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Paused — click to resume
            </button>
          )}
          {/* start button stays mounted through loading/countdown (removed at playing): a defensive
              second click in e2e resolves against it and no-ops via the phase guard; hidden during
              the resume countdown so it never competes with the resume flow */}
          {(phase === "idle" || phase === "loading" || (phase === "countdown" && !resuming)) && (
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
          )}
        </div>
      )}
    </main>
  );
}
