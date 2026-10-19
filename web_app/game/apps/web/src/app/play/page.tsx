"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import w1Chart from "../../../fixtures/w1-chart.json";
import benchChart from "../../../fixtures/w1-benchmark-chart.json";
import { canonicalJson, hashBeatmap, parseBeatmap, rankFor, type Beatmap } from "@airhythm/shared";
import { PerfMonitor, RENDER_BUDGET_MS } from "../../engine/perf.js";
import { GameEngine } from "../../engine/engine.js";
import { AudioClock } from "../../engine/audio-clock.js";
import { ClockPairKeeper, samplePair } from "../../engine/clock-pair.js";
import type { ClockPair } from "../../engine/time-math.js";
import { createKeyHandler, createReleaseHandler, flushHeldLanesBeforePause, laneForKey } from "../../engine/controller.js";
import { SoloPauseController } from "../../engine/pause-controller.js";
import { DeviceChangeDetector } from "../../engine/device-change.js";
import { ResyncController } from "../../engine/resync.js";
import { PlayPhaseMachine, PLAY_TRANSITIONS, type PlayPhase } from "../../engine/play-phase.js";
import { loadCalibration } from "../../calibration-store.js";
import { WebGLRenderer } from "../../engine/renderer-webgl.js";
import { asAudioOffsetMs, asPerfMs, type ChartMs } from "../../engine/branded.js";
import { resolveChartSource, resolveAudioSource, isSafeFixtureName, type AudioSource } from "../../chart-source.js";
import { getChart, loadVerifiedAudio, markDamaged } from "../../library/db.js";
import { SnapshotStore, useGameSnapshot } from "../../ui/snapshot-store.js";
import { buildRunResult, lastRunStore } from "../../ui/last-run.js";
import { Hud } from "../../ui/hud.js";

const FLASH_MS = 120; // key-label highlight duration; per-lane so chords light independently

// W3 T16 (A6) protocol window: the run's first 5 s are discarded before ANY interval statistic is
// recorded, so the gate and the tail cover the post-warm-up window only (decode / shader-compile
// transients never enter the reported numbers) — evidence-templates/w3-perf-protocol.md.
const PERF_WARMUP_MS = 5000;

// W3 T15 (A5): ?fixtureAudio is a dev/E2E-only source (chart-source.ts holds the documented
// precedence). Production builds ignore it — Vercel leaves NEXT_PUBLIC_E2E unset.
const FIXTURE_PARAMS_ENABLED = process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_E2E === "1";

// W3 T2 (D21, round 10 P1-1 regression target): pure extraction of inputProbeRecord's
// calculation — no React state, no side effects — so the recorder is unit-testable
// without a running AudioContext. Kept module-private: the play page is a Next client
// component and its generated .next/types OmitWithTag constraint forbids extra named
// exports (TS2344); the e2e reads the buffer through __w2.inputErrorLog() instead.
interface InputProbeEntry {
  e: number; handlerNow: number; ageMs: number; dispatchDelayMs: number;
  errMs: number; source: string; refUncertaintyMs: number;
  refPerfBefore: number; refPerfAfter: number; refCtxNow0: number;
}

const computeProbeEntry = (
  e: KeyboardEvent,
  cached: ClockPair,
  handlerNow: number,
  ref: { perfBefore: number; perfAfter: number; ctxNow0: number },
): InputProbeEntry => {
  const cachedCtxAtE = cached.contextTimeSeconds + (e.timeStamp - cached.performanceTimeMs) / 1000;
  // The reference anchor is the MIDPOINT of the perfBefore/perfAfter bracket — the ctx
  // read brackets the handler entry, not post-processing time (round 10 P1-1).
  const refPerfMid = (ref.perfBefore + ref.perfAfter) / 2;
  const refCtxAtE = ref.ctxNow0 + (e.timeStamp - refPerfMid) / 1000;
  // Bounded reference uncertainty (round 11 P2-19 + round 12 P2-6): (a) clock-advance
  // uncertainty = bracket width; (b) render-quantum floor ≈ 2.8 ms (48 kHz quantum 2.7,
  // 44.1 kHz 2.9 — repeated reads of currentTime within one quantum return the same value).
  // Do NOT add |e.timeStamp − refPerfMid| — that anchoring offset the formula accounts for.
  const refUncertaintyMs = Math.max(ref.perfAfter - ref.perfBefore, 2.8);
  return {
    e: e.timeStamp,
    handlerNow,
    ageMs: handlerNow - cached.sampledAt,
    dispatchDelayMs: handlerNow - e.timeStamp,
    errMs: Math.abs(cachedCtxAtE - refCtxAtE) * 1000,
    source: cached.source,
    refUncertaintyMs,
    refPerfBefore: ref.perfBefore,
    refPerfAfter: ref.perfAfter,
    refCtxNow0: ref.ctxNow0,
  };
};

// Play phases: driven by the A12 machine (play-phase.ts) — all movement goes through
// applyPhase → machine.to; recovering (W3 T7 / A11) is a first-class machine state.

// debug hook for e2e (w2-sync) — set on mount, reads live refs
type ProbePairResult = {
  source: string;
  residualMs: number | null;
  reason: "accepted" | "missing-timestamp" | "invalid-latency" | "residual-guard";
};
declare global {
  interface Window {
    __w2?: {
      chartTimeMs(): ChartMs;
      playbackPositionMs(): number;
      phase(): string;
      noteCount(): number;
      // W3 T2 (D21) invariant probes
      ctxSnapshot(): {
        currentTime: number;
        baseLatency: number;
        outputLatency: number;
        tsContextTime: number | null;
        tsPerformanceTime: number | null;
      };
      probePair(): ProbePairResult;
      pairSampledAt(): number;
      inputErrorLog(): InputProbeEntry[];
      // W3 T15 (A5) claim-2 evidence hooks
      notes(): { t: number; lane: number }[];
      dts(): number[];
      suspend(): Promise<void>;
      resume(): Promise<void>;
      // W3 T7 (A11): E2E-gated device-change simulation — forces one continuity check with an
      // optional fake chart jump; returns true when the check completed and a recovery pause
      // was entered, false on alignment-ok.
      simulateDeviceChange(fakeJump?: boolean): Promise<boolean>;
      // W3 T16 (A6): logs the CURRENT [perf] report (same serialized `[perf] <json>` line the natural
      // freeze emits) with `completion: "forced"`, and stops the frame loop. The CI-shaped perf run
      // calls it at its force-cap; certification never does.
      forcePerfReport(): void;
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
  const [phase, setPhase] = useState<PlayPhase>("idle");
  const [countdown, setCountdown] = useState(3);
  const [resuming, setResuming] = useState(false); // true only during the resume 3-2-1 (hides the start button)
  const [deviceToast, setDeviceToast] = useState(false); // output-device change hint (T12)
  const [libraryError, setLibraryError] = useState(false); // W3 T19 (B2): ?libraryChartId unresolvable/corrupt
  const [startError, setStartError] = useState<string | null>(null); // startGame failure surfaced in the start overlay

  // refs bridging the mount effect, the click-start flow, and cleanup
  const phaseRef = useRef<PlayPhase>("idle");
  const phaseMachineRef = useRef<PlayPhaseMachine | null>(null);
  if (phaseMachineRef.current === null) phaseMachineRef.current = new PlayPhaseMachine();
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const chartRef = useRef<Beatmap | null>(null);
  const benchmarkRef = useRef(false);
  const perfRef = useRef<PerfMonitor | null>(null);
  const clockRef = useRef<AudioClock | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined); // countdown chain
  const onResizeRef = useRef<(() => void) | null>(null); // W3 T19 (B2): runMount's resize handler (cleanup scope)
  const onEscapeRef = useRef<((e: KeyboardEvent) => void) | null>(null); // W3 T19 (B2)
  const onVisibilityRef = useRef<(() => void) | null>(null); // W3 T19 (B2)
  const onKeyRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const onKeyUpRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const heldLanesRef = useRef<Set<number>>(new Set()); // W2 T17: lanes with key down; blur flushes releases
  const activeTimers = useRef(new Set<number>()); // key-flash timeout ids
  const mountedRef = useRef(true); // false after unmount — aborts startGame's await chain
  const pauseCtlRef = useRef<SoloPauseController | null>(null);
  if (pauseCtlRef.current === null) pauseCtlRef.current = new SoloPauseController();
  const pairKeeperRef = useRef<ClockPairKeeper | null>(null); // D21: lifecycle invalidation + e2e pairSampledAt
  const inputProbeBufferRef = useRef<InputProbeEntry[]>([]); // D21 real-input mapping probe (E2E builds)
  const dtsRef = useRef<number[]>([]); // W3 T15 (A5) claim 2: hit-event dt collection (E2E builds)
  // W3 T16 (A6): THE single [perf] report emitter, created with the frame loop (it closes over the
  // run's PerfMonitor + reportLogged guard). Natural freeze calls it with "natural"; the E2E
  // __w2.forcePerfReport() hook calls it with "forced". One emitter, one log contract.
  const perfReportRef = useRef<((completion: "natural" | "forced") => void) | null>(null);
  const audioSourceRef = useRef<AudioSource>({ kind: "clickTrack" }); // resolved at mount: real .webm vs click track
  const libraryAudioBytesRef = useRef<ArrayBuffer | null>(null); // W3 T19 (B2): verified stored audio for ?libraryChartId
  const resyncRef = useRef<ResyncController | null>(null); // A11 resync machine (T7); created next to pauseCtlRef
  if (resyncRef.current === null) resyncRef.current = new ResyncController();
  // A11 shared handler body: the 2 s poll and the __w2.simulateDeviceChange E2E hook both run
  // this ONE function (review P0: page-level continuity is proven by the hook, not units).
  // Returns true when the alignment-lost verdict entered the recovery pause; false on
  // alignment-ok. Gated on "aligned" + "playing" — the resync table throws otherwise, so the
  // raw poll must not dispatch blindly.
  const resyncCheckRef = useRef<{
    run: (fakeJump?: boolean) => Promise<boolean>;
  } | null>(null);
  if (resyncCheckRef.current === null) {
    resyncCheckRef.current = {
      run: (fakeJump = false): Promise<boolean> => {
        const resync = resyncRef.current!;
        const clock = clockRef.current;
        if (!clock) return Promise.resolve(false);
        if (resync.current !== "aligned") return Promise.resolve(false);
        if (phaseRef.current !== "playing") return Promise.resolve(false);
        const chartBefore = clock.chartTimeMs();
        const wallBefore = performance.now(); // declared measurement interval (review P0)
        resync.dispatch("device-change"); // aligned → resyncing (legal only from aligned)
        return new Promise((resolve) => {
          requestAnimationFrame(() => {
            const wall = performance.now() - wallBefore;
            const jump = fakeJump ? 500 : 0; // fakeJump simulates a discontinuous chart reading
            const chartAfter = clock.chartTimeMs() + jump;
            const ok = Number.isFinite(chartAfter) &&
              chartAfter >= chartBefore &&
              Math.abs(chartAfter - chartBefore - wall) <= 100;
            if (ok) resync.dispatch("alignment-ok"); // resyncing → aligned — stay playing
            else resync.dispatch("alignment-lost"); // resyncing → recovery-paused
            if (ok) {
              setDeviceToast(true); // latency may have shifted — still hint recalibrate
              resolve(false);
            } else {
              enterPause("recovering"); // flush-then-freeze (D7 ordering) into the recovery phase
              resolve(true);
            }
          });
        });
      },
    };
  }

  const applyPhase = (p: PlayPhase): void => {
    const machine = phaseMachineRef.current!; // always constructed above
    machine.to(p); // throws on illegal — bugs surface immediately (A12)
    phaseRef.current = machine.current; // sync bridge for non-React closures (the ONE direct write)
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
  // then freeze clock, record position once, show overlay (Review Focus 4, W2 T17).
  // W3 T7 (A11): extracted into enterPause(target) — the flush-then-freeze order
  // (flushHeldLanesBeforePause → clock.pause() → record → applyPhase(target)) is unchanged;
  // target selects the post-pause phase: "paused" for user/blur pause, "recovering" for
  // device-change / AudioContext-interruption recovery.
  const enterPause = (target: "paused" | "recovering"): void => {
    if (phaseRef.current !== "playing") return;
    const clock = clockRef.current;
    const engine = engineRef.current;
    if (!clock) return;
    flushHeldLanesBeforePause({
      heldLanes: heldLanesRef.current,
      releaseAt: (lane) => {
        if (!engine || engine.isFrozen()) return;
        engine.release(lane, clock.chartTimeAt(asPerfMs(performance.now()))); // input-domain time, pre-pause
        store.set(engine.snapshot());
      },
      pause: () => {
        pairKeeperRef.current?.invalidate(); // D21 round 5 P0-1: BEFORE clock.pause() — no stale pair survives suspend
        clock.pause(); // T7: freezes chartTime/playbackPosition — never throws
        const pausedAt = clock.chartTimeMs(); // frozen value, not a live reading
        pauseCtlRef.current?.pause(pausedAt);
        applyPhase(target);
      },
    });
  };
  const pauseGame = (): void => enterPause("paused");

  const resumeGame = (): void => {
    // W3 T7 (A11): resume accepts BOTH "paused" (user pause) and "recovering" (device-change /
    // interruption recovery) — both render the resume overlay; data-testid distinguishes them.
    if (phaseRef.current !== "paused" && phaseRef.current !== "recovering") return;
    const clock = clockRef.current;
    if (!clock) return;
    const at = pauseCtlRef.current?.pausedAtMs ?? 0;
    // A11: user-resume is dispatched BEFORE the 3-2-1 (recovery-paused → resyncing is legal
    // only from recovery-paused; it must NOT run from "paused" — user pause stays off-machine)
    const fromRecovery = phaseMachineRef.current!.current === "recovering";
    if (fromRecovery) resyncRef.current!.dispatch("user-resume");
    setResuming(true);
    runCountdown(() => {
      clock.start(at);
      pairKeeperRef.current?.invalidate(); // D21 round 5 P0-1: after clock.start() (resume path)
      pauseCtlRef.current?.clear();
      setResuming(false);
      applyPhase("playing");
      if (fromRecovery) resyncRef.current!.dispatch("alignment-ok"); // resyncing → aligned
    });
  };

  // renderer + debug hook at mount: dataset.webglReady must be set BEFORE any click/await (B6 contract)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    mountedRef.current = true; // re-arm on (Strict Mode) remount
    const params = new URLSearchParams(window.location.search);
    const benchmark = params.get("chart") === "benchmark";
    const fixtureAudio = params.get("fixtureAudio");
    // W3 T2 (T15)/T20 source precedence (chart-source.ts) — one resolver, not two param reads:
    //   chart: benchmark > default w1 (the W2 ?import sessionStorage path was removed in T20 —
    //          /import now stores via the T18 library store and links ?libraryChartId below)
    //   audio: fixtureAudio > click track
    // ?fixtureAudio=<name> pairs /songs/<name>.webm with a chart from ANOTHER source (T15 claim 2
    // runs the long.osu chart through /import + long.webm here; A6 pairs the benchmark chart with
    // long audio). The name is validated BEFORE any URL join; production builds cannot select it.
    const sourceParams = { benchmark, fixtureAudio };
    const chartSource = resolveChartSource(sourceParams);
    const audioSource = resolveAudioSource(sourceParams, { fixtureEnabled: FIXTURE_PARAMS_ENABLED });
    if (audioSource.kind === "fixture" && !isSafeFixtureName(audioSource.name)) {
      console.error(`[play] refusing unsafe fixtureAudio source: /songs/${audioSource.name}.webm`);
      setStartError(`Could not load the audio fixture: ${audioSource.name}`);
      return; // no renderer / __w2 / listeners on the unsafe branch
    }
    audioSourceRef.current = audioSource;
    // W3 T19 (B2): the ?libraryChartId branch (highest chart-source precedence per T15's
    // documented order) resolves the stored chartJson + verified audio bytes from the T18
    // store. It is async, so it wraps the shared mount body (renderer, __w2, listeners,
    // frame loop) which runs once the source is settled. On missing/corrupt state the
    // record is marked damaged (review P0) and the inline error renders — no renderer,
    // __w2, or listeners attach on that path.
    const libraryChartId = params.get("libraryChartId");
    const runMount = (resolvedLibraryChart: Beatmap | null, libraryAudio: ArrayBuffer | null): void => {
    // W3 T20: the W2 ?import sessionStorage branch is gone — library beats benchmark beats default
    let chart: Beatmap;
    if (resolvedLibraryChart !== null) {
      chart = resolvedLibraryChart; // W3 T19 (B2): the ?libraryChartId branch won — highest precedence
      libraryAudioBytesRef.current = libraryAudio; // startGame decodes THESE bytes, not the click track
    } else {
      chart = parseBeatmap(chartSource.kind === "benchmark" ? benchChart : w1Chart);
    }
    // A7 (W3 T10): context loss takes the standard pause path — no second pause semantic.
    // onContextLost → enterPause("paused") (D7 flush-then-freeze ordering, as user pause).
    // onContextRestored → GL rebuild is renderer-internal; UI stays paused/resumable. The
    // restored context has no texture, and renderer.initGL() re-armed the atlas load, so we
    // re-invoke initAtlas() here to re-fetch + re-upload it — initAtlas stays idempotent via
    // atlasInitStarted (cannot double-fetch) and a failed re-fetch degrades to the permanent
    // code-drawn path (T13's 5 s timeout) rather than hanging.
    // Held-lanes were flushed at pause (heldLanesRef cleared); a still-held key re-syncs
    // ONLY through normal input semantics on its next event (a still-held key produces no
    // new keydown until re-pressed — no synthetic releases, no artificial keyup dispatch).
    const renderer = new WebGLRenderer(canvas, chart, {
      onContextLost: () => {
        // only a RUNNING game pauses; loss while paused/recovering/completed is renderer-internal
        // (phaseMachineRef is read-only here — the machine owns transitions; enterPause guards)
        if (phaseMachineRef.current!.current === "playing") enterPause("paused");
      },
      onContextRestored: () => { renderer.initAtlas().catch(() => {}); },
    });
    // signal ONLY after the renderer's constructor succeeded (it throws if WebGL2 is
    // unavailable) — the B6 e2e waits on this attribute instead of calling getContext()
    // itself, which would succeed even if the app never initialized the renderer
    canvas.dataset.webglReady = "true";
    // W2 T22: atlas load is opportunistic — kicked off AFTER readiness and never awaited
    // (gameplay never blocks on assets, spec §6.4); rejection consumed so the permanent
    // code-drawn fallback can't surface as an unhandled rejection in the B6 e2e
    renderer.initAtlas().catch(() => {});
    // PerfMonitor created INSIDE the mount effect (stable for the effect's lifetime),
    // never at component scope — React re-renders driven by snapshot updates would
    // otherwise reset the metrics every frame (p95 would be garbage).
    const perf = new PerfMonitor();
    rendererRef.current = renderer;
    chartRef.current = chart;
    benchmarkRef.current = benchmark;
    perfRef.current = perf;
    // I3: live-game debug hook is a timing side-channel for any XSS on this origin.
    // Dev builds get it; production builds only when explicitly opted in — the
    // Playwright webServer sets NEXT_PUBLIC_E2E=1 (inlined at `pnpm build`, since its
    // webServer runs `pnpm build && pnpm start`). Vercel builds leave it unset → absent.
    if (process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_E2E === "1") {
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
        ctxSnapshot: () => {
          const audioCtx = audioCtxRef.current;
          if (!audioCtx) return { currentTime: 0, baseLatency: 0, outputLatency: 0, tsContextTime: null, tsPerformanceTime: null };
          const ts = audioCtx.getOutputTimestamp?.() ?? null;
          return {
            currentTime: audioCtx.currentTime,
            baseLatency: audioCtx.baseLatency,
            outputLatency: audioCtx.outputLatency,
            tsContextTime: ts?.contextTime ?? null,
            tsPerformanceTime: ts?.performanceTime ?? null,
          };
        },
        // probePair runs the REAL samplePair against live ctx state (round 4: the e2e must verify
        // fallback SELECTION, not just raw residuals — one consistent accept/reject contract)
        probePair: () => {
          const audioCtx = audioCtxRef.current;
          if (!audioCtx) return { source: "fallback", residualMs: null, reason: "missing-timestamp" as const };
          // ONE clock snapshot for the whole probe (round 10 P2-7 + round 11 P2-18): the diagnostic
          // residual and the samplePair call MUST use the same captured currentTime.
          const ts = audioCtx.getOutputTimestamp?.() ?? null;
          // AudioTimestamp fields are optional (lib.dom) — normalize so the reader type
          // matches samplePair's contract (incomplete readings fall back inside samplePair)
          const reading = ts && ts.performanceTime !== undefined && ts.contextTime !== undefined
            ? { performanceTime: ts.performanceTime, contextTime: ts.contextTime }
            : null;
          const perfNow = performance.now();
          const ctxNow = audioCtx.currentTime; // captured ONCE, used for both paths
          const lat = { baseLatencySeconds: audioCtx.baseLatency, outputLatencySeconds: audioCtx.outputLatency };
          // Validate BOTH latency components before computing any residual (round 10 P2-7):
          // a partial sum (one valid, one invalid) is NEVER reported as a residual — it would
          // be fabricated, not a measurement.
          const base = lat.baseLatencySeconds, out = lat.outputLatencySeconds;
          const latOk = base !== undefined && Number.isFinite(base) && base >= 0 && out !== undefined && Number.isFinite(out) && out >= 0;
          const pair = samplePair(audioCtx, perfNow, () => reading, lat, { currentTime: ctxNow }); // round 11 P2-18: pass snapshot
          let residualMs: number | null = null;
          let reason: ProbePairResult["reason"];
          if (!reading) {
            reason = "missing-timestamp";
          } else if (!latOk) {
            reason = "invalid-latency"; // residualMs stays null — no fabricated partial sum
          } else {
            // Only now is the residual valid: both latency components present; same ctxNow as samplePair
            residualMs = (ctxNow - (reading.contextTime + (perfNow - reading.performanceTime) / 1000 + base! + out!)) * 1000;
            if (pair.source === "getOutputTimestamp") reason = "accepted";
            else reason = "residual-guard"; // conversion available but rejected by the 25 ms guard
          }
          return { source: pair.source, residualMs, reason };
        },
        pairSampledAt: () => {
          const keeper = pairKeeperRef.current;
          if (!keeper) return 0;
          return keeper.get(performance.now()).sampledAt;
        },
        // W3 T15 (A5) claim 2: the committed fixture map (long.osu, 562 notes) and the dt of every
        // hit this run produced (the judge wrapper below collects them), plus raw AudioContext
        // suspend/resume so the standing suite can freeze the real audio clock.
        notes: () => chart.notes.map((n) => ({ t: n.t, lane: n.lane })),
        dts: () => dtsRef.current.slice(),
        suspend: async () => {
          const audioCtx = audioCtxRef.current;
          if (audioCtx) await audioCtx.suspend();
        },
        resume: async () => {
          const audioCtx = audioCtxRef.current;
          if (audioCtx) await audioCtx.resume();
        },
        inputErrorLog: () => inputProbeBufferRef.current.map((x) => ({ ...x })),
        // W3 T7 (A11) E2E hook: same handler body the 2 s poll runs — forced variant with an
        // optional fake latency jump. Returns true only when the alignment-lost verdict entered
        // the recovery pause; false on alignment-ok or when no check ran (already resyncing or
        // not playing). The continuity check + dispatch sequence is a pure function of clock +
        // resync machine, so both the poll and this hook drive ONE shared body.
        simulateDeviceChange: (fakeJump?: boolean) => resyncCheckRef.current?.run(fakeJump ?? false) ?? Promise.resolve(false),
        // W3 T16 (A6) E2E hook (T12 carry-over): emit the current report once with completion
        // "forced" and stop the loop. forcePerfReportRef is set only once the frame loop exists —
        // before that there is no perf sample to report, so the call is a no-op rather than a
        // fabricated all-zero report.
        forcePerfReport: () => {
          cancelAnimationFrame(rafRef.current);
          perfReportRef.current?.("forced");
        },
      };
    }
    const onResize = () => renderer.resize();
    onResizeRef.current = onResize;
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", pauseGame); // tab/window blur while playing → pause (T10)
    // F-04: user-invokable pause. Its own listener — never routed through the lane key map.
    // Guards every phase: only playing→pause and paused→resume; idle/loading/countdown ignored
    // so Escape can never abort the start or resume 3-2-1.
    const onEscape = (e: KeyboardEvent): void => {
      if (e.repeat) return; // OS auto-repeat while held must not cycle pause↔resume
      if (e.key !== "Escape") return;
      if (phaseMachineRef.current!.current === "playing") pauseGame();
      else if (phaseMachineRef.current!.current === "paused" || phaseMachineRef.current!.current === "recovering") resumeGame();
    };
    window.addEventListener("keydown", onEscape);
    onEscapeRef.current = onEscape;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") pauseGame();
    };
    onVisibilityRef.current = onVisibility;
    document.addEventListener("visibilitychange", onVisibility);
    }; // end runMount — the shared mount body is now callable for any resolved chart source
    // W3 T19 (B2): dispatch by source. ?libraryChartId (highest precedence) resolves the
    // stored chartJson + verified audio bytes from the T18 store (ASYNC — IndexedDB read);
    // on missing/corrupt state it marks the record damaged (review P0) and renders the inline
    // import-error UI instead of a renderer. The non-library path calls runMount straight-line
    // (zero awaits — B6's renderer-readiness ordering is unchanged).
    if (libraryChartId) {
      void (async () => {
        const rec = await getChart(libraryChartId);
        const loaded =
          rec && rec.state !== "damaged" ? await loadVerifiedAudio(libraryChartId) : null;
        if (!rec || !loaded || !loaded.ok) {
          await markDamaged(libraryChartId).catch(() => {}); // missing/corrupt → damaged (review P0)
          setLibraryError(true);
          return; // no renderer / __w2 / listeners on the error branch
        }
        if (!mountedRef.current) return; // unmounted mid-store-read
        let resolved: Beatmap;
        try {
          resolved = parseBeatmap(JSON.parse(rec.chartJson));
        } catch (err) {
          // corrupt chartJson on a record still marked playable → flip it to damaged
          // (consistent with the audio loadVerifiedAudio ok:false path above) and show
          // the library inline error.
          console.error("[play] library chartJson failed to parse:", err);
          await markDamaged(libraryChartId).catch(() => {});
          setLibraryError(true);
          return;
        }
        if (!mountedRef.current) return; // unmounted mid-parse
        runMount(resolved, loaded.bytes);
      })();
      // The run-scoped listeners attached inside runMount are detached by the effect cleanup
      // below (it runs regardless of which source resolved the chart).
      // ponytail: on the async library path runMount may finish after this effect's cleanup
      // already ran; the mountedRef guard right before the runMount call (no await between
      // them) prevents that late mount, so no listener leak on the async path.
    } else {
      runMount(null, null);
    }
    return () => {
      mountedRef.current = false; // abort startGame's in-flight awaits before tearing down
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      if (onKeyRef.current) window.removeEventListener("keydown", onKeyRef.current);
      if (onKeyUpRef.current) window.removeEventListener("keyup", onKeyUpRef.current);
      if (onResizeRef.current) window.removeEventListener("resize", onResizeRef.current);
      window.removeEventListener("blur", pauseGame);
      if (onEscapeRef.current) window.removeEventListener("keydown", onEscapeRef.current);
      if (onVisibilityRef.current) document.removeEventListener("visibilitychange", onVisibilityRef.current);
      for (const t of activeTimers.current) window.clearTimeout(t); // key-flash timers must not outlive the effect
      activeTimers.current.clear();
      clockRef.current?.stop(); // teardown path — the only place stop() is used (T10)
      const audioCtx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
      // null the init-chain refs so a continuation that slips past mountedRef fails the init guard
      rendererRef.current?.dispose(); // release GL program/buffer before nulling the ref
      clockRef.current = null;
      rendererRef.current = null;
      chartRef.current = null;
      libraryAudioBytesRef.current = null; // W3 T19 (B2): stored bytes are run-scoped
      perfRef.current = null;
      perfReportRef.current = null; // the emitter closes over the run's PerfMonitor — do not outlive the effect
      engineRef.current = null;
      heldLanesRef.current = new Set();
      delete window.__w2;
    };
  }, [store]);

  // W2 T12 + W3 T7 (A11): output-device change detection — poll observe() every 2 s while
  // playing. POLL-FALLBACK RATIONALE: no reliable cross-browser output-device-change event
  // exists (sinkchange is Chromium-only and best-effort), so the 2 s poll is retained and
  // subsumed into the A11 resync state machine: the poll only probes from "aligned",
  // coalesces repeats while a check is in flight, and a detected change runs the declared
  // continuity measurement (|ΔchartTime − Δwall| ≤ 100 ms across one frame, no NaN, no
  // backwards jump) — ok → alignment-ok (stay playing, hint recalibrate), lost → recovery
  // pause. sinkchange stays best-effort: it only marks the detector dirty.
  useEffect(() => {
    if (phase !== "playing") return;
    const audioCtx = audioCtxRef.current;
    if (!audioCtx) return;
    const detector = new DeviceChangeDetector(() => audioCtx.outputLatency);
    const onSink = (): void => detector.markDirty();
    audioCtx.addEventListener?.("sinkchange", onSink);
    let checkInFlight = false;
    const resync = resyncRef.current!;
    const check = resyncCheckRef.current!;
    const id = window.setInterval(() => {
      if (checkInFlight || resync.current !== "aligned") return; // coalesce + skip resyncing/recovery states
      if (!detector.observe()) return; // no device change detected
      checkInFlight = true;
      void check.run(false).finally(() => { checkInFlight = false; });
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
    setStartError(null); // clear any prior failure before this attempt
    applyPhase("loading");
    try {
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      await audioCtx.resume(); // user gesture from the click unlocks playback
      if (!mountedRef.current) return; // unmounted mid-await: cleanup already closed the ctx
      const storedBytes = libraryAudioBytesRef.current; // W3 T19 (B2): ?libraryChartId decodes verified stored bytes
      const audioData = storedBytes ?? await (async () => {
        const res = await fetch(audioSourceRef.current.kind === "fixture" ? `/songs/${audioSourceRef.current.name}.webm` : "/audio/click-track.wav");
        if (!res.ok) throw new Error(`Could not load the audio track (HTTP ${res.status})`);
        return res.arrayBuffer();
      })();
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
        readLatency: () => ({ baseLatencySeconds: audioCtx.baseLatency, outputLatencySeconds: audioCtx.outputLatency }), // D21: pair conversion only — both components
      });
      pairKeeperRef.current = pairKeeper;
      inputProbeBufferRef.current = [];
      dtsRef.current = [];
      const clock = new AudioClock(audioCtx, pairKeeper);
      clock.load(buffer, asAudioOffsetMs(chart.song.audioOffsetMs));
      clockRef.current = clock;
      const engine = new GameEngine({
        chart,
        clock,
        renderer,
        perf,
        deviceCalibrationOffsetMs: loadCalibration(),
      });
      store.set(engine.snapshot()); // HUD shows 0s once the game is built
      engineRef.current = engine;
      heldLanesRef.current = new Set();

      // D21 lifecycle invalidation (round 5 P0-1): a pair sampled before a suspension
      // must never map inputs after it (suspended time breaks the perf↔ctx linear
      // extrapolation). AudioContext statechange (both directions) and visibilitychange
      // invalidate the pair keeper.
      const onCtxStateChange = (): void => {
        pairKeeper.invalidate();
        // W3 T7 (A11): AudioContext statechange away from "running" while playing is an
        // interruption — dispatch into the recovery machine, then enter the recovery pause.
        // enterPause's phase guard makes re-entry from the recovery-paused state a no-op,
        // so the repeated "interruption" self-loop is safe.
        if (audioCtx.state !== "running" && phaseMachineRef.current!.current === "playing") {
          resyncRef.current!.dispatch("interruption"); // legal from aligned, resyncing, and recovery-paused
          enterPause("recovering");
        }
      };
      audioCtx.addEventListener?.("statechange", onCtxStateChange);
      const onVisibilityForPair = (): void => {
        pairKeeper.invalidate(); // hidden or visible: re-sample so suspended time never enters extrapolation
      };
      document.addEventListener("visibilitychange", onVisibilityForPair);

      // 3-2-1 countdown (wall-clock, solo form), then AudioClock.start(0)
      runCountdown(() => {
        clock.start(0);
        pairKeeper.invalidate(); // after clock.start() (start path — round 5 P0-1)
        applyPhase("playing");
        // Per-event probe state: the handler's inputChartTime closure records the EXACT
        // pair it mapped through, and the onKey wrapper's recorder reads that same pair
        // (one keeper.get per event, shared by conversion and recorder — round 9 P1-2).
        const probeRef: { pairUsed: ClockPair | null } = { pairUsed: null };
        const rawKey = createKeyHandler({
          inputChartTime: (ts) => {
            const pair = pairKeeperRef.current!.get(performance.now()); // D21: exact pair at mapping time
            probeRef.pairUsed = pair; // recorder measures the EXACT mapped pair
            return clock.chartTimeAt(asPerfMs(ts), pair);
          },
          engine: {
            // wrap judge: emit snapshot at keydown so HUD updates without waiting a frame (§2.3)
            isFrozen: () => engine.isFrozen(),
            judge: (lane, time) => {
              engine.judge(lane, time);
              store.set(engine.snapshot());
              // A5 claim 2 (T15): collect the dt of every HIT this run produced. The snapshot the
              // engine just published carries exactly this call's events (emit slices its own list),
              // so the loop records this hit only — no second judging path, no stale-flash read.
              for (const ev of engine.snapshot().events) {
                if (ev.type === "hit") dtsRef.current.push(ev.dt);
              }
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
          inputChartTime: (ts) => clock.chartTimeAt(asPerfMs(ts)),
          engine: {
            isFrozen: () => engine.isFrozen(),
            release: (lane, time) => {
              engine.release(lane, time);
              store.set(engine.snapshot()); // HUD updates at keyup, same as keydown
            },
          },
        });
        // D21 real-input probe (rounds 8–9, round 10 P1-1): the onKey wrapper obtains the
        // pair ONCE per event (pairKeeper.get(handlerNow)), passes THAT pair to both the
        // conversion (clock.chartTimeAt(ts, pairUsed)) and the recorder — the measured
        // pair is provably the one the game used. The reference snapshot is captured
        // BEFORE rawKey(e) runs so the handler-internal time never contaminates it.
        // D21 real-input probe (rounds 8–9, round 10 P1-1): the onKey wrapper captures the
        // reference snapshot BEFORE rawKey(e) runs so handler-internal time + clock
        // advancement never contaminate it. The mapping itself goes through the KEY HANDLER's
        // inputChartTime closure (clock.chartTimeAt(ts, pairKeeper.get(...)) — same fresh
        // pair every call); the recorder's `cached` pair is the handlerNow pair, the exact
        // object the mapping used at handler entry (keeper cache: same object until expiry).
        const inputProbeRecord = (ev: KeyboardEvent, cached: ClockPair, handlerNow: number, ref: { perfBefore: number; perfAfter: number; ctxNow0: number }): void => {
          if (phaseRef.current !== "playing") return;
          const buf = inputProbeBufferRef.current;
          buf.push(computeProbeEntry(ev, cached, handlerNow, ref));
          if (buf.length > 200) buf.shift();
        };
        const onKey = (e: KeyboardEvent): void => {
          if (phaseRef.current !== "playing") return; // paused/countdown: no judging (T10); chartTimeAt would throw
          const handlerNow = performance.now();
          probeRef.pairUsed = null;
          const ref = {
            perfBefore: handlerNow,
            perfAfter: 0,
            ctxNow0: 0,
          };
          ref.ctxNow0 = audioCtx.currentTime; // captured BEFORE rawKey (round 10 P1-1)
          ref.perfAfter = performance.now(); // bracket width bounds the clock-advance uncertainty
          rawKey(e); // the handler's inputChartTime closure records the EXACT pair it mapped through
          const pairUsed = probeRef.pairUsed;
          if (pairUsed) inputProbeRecord(e, pairUsed, handlerNow, ref);
          // A13: record input latency on accepted lane keys (real event time, not handler-local
          // timing) — dispatch → handler completion; non-lane keys (Escape etc.) don't count
          if (laneForKey(e.key) !== undefined) perf.recordInputLatency(performance.now() - e.timeStamp);
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
        let loopStart = 0; // play-start wall clock; the first PERF_WARMUP_MS of intervals are discarded
        // Report-once guard (T16): the frozen branch below stops the loop (no rAF re-arm), and this
        // boolean makes a stray second entry (e.g. a force call after a natural freeze) log nothing.
        let reportLogged = false;
        const emitPerfReport = (completion: "natural" | "forced"): void => {
          if (reportLogged) return;
          reportLogged = true;
          const tail = perf.frameIntervalsOver(16.7); // T12 helper — already carries the report's key names
          const report = {
            p95RenderDurationMs: perf.p95RenderDurationMs(),
            p95UpdateDurationMs: perf.p95UpdateDurationMs(),
            p95FrameIntervalMs: perf.p95FrameIntervalMs(),
            p99FrameIntervalMs: perf.p99FrameIntervalMs(),
            p95InputLatencyMs: perf.p95InputLatencyMs(),
            inputLatencySamples: perf.inputLatencyCount(),
            heapUsedMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ? Math.round(((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) / 1048576)
              : null,
            samples: perf.sampleCounts(),
            // A6 gate field (T16): pass = FRAME-INTERVAL p95 ≤ 16.7 ms; render duration is data (renderPass)
            pass: perf.p95FrameIntervalMs() <= RENDER_BUDGET_MS,
            renderPass: perf.p95RenderDurationMs() <= RENDER_BUDGET_MS,
            // Report-shape tail (T16). The T12 helper already returns the report's threshold-specific
            // key names (a recorded T12 minor: they hardcode 16.7 while the method takes budgetMs —
            // left alone here on purpose, not reshaped by T16); only p99 is added on this side.
            tail: {
              over16_7Count: tail.over16_7Count,
              over16_7Share: tail.over16_7Share,
              p99FrameIntervalMs: perf.p99FrameIntervalMs(),
              maxFrameIntervalMs: tail.maxFrameIntervalMs,
            },
            completion,
            chart: benchmarkRef.current ? "benchmark" : "w1",
          };
          console.log("[perf] " + JSON.stringify(report)); // one serialized line — natural and forced alike
        };
        perfReportRef.current = emitPerfReport;
        const frame = (rafMs: number) => {
          if (lastRaf !== undefined) {
            // Protocol warm-up exclusion: only frames past PERF_WARMUP_MS enter the series.
            if (loopStart !== 0 && rafMs - loopStart >= PERF_WARMUP_MS) perf.recordFrameInterval(rafMs - lastRaf);
          }
          lastRaf = rafMs;
          if (phaseRef.current !== "playing") {
            // paused/resume-countdown: skip update + render (HUD frozen), keep the loop alive (T10)
            rafRef.current = requestAnimationFrame(frame);
            return;
          }
          if (engine.isFrozen()) {
            if (phaseRef.current === "playing") applyPhase("completed"); // A9: distinct end-of-run state (machine-legal, T8)
            emitPerfReport("natural");
            const finalSnap = engine.snapshot(); // frozen snapshot — single source of truth for B4 results
            store.set(finalSnap); // final frozen snapshot reaches HUD + results overlay
            // W3 T21 (B4): mint the RunResult ONCE at completion (round 3 P1-4) and hand it
            // to B6's store. No auth layer yet → sessionOnly: true; B4 syncs nothing.
            const finishedChart = chartRef.current;
            void (async () => {
              const chartHash = finishedChart ? await hashBeatmap(canonicalJson(finishedChart)) : "";
              lastRunStore.set(buildRunResult(finalSnap, chartHash));
            })();
            // no rAF re-arm: the loop stops, [perf] logs exactly once
            return;
          }
          const t0 = performance.now();
          store.set(engine.update());
          perf.recordUpdateDuration(performance.now() - t0);
          rafRef.current = requestAnimationFrame(frame);
        };
        loopStart = performance.now(); // warm-up window starts at play start, not at module load
        rafRef.current = requestAnimationFrame(frame);
      });
    } catch (err) {
      console.error("[play] start failed:", err);
      setStartError(err instanceof Error ? err.message : String(err)); // user-facing — not console-only
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
      {/* F-04: visible pause control while playing — top-left, clear of the centered readouts
          (they pad left below 584px, hud.tsx) and of the key strip (reflows below 848px) */}
      {phase === "playing" && (
        <button
          type="button"
          data-testid="pause-button"
          aria-label="Pause"
          onClick={pauseGame}
          className="absolute left-4 top-4 flex h-9 w-9 cursor-pointer items-center justify-center rounded-[6px] border"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}
        >
          <span aria-hidden className="flex gap-[3px]">
            <span className="block h-3.5 w-[3px]" style={{ background: "var(--text-dim)" }} />
            <span className="block h-3.5 w-[3px]" style={{ background: "var(--text-dim)" }} />
          </span>
        </button>
      )}
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
      {/* A9 (T13): end-of-run results overlay — DISTINCT from pause. T21 fills the body;
          today it is minimal (title + final score + a way back). The start/pause overlay below
          is excluded from "completed" so the two never share a block. */}
      {libraryError && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ background: "var(--bg)" }}
          data-testid="library-error"
        >
          <p role="alert" style={{ color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
            Could not load the library chart.
          </p>
          <Link
            href="/library"
            className="rounded-[10px] border px-6 py-3 text-sm"
            style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
          >
            Back to library
          </Link>
        </div>
      )}
      {!libraryError && phase === "completed" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ background: "var(--bg)" }}
          data-testid="results-overlay"
        >
          <p
            data-testid="results-title"
            style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}
          >
            Run complete
          </p>
          <p data-testid="results-score" style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
            Score {snapshot?.score ?? 0}
          </p>
          <p data-testid="results-max-combo" style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            Max combo {snapshot?.maxCombo ?? 0}
          </p>
          <p data-testid="results-accuracy" style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            Accuracy {((snapshot?.accuracy ?? 0) * 100).toFixed(1)}%
          </p>
          <p data-testid="results-rank" style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "2rem" }}>
            {rankFor(snapshot?.accuracy ?? 0)}
          </p>
          <p data-testid="results-breakdown" style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {(["perfect", "great", "good", "miss"] as const)
              .map((g) => `${g[0]!.toUpperCase()} ${snapshot?.judgementCounts[g] ?? 0}`)
              .join("  ·  ")}
          </p>
          <Link
            href="/"
            className="rounded-[10px] border px-6 py-3 text-sm"
            style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
          >
            Back to library
          </Link>
        </div>
      )}
      {!libraryError && phase !== "playing" && phase !== "completed" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ background: "var(--bg)" }}
          data-testid={phase === "paused" ? "pause-overlay" : phase === "recovering" ? "recovering-overlay" : "start-overlay"}
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
          {(phase === "paused" || phase === "recovering") && (
            <button
              type="button"
              onClick={resumeGame}
              data-testid={phase === "recovering" ? "recovering-resume-button" : undefined}
              className="cursor-pointer rounded-[6px] border px-6 py-3 text-lg"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {phase === "recovering" ? "Recovering — click to resume" : "Paused — click to resume"}
            </button>
          )}
          {startError && (
            <p
              role="alert"
              data-testid="start-error"
              style={{ color: "var(--warn)", fontFamily: "var(--font-mono)", textAlign: "center" }}
            >
              {startError}
            </p>
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
