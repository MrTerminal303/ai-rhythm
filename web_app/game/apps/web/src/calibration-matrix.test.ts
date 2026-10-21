// apps/web/src/calibration-matrix.test.ts — A2 regression matrix + double-application guard
import { describe, expect, it } from "vitest";
import { readCalibrationValue } from "./calibration-store.js";
import { samplePair } from "./engine/clock-pair.js";
import { inputChartTimeMs, judgeDt } from "./engine/time-math.js";
import { asAudioOffsetMs, asBufferMs, asCalibMs, asChartMs, asPerfMs } from "./engine/branded.js";

// Reference instant (review round 1 — one coherent calculation for the whole file;
// rounds 2–3 — latency-object 4th arg AND latency-consistent readings):
//   sourceStartCtxTime = 40 s (chart time 0 there). The output-timestamp READING is derived
//   per call as presentation = scheduled head − latency (truthful pair): with out L the
//   reading at perf 5000 is ctx (40 − L), so scheduled = (40 − L) + 0 + L = 40.000 for ANY
//   latency — the closed-form expectation below holds for zero, undefined, and nonzero alike,
//   and the round-3 residual guard always sees a truthful pair (residual 0).
//   Target = 100 ms in CHART domain (100 ms after sourceStart) — never ctx-absolute.
const LAT = 0.021;
const TARGET_MS = 100;

function latencyArg(outSeconds: number | undefined): { baseLatencySeconds: number; outputLatencySeconds: number } | undefined {
  return outSeconds === undefined ? undefined : { baseLatencySeconds: 0, outputLatencySeconds: outSeconds };
}

function dtWith(
  pairSource: "outputTimestamp" | "fallback",
  stored: string | null,
  latency: number | undefined,
  audioOffsetMs: number,
): number {
  const reading = { performanceTime: 5000, contextTime: 40 - (latency ?? 0) }; // truthful pair for this latency
  const pair =
    pairSource === "outputTimestamp"
      ? samplePair({ currentTime: 40 }, 5000, () => reading, latencyArg(latency))
      : samplePair({ currentTime: 40 }, 5000, () => null, latencyArg(latency));
  const input = inputChartTimeMs(asPerfMs(5000), pair, {
    sourceStartCtxTime: 40,
    audioSourceOffsetMs: asBufferMs(0),
    audioOffsetMs: asAudioOffsetMs(audioOffsetMs),
  });
  const calibration = asCalibMs(readCalibrationValue(stored));
  return judgeDt(input, calibration, asChartMs(TARGET_MS));
}

describe("A2 matrix: {saved, missing, corrupt} × {output-timestamp, fallback} × {−, 0, +} audioOffset × {zero/undefined latency} × pause/resume", () => {
  const storedCases: [string, string | null, number][] = [
    ["saved(50)", "50", 50],
    ["missing", null, 0],
    ["corrupt", "not-a-number", 0],
  ];
  const offsetCases: [string, number][] = [["−30", -30], ["0", 0], ["+40", 40]];

  for (const [sName, stored, expectedCalib] of storedCases) {
    for (const pName of ["outputTimestamp", "fallback"] as const) {
      for (const [oName, offset] of offsetCases) {
        for (const lName of ["zero", "undefined"] as const) {
          const latency = lName === "zero" ? 0 : undefined;
          it(`${sName} × ${pName} × ${oName} × ${lName} → dt = offset − calibration − target (exact)`, () => {
            const dt = dtWith(pName, stored, latency, offset);
            // both pair sources map the reference instant to input = 0 + audioOffset (D21 conversion),
            // so every combo has ONE closed-form expectation — the matrix is real, not labels:
            expect(dt).toBeCloseTo(offset - expectedCalib - TARGET_MS, 6);
          });
        }
      }
    }
  }

  it("changing reported latency: truthful readings keep the mapping stable; inconsistent readings REJECT to fallback (round 3)", () => {
    // truthful pair: presentation moves with latency (presentation = head − latency) → both convert to 40.000
    const truthful = (lat: number) => ({ performanceTime: 5000, contextTime: 40 - lat });
    const a = samplePair({ currentTime: 40 }, 5000, () => truthful(0.021), { baseLatencySeconds: 0, outputLatencySeconds: 0.021 });
    const b = samplePair({ currentTime: 40 }, 5000, () => truthful(0.050), { baseLatencySeconds: 0, outputLatencySeconds: 0.050 });
    expect(a.source).toBe("getOutputTimestamp");
    expect(b.source).toBe("getOutputTimestamp");
    expect(b.contextTimeSeconds).toBeCloseTo(a.contextTimeSeconds, 9); // latency is bookkeeping, not a mapping shift
    // inflated latency with a STALE reading → residual guard rejects the conversion at runtime (never silently wrong)
    const c = samplePair({ currentTime: 40 }, 5000, () => truthful(0.021), { baseLatencySeconds: 0, outputLatencySeconds: 0.050 });
    expect(c.source).toBe("fallback");
    expect(c.contextTimeSeconds).toBe(40); // falls back to the honest ctx.currentTime mapping
    expect(readCalibrationValue(null)).toBe(0); // latency still never becomes a calibration value
  });

  it("pause/resume cannot perturb calibration: the read path takes no clock or latency inputs", () => {
    // pause/resume is a clock operation only (AudioClock, W2 T7); calibration is a pure localStorage read
    expect(readCalibrationValue("50")).toBe(50);
    expect(dtWith("fallback", "50", 0, 0)).toBe(dtWith("fallback", "50", 0, 0)); // deterministic across "pauses"
  });
});

describe("REVIEW FOCUS 1 — double-application guard: outputLatency acts EXACTLY once, via the pair only", () => {
  it("converted pair and no-latency fallback agree at the reference instant; an un-converted reading differs by exactly 1×latency", () => {
    const converted = dtWith("outputTimestamp", null, LAT, 0);
    const fallback = dtWith("fallback", null, LAT, 0);
    expect(converted).toBe(fallback); // conversion makes the domains agree (0 vs 0 input)
    // Pre-T2 bug shape: getOutputTimestamp contextTime used raw (no +latency) → input 39.979−40 = −21 ms:
    const unconverted = judgeDt(
      inputChartTimeMs(asPerfMs(5000), {
        performanceTimeMs: asPerfMs(5000),
        contextTimeSeconds: 39.979 as never,
        source: "getOutputTimestamp",
        sampledAt: asPerfMs(5000),
      }, { sourceStartCtxTime: 40, audioSourceOffsetMs: asBufferMs(0), audioOffsetMs: asAudioOffsetMs(0) }),
      asCalibMs(0),
      asChartMs(TARGET_MS),
    );
    // Exactly one latency missing. This also rules out the double-counted shape: a
    // double-applied outputLatency would read -42, which fails this assertion.
    expect(unconverted - fallback).toBeCloseTo(-21, 6);
  });
  it("grep-level: outputLatency never appears in calibration-store.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./calibration-store.ts", import.meta.url), "utf8");
    expect(src).not.toContain("outputLatency");
  });
});
