"use client";

import { useEffect, useRef, useState } from "react";
import w1Chart from "../../../fixtures/w1-chart.json";
import benchChart from "../../../fixtures/w1-benchmark-chart.json";
import { parseBeatmap } from "@airhythm/shared";
import { GameEngine } from "../../engine/engine.js";
import { PerformanceClock } from "../../engine/clock.js";
import { createKeyHandler } from "../../engine/controller.js";
import { WebGLRenderer } from "../../engine/renderer-webgl.js";
import { SnapshotStore, useGameSnapshot } from "../../ui/snapshot-store.js";
import { Hud } from "../../ui/hud.js";

const FLASH_MS = 120; // key-label highlight duration; per-lane so chords light independently

export default function PlayPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const storeRef = useRef<SnapshotStore | null>(null);
  if (storeRef.current === null) storeRef.current = new SnapshotStore();
  const store = storeRef.current;
  const snapshot = useGameSnapshot(store);
  const [activeLanes, setActiveLanes] = useState<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const benchmark = new URLSearchParams(window.location.search).get("chart") === "benchmark";
    const chart = parseBeatmap(benchmark ? benchChart : w1Chart);
    const clock = new PerformanceClock();
    const renderer = new WebGLRenderer(canvas, chart);
    // signal ONLY after the renderer's constructor succeeded (it throws if WebGL2 is
    // unavailable) — the B6 e2e waits on this attribute instead of calling getContext()
    // itself, which would succeed even if the app never initialized the renderer
    canvas.dataset.webglReady = "true";
    const engine = new GameEngine({ chart, clock, renderer });
    clock.start(0);
    const activeTimers = new Set<number>(); // key-flash timeout ids; cleared in cleanup below
    const onKey = createKeyHandler({
      clock,
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
          activeTimers.delete(flashId); // fired timers leave the set — only pending ids accumulate (cleanup only needs those)
          setActiveLanes((cur) => cur.filter((l) => l !== lane)); // per-lane expiry — chords never overwrite each other
        }, FLASH_MS);
        activeTimers.add(flashId);
      },
    });
    window.addEventListener("keydown", onKey);

    store.set(engine.snapshot()); // HUD shows 0s on first paint
    let raf = 0;
    const frame = () => {
      if (engine.isFrozen()) return;
      store.set(engine.update());
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      for (const t of activeTimers) window.clearTimeout(t); // key-flash timers must not outlive the effect
      activeTimers.clear();
      renderer.dispose(); // release GL program/buffer (Strict Mode double-mount would leak them)
    };
  }, [store]);

  return (
    <main className="fixed inset-0" style={{ background: "var(--bg)" }}>
      <canvas ref={canvasRef} className="h-full w-full" data-testid="highway" />
      <Hud snapshot={snapshot} activeLanes={activeLanes} />
    </main>
  );
}
