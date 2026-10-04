"use client";

import { useEffect, useRef } from "react";
import w1Chart from "../../../fixtures/w1-chart.json";
import benchChart from "../../../fixtures/w1-benchmark-chart.json";
import { parseBeatmap } from "@airhythm/shared";
import { GameEngine } from "../../engine/engine.js";
import { PerformanceClock } from "../../engine/clock.js";
import { createKeyHandler } from "../../engine/controller.js";
import { WebGLRenderer } from "../../engine/renderer-webgl.js";

export default function PlayPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    const onKey = createKeyHandler({ clock, engine });
    window.addEventListener("keydown", onKey);

    let raf = 0;
    const frame = () => {
      if (engine.isFrozen()) return; // stop loop after freeze (B5)
      engine.update();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      renderer.dispose(); // release GL program/buffer (Strict Mode double-mount would leak them)
    };
  }, []);

  return (
    <main className="fixed inset-0" style={{ background: "var(--bg)" }}>
      <canvas ref={canvasRef} className="h-full w-full" data-testid="highway" />
    </main>
  );
}
