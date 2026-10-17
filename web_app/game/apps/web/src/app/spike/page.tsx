"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MEL_FEATURE_TOL, MODEL_OUTPUT_TOL, toAnalysisPcm, toMono, type PreprocParams } from "@airhythm/chartgen";

// B7 spike page (W3 T17) — UNLINKED, dev+E2E only. Default (no query) runs the committed
// 2 s + 30 s vectors for mel/logit parity + the dynamic-T proof; `?benchmark=full` decodes
// the 240 s `long.webm` in-page and streams it to the Worker for the direct §13.3 budget
// measurement (D25). Both modes report; D26 records which category each number came from.

type VectorRun = {
  label: string;
  frames: number;
  shape: string;
  melMae: number | null;
  logitsMaxDiff: number | null;
  melMs: number;
  inferMs: number;
  melSpread: { min: number; max: number; p95: number } | null;
  inferSpread: { min: number; max: number; p95: number } | null;
};

type BenchmarkRun = {
  frames: number;
  samples: number;
  shape: string;
  melMs: number;
  inferMs: number;
  totalMs: number;
  totalSpread: { min: number; max: number; p95: number } | null;
};

const WARMUP = 3;
const MEASURED = 5;

export default function SpikePage() {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [analysisRate, setAnalysisRate] = useState<number | null>(null);
  const [vectors, setVectors] = useState<VectorRun[]>([]);
  const [benchmark, setBenchmark] = useState<BenchmarkRun | null>(null);
  const modeRef = useRef<"vectors" | "benchmark">("vectors");

  useEffect(() => {
    modeRef.current = new URLSearchParams(window.location.search).get("benchmark") === "full" ? "benchmark" : "vectors";
  }, []);

  const run = useCallback(async () => {
    setStatus("running");
    setError(null);
    setVectors([]);
    setBenchmark(null);
    try {
      const [preprocRaw, modelRes, shortWav, longWav, shortMel, longMel, shortLogits, longLogits] =
        await Promise.all([
          fetchJson("/spike/preproc.json"),
          fetch("/spike/toy.onnx").then((r) => r.arrayBuffer()),
          fetch("/spike/input.wav").then((r) => r.arrayBuffer()),
          fetch("/spike/long_input.wav").then((r) => r.arrayBuffer()),
          fetchJson("/spike/expected_mel.json"),
          fetchJson("/spike/expected_mel_long.json"),
          fetchJson("/spike/expected_logits.json"),
          fetchJson("/spike/expected_logits_long.json"),
        ]);
      const preproc = preprocRaw as PreprocParams;
      const modelBytes = new Uint8Array(modelRes);

      const { channels: shortCh, sampleRate: shortRate } = await decodeToAnalysis(shortWav, preproc.sr);
      const { channels: longCh, sampleRate: longRate } = await decodeToAnalysis(longWav, preproc.sr);
      if (shortRate !== preproc.sr) throw new Error(`analysis rate ${shortRate} !== preproc.sr ${preproc.sr}`);
      setAnalysisRate(shortRate);

      const worker = new Worker(new URL("../../spike/spike.worker.ts", import.meta.url));

      if (modeRef.current === "benchmark") {
        const bench = await runBenchmark(worker, { preproc, modelBytes, sr: shortRate });
        setBenchmark(bench);
      } else {
        const runs = await runVectorMode(worker, {
          preproc,
          modelBytes,
          sr: shortRate,
          shortCh,
          longCh,
          shortMel: shortMel as number[][],
          longMel: longMel as number[][],
          shortLogits: shortLogits as number[][][],
          longLogits: longLogits as number[][][],
        });
        setVectors(runs);
      }
      worker.terminate();
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  const melVerdict = verdict(vectors.find((v) => v.label === "short")?.melMae, MEL_FEATURE_TOL);
  const logitsVerdict = verdict(vectors.find((v) => v.label === "short")?.logitsMaxDiff, MODEL_OUTPUT_TOL);
  const shortRun = vectors.find((v) => v.label === "short");
  const longRun = vectors.find((v) => v.label === "long");

  return (
    <main style={{ padding: 24, fontFamily: "monospace", lineHeight: 1.6 }}>
      <h1>B7 spike — toy ONNX in a Worker (W3 T17)</h1>
      <p style={{ maxWidth: 720 }}>
        Protocol D25: mel MAE vs <b>MEL_FEATURE_TOL={MEL_FEATURE_TOL}</b>, logits max-abs-diff vs{" "}
        <b>MODEL_OUTPUT_TOL={MODEL_OUTPUT_TOL}</b>. Warm-up {WARMUP} + median of {MEASURED}. The toy
        model validates the ORT-web plumbing, not the real CRNN.
      </p>
      <button type="button" onClick={() => void run()} disabled={status === "running"}>
        Run spike
      </button>
      <p>
        analysis rate: <span data-testid="analysis-rate">{analysisRate ?? "-"}</span>
        {modeRef.current === "benchmark" && <span data-testid="benchmark-full"> benchmark=full</span>}
      </p>
      {status === "error" && (
        <p role="alert" data-testid="spike-error">
          {error}
        </p>
      )}
      {status === "done" && (
        <span data-testid="spike-done">done</span>
      )}

      {shortRun && (
        <table border={1} cellPadding={6} data-testid="vector-table">
          <tbody>
            <tr>
              <th>mel MAE (short)</th>
              <td data-testid="mel-mae">{fmt(shortRun.melMae)}</td>
            </tr>
            <tr>
              <th>mel verdict</th>
              <td data-testid="mel-verdict">{melVerdict}</td>
            </tr>
            <tr>
              <th>logits maxdiff (short)</th>
              <td data-testid="logits-maxdiff">{fmt(shortRun.logitsMaxDiff)}</td>
            </tr>
            <tr>
              <th>logits verdict</th>
              <td data-testid="logits-verdict">{logitsVerdict}</td>
            </tr>
            <tr>
              <th>shape (short)</th>
              <td data-testid="shape-short">{shortRun.shape}</td>
            </tr>
            <tr>
              <th>shape (long)</th>
              <td data-testid="shape-long">{longRun?.shape ?? "-"}</td>
            </tr>
            <tr>
              <th>infer ms (short)</th>
              <td data-testid="infer-ms">{ms(shortRun.inferMs)}</td>
            </tr>
            <tr>
              <th>infer spread (short, min–max)</th>
              <td data-testid="infer-spread">
                {shortRun.inferSpread ? `${ms(shortRun.inferSpread.min)}–${ms(shortRun.inferSpread.max)}` : "-"}
              </td>
            </tr>
            <tr>
              <th>mel ms (short)</th>
              <td data-testid="mel-ms">{ms(shortRun.melMs)}</td>
            </tr>
          </tbody>
        </table>
      )}

      {benchmark && (
        <table border={1} cellPadding={6} data-testid="benchmark-table">
          <tbody>
            <tr>
              <th>track seconds</th>
              <td data-testid="benchmark-seconds">{ms(benchmark.samples / 22050, 1)}</td>
            </tr>
            <tr>
              <th>T (frames)</th>
              <td data-testid="benchmark-frames">{benchmark.frames}</td>
            </tr>
            <tr>
              <th>total ms (median of {MEASURED})</th>
              <td data-testid="benchmark-total-ms">{ms(benchmark.totalMs, 1)}</td>
            </tr>
            <tr>
              <th>total spread (min–max)</th>
              <td data-testid="benchmark-spread">
                {benchmark.totalSpread
                  ? `${ms(benchmark.totalSpread.min, 1)}–${ms(benchmark.totalSpread.max, 1)}`
                  : "-"}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </main>
  );
}

// ---------------------------------------------------------------- run helpers
async function runVectorMode(
  worker: Worker,
  o: {
    preproc: PreprocParams;
    modelBytes: Uint8Array;
    sr: number;
    shortCh: Float32Array[];
    longCh: Float32Array[];
    shortMel: number[][];
    longMel: number[][];
    shortLogits: number[][][];
    longLogits: number[][][];
  },
): Promise<VectorRun[]> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data as { ok: boolean; runs?: VectorRun[]; error?: string };
      if (!d.ok) reject(new Error(d.error ?? "worker error"));
      else resolve(d.runs!);
    };
    worker.onerror = (e) => reject(new Error(e.message));
    const transfer = [...o.shortCh, ...o.longCh].map((c) => c.buffer as ArrayBuffer);
    worker.postMessage(
      {
        kind: "vectors",
        id: 1,
        sampleRate: o.sr,
        preproc: o.preproc,
        modelBytes: o.modelBytes,
        warmup: WARMUP,
        measured: MEASURED,
        runs: [
          { label: "short", channels: o.shortCh, expectedMel: o.shortMel, expectedLogits: o.shortLogits },
          { label: "long", channels: o.longCh, expectedMel: o.longMel, expectedLogits: o.longLogits },
        ],
      },
      transfer,
    );
  });
}

async function runBenchmark(
  worker: Worker,
  o: { preproc: PreprocParams; modelBytes: Uint8Array; sr: number },
): Promise<BenchmarkRun> {
  const res = await fetch("/spike/long.webm");
  if (!res.ok) throw new Error(`benchmark mode needs /spike/long.webm (${res.status}) — see the report`);
  const { channels } = await decodeToAnalysis(await res.arrayBuffer(), o.sr);
  const mono = toMono(channels);

  const CHUNK = 22050 * 5; // 5 s chunks — single-outstanding-chunk ack backpressure (T24 protocol)
  return new Promise((resolve, reject) => {
    const r = { resolve, reject };
    let acked = 0;
    worker.onmessage = (e) => {
      const d = e.data as { ok: boolean; kind?: string; received?: number; error?: string };
      if (!d.ok) {
        r.reject(new Error(d.error ?? "worker error"));
        return;
      }
      if (d.kind === "benchmark-ack") {
        acked = d.received!;
        if (acked < mono.length) sendChunk(acked);
        else worker.postMessage({ kind: "benchmark-finish", id: 1 });
      } else if (d.kind === "benchmark") {
        r.resolve(e.data as BenchmarkRun);
      }
    };
    worker.onerror = (e) => r.reject(new Error(e.message));
    const sendChunk = (offset: number) => {
      const slice = mono.slice(offset, Math.min(offset + CHUNK, mono.length));
      worker.postMessage({ kind: "benchmark-chunk", id: 1, samples: slice }, [slice.buffer]);    };
    worker.postMessage({
      kind: "benchmark-start",
      id: 1,
      sampleRate: o.sr,
      preproc: o.preproc,
      modelBytes: o.modelBytes,
      warmup: WARMUP,
      measured: MEASURED,
    });
  });
}

/** Decode to preproc.sr — prefer the 22050 AudioContext, fall back to toAnalysisPcm resampling. */
async function decodeToAnalysis(bytes: ArrayBuffer, sr: number): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    .AudioContext;
  try {
    const ctx = new Ctor!({ sampleRate: sr });
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    if (decoded.sampleRate === sr) {
      const channels: Float32Array[] = [];
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const out = new Float32Array(decoded.length);
        decoded.copyFromChannel(out, ch);
        channels.push(out);
      }
      void ctx.close();
      return { channels, sampleRate: sr };
    }
    // context could not be forced to 22050 → resample explicitly
    const res = await toAnalysisPcm(decoded, sr);
    void ctx.close();
    return res;
  } catch {
    const ctx = new Ctor!();
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    const res = await toAnalysisPcm(decoded, sr);
    void ctx.close();
    return res;
  }
}

function average(channels: Float32Array[]): Float32Array {
  const out = new Float32Array(channels[0]!.length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i]! += c[i]! / channels.length;
  return out;
}

function verdict(v: number | null | undefined, tol: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return v <= tol ? "PASS" : "FAIL";
}

function fmt(v: number | null, digits = 6): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return v.toExponential(digits);
}

/** Plain millisecond rendering for timing fields (exponential is unreadable for ms). */
function ms(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return r.json();
}
