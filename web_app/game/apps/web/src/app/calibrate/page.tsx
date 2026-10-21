"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { associateTaps, computeCalibration, saveCalibration, CALIBRATION_KEY } from "../../calibration-store.js";
import { ClockPairKeeper } from "../../engine/clock-pair.js";
import { audioClockSeconds } from "../../engine/time-math.js";
import { asPerfMs } from "../../engine/branded.js";

// A9 test seam: let a unit test drive the page to a done-with-result state without running
// the metronome (AudioContext/keydown aren't expressible in jsdom). No-op in production.
declare global {
  interface Window {
    __calibrateTest?: { seedResult(v: number | null): void };
  }
}

const BEAT_COUNT = 20; // scheduled metronome clicks (Interfaces)
const BEAT_INTERVAL_MS = 500;
const LEAD_IN_S = 1.0;
const TARGET_PAIRS = 16; // collect until 16 valid pairs
const FLASH_LEAD_MS = 80; // visual flash window before each beat
const WINDOW_MS = 250; // associateTaps default — keep in sync with store default
const LANE_KEYS = new Set(["d", "f", "j", "k"]);

type Phase = "idle" | "running" | "done";

export default function CalibratePage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [flash, setFlash] = useState(false);
  const [validPairs, setValidPairs] = useState(0);
  const [result, setResult] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null); // A9: failed save affordance
  const [startError, setStartError] = useState<string | null>(null); // start failure surfaced near the Start button

  // A9 test seam — let a unit test seed the result state directly. Gated on NEXT_PUBLIC_E2E
  // (inlined at build; e2e webServer sets it, prod builds leave it unset → seam absent).
  // Re-registered every render so the seam drives the LATEST mount's setters.
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_E2E === "1") {
    window.__calibrateTest = { seedResult: (v: number | null) => flushSync(() => { setResult(v); setPhase("done"); }) };
  }

  const phaseRef = useRef<Phase>("idle");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const pairKeeperRef = useRef<ClockPairKeeper | null>(null);
  const beatsRef = useRef<number[]>([]); // ctx-domain ms
  const tapsRef = useRef<number[]>([]); // ctx-domain ms
  const rafRef = useRef(0);
  const endTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  const applyPhase = (p: Phase): void => {
    phaseRef.current = p; // sync first — guards keydown/rAF before React re-renders
    setPhase(p);
  };

  const finishRun = (): void => {
    if (phaseRef.current !== "running") return;
    const pairs = associateTaps(tapsRef.current, beatsRef.current, { windowMs: WINDOW_MS });
    setValidPairs(pairs.length);
    setResult(pairs.length >= TARGET_PAIRS ? computeCalibration(pairs) : null); // else retake prompt
    applyPhase("done");
    setFlash(false);
    cancelAnimationFrame(rafRef.current);
    if (endTimerRef.current !== undefined) window.clearTimeout(endTimerRef.current);
    const audioCtx = audioCtxRef.current; // close stops any clicks still scheduled past 16 pairs
    audioCtxRef.current = null;
    pairKeeperRef.current = null;
    if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
  };

  // keydown registered at mount; phaseRef guards it (stable listener across retakes)
  useEffect(() => {
    mountedRef.current = true;
    const onKey = (e: KeyboardEvent): void => {
      if (phaseRef.current !== "running" || e.repeat) return;
      if (!LANE_KEYS.has(e.key.toLowerCase())) return;
      const pairKeeper = pairKeeperRef.current;
      if (!pairKeeper) return; // tapped before the context resumed
      const pair = pairKeeper.get(performance.now());
      tapsRef.current.push(audioClockSeconds(asPerfMs(e.timeStamp), pair) * 1000);
      const pairs = associateTaps(tapsRef.current, beatsRef.current, { windowMs: WINDOW_MS });
      setValidPairs(pairs.length);
      if (pairs.length >= TARGET_PAIRS) finishRun();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (endTimerRef.current !== undefined) window.clearTimeout(endTimerRef.current);
      window.removeEventListener("keydown", onKey);
      const audioCtx = audioCtxRef.current;
      audioCtxRef.current = null;
      pairKeeperRef.current = null;
      if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
    };
  }, []); // mount-once listener; finishRun closes over refs + stable setters only

  // Start gesture → own AudioContext (autoplay policy, same pattern as the play page)
  const startCalibration = async (): Promise<void> => {
    if (phaseRef.current === "running") return;
    tapsRef.current = [];
    setValidPairs(0);
    setResult(null);
    setSaved(false);
    setFlash(false);
    setStartError(null); // clear any prior failure before this attempt
    applyPhase("running");
    try {
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      await audioCtx.resume(); // user gesture from the click unlocks playback
      if (!mountedRef.current) return; // unmounted mid-await: cleanup already closed the ctx
      const pairKeeper = new ClockPairKeeper(audioCtx, {
        // lib.dom types AudioTimestamp fields as optional; incomplete readings fall back (§4.1)
        readOutputTimestamp: () => {
          const t = audioCtx.getOutputTimestamp();
          return t.performanceTime !== undefined && t.contextTime !== undefined
            ? { performanceTime: t.performanceTime, contextTime: t.contextTime }
            : null;
        },
      });
      pairKeeperRef.current = pairKeeper;

      // 20 clicks every 500 ms on the audio clock; beats recorded in ctx-domain ms
      const t0 = audioCtx.currentTime + LEAD_IN_S;
      const beats: number[] = [];
      for (let i = 0; i < BEAT_COUNT; i++) {
        const when = t0 + i * (BEAT_INTERVAL_MS / 1000);
        beats.push(when * 1000);
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = 1000;
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(0.4, when + 0.002);
        gain.gain.linearRampToValueAtTime(0, when + 0.02); // 20 ms envelope
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(when);
        osc.stop(when + 0.05);
      }
      beatsRef.current = beats;

      // all 20 beats elapsed (+ window grace for the final tap) → stop collecting
      const endDelayMs = beats[BEAT_COUNT - 1]! + WINDOW_MS - audioCtx.currentTime * 1000;
      endTimerRef.current = window.setTimeout(finishRun, endDelayMs);

      // visual flash synced by reading ctx.currentTime each frame
      const frame = (): void => {
        if (phaseRef.current !== "running") return;
        const nowMs = audioCtx.currentTime * 1000;
        const on = beatsRef.current.some((b) => nowMs >= b - FLASH_LEAD_MS && nowMs <= b);
        setFlash((prev) => (prev === on ? prev : on)); // bail-out when unchanged
        rafRef.current = requestAnimationFrame(frame);
      };
      rafRef.current = requestAnimationFrame(frame);
    } catch (err) {
      console.error("[calibrate] start failed:", err);
      setStartError(err instanceof Error ? err.message : String(err)); // user-facing — not console-only
      const audioCtx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
      applyPhase("idle"); // allow retry
    }
  };

  const onSave = (): void => {
    if (result === null) return;
    setSaved(false);
    setSaveError(null);
    try {
      saveCalibration(result);
      // A9: verify persistence by reading back — success ONLY if the stored value matches.
      // Quota failures (setItem throws) or a mismatch must never report "Saved".
      const stored = localStorage.getItem(CALIBRATION_KEY);
      if (stored !== null && Number.parseFloat(stored) === result) {
        setSaved(true);
      } else {
        setSaveError("Save failed — the value could not be persisted. Try again.");
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err)); // A9: never report persisted on failure
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-semibold tracking-tight">Calibrate</h1>
      <p className="text-sm" style={{ color: "var(--text-dim)" }}>
        Tap D F J K in time with the click — 20 beats
      </p>

      {phase === "running" && (
        <div className="flex flex-col items-center gap-3" aria-live="polite">
          <span
            aria-hidden
            className="inline-block h-8 w-8 rounded-full"
            style={{
              border: "1px solid var(--line)",
              background: flash ? "var(--you)" : "var(--surface)",
            }}
          />
          <p data-testid="pair-count" style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
            {validPairs} / {TARGET_PAIRS}
          </p>
        </div>
      )}

      {phase === "done" && result !== null && (
        <div className="flex flex-col items-center gap-3" aria-live="polite">
          <p style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
            Measured offset: {result} ms
          </p>
          <button
            type="button"
            onClick={onSave}
            className="cursor-pointer rounded-[6px] border px-6 py-3 text-lg"
            style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--you)" }}
          >
            {saved ? "Saved" : "Save"}
          </button>
          {/* A9: a failed save is NEVER reported persisted — the affordance says what happened */}
          {saveError && (
            <p
              role="alert"
              data-testid="save-error"
              style={{ color: "var(--warn)", fontFamily: "var(--font-mono)", textAlign: "center" }}
            >
              {saveError}
            </p>
          )}
        </div>
      )}

      {phase === "done" && result === null && (
        <div className="flex flex-col items-center gap-3" aria-live="polite">
          <p style={{ color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
            Only {validPairs} valid taps — need {TARGET_PAIRS}. Retake?
          </p>
        </div>
      )}

      {phase !== "running" && startError && (
        <p
          role="alert"
          data-testid="start-error"
          style={{ color: "var(--warn)", fontFamily: "var(--font-mono)", textAlign: "center" }}
        >
          {startError}
        </p>
      )}

      {phase !== "running" && (
        <button
          type="button"
          onClick={() => void startCalibration()}
          className="cursor-pointer rounded-[6px] border px-6 py-3 text-lg"
          style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text)" }}
        >
          {phase === "idle" ? "Start" : "Retake"}
        </button>
      )}

      <Link href="/" className="text-sm" style={{ color: "var(--text-dim)" }}>
        Back
      </Link>
    </main>
  );
}
