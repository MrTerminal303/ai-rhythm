import type { Beatmap } from "@airhythm/shared";
import { accuracyFraction, scoreFromWeights, grade, SCORE_WEIGHTS, JUDGE_WINDOWS } from "@airhythm/shared";
import type { GameClock } from "./clock.js";
import { judgeDt } from "./time-math.js";
import type { GameSnapshot, JudgementEvent, NoteState, Renderer } from "./types.js";
import type { PerfMonitor } from "./perf.js";

const AUTO_MISS_MS = JUDGE_WINDOWS.good; // single source of truth — never restate 110 (D3)
const TAIL_WINDOW_MS = 150; // hold-tail ± window (W2 T17); head/tap stay at JUDGE_WINDOWS.good

export interface GameEngineOptions {
  chart: Beatmap;
  clock: GameClock;
  renderer: Renderer;
  perf?: PerfMonitor;
  deviceCalibrationOffsetMs?: number; // input-path only (W2 T9); auto-miss stays on render chartTime
}

type TargetKind = "tap" | "head" | "tail";

interface Target {
  noteIdx: number;
  noteId: number;
  lane: number;
  kind: TargetKind;
  targetMs: number;
  state: NoteState;
}

export class GameEngine {
  readonly chart: Beatmap;
  private readonly clock: GameClock;
  private readonly renderer: Renderer;
  private readonly targets: Target[];
  private readonly states: NoteState[]; // per-NOTE states (aligned with chart.notes) for the renderer
  private readonly totalTargets: number;
  private readonly endTimeMs: number;
  private readonly perf?: PerfMonitor;
  private readonly deviceCalibrationOffsetMs: number;
  private sumWeights = 0;
  private combo = 0;
  private maxCombo = 0;
  private frozen = false;
  private current: GameSnapshot;
  private prev: GameSnapshot;

  constructor(opts: GameEngineOptions) {
    this.chart = opts.chart;
    this.clock = opts.clock;
    this.renderer = opts.renderer;
    this.perf = opts.perf;
    this.deviceCalibrationOffsetMs = opts.deviceCalibrationOffsetMs ?? 0;
    // Target model (W2 T17): tap → (id, "tap"); hold → (id, "head") + (id, "tail");
    // totalTargets = taps + 2×holds = targets.length — score/accuracy denominators.
    this.targets = [];
    for (const [noteIdx, note] of opts.chart.notes.entries()) {
      if (note.type === "hold") {
        const d = note.d ?? 0;
        this.targets.push({ noteIdx, noteId: note.id, lane: note.lane, kind: "head", targetMs: note.t, state: "pending" });
        this.targets.push({ noteIdx, noteId: note.id, lane: note.lane, kind: "tail", targetMs: note.t + d, state: "pending" });
      } else {
        this.targets.push({ noteIdx, noteId: note.id, lane: note.lane, kind: "tap", targetMs: note.t, state: "pending" });
      }
    }
    this.totalTargets = this.targets.length;
    this.states = opts.chart.notes.map(() => "pending");
    // endTimeMs = last target's deadline (tap/head: t+110; tail: t+d+150) — tap-only charts keep max(t)+110
    this.endTimeMs =
      this.totalTargets === 0
        ? opts.chart.song.durationMs
        : Math.max(...this.targets.map((t) => t.targetMs + (t.kind === "tail" ? TAIL_WINDOW_MS : AUTO_MISS_MS)));
    this.current = this.emit(0, []);
    this.prev = this.current;
  }

  judge(lane: number, inputMs: number): void {
    if (this.frozen) throw new Error("engine frozen"); // contract defined here; unreachable until B5 activates freeze (tested in B5)
    const calibratedInputMs = inputMs - this.deviceCalibrationOffsetMs;
    const events = this.markExpiredPendingNotes(inputMs, calibratedInputMs);

    let bestIdx = -1;
    let bestDt = 0;
    let bestAbs = Infinity;
    for (const [i, target] of this.targets.entries()) {
      if (target.lane !== lane || target.state !== "pending") continue;
      if (target.kind !== "tap" && target.kind !== "head") continue; // judge resolves head/tap only; tails wait for release/expiry
      const dt = judgeDt(inputMs, this.deviceCalibrationOffsetMs, target.targetMs); // selection + grading share the calibrated domain (spec §7.1)
      const abs = Math.abs(dt);
      if (abs > JUDGE_WINDOWS.good) continue; // same bound as AUTO_MISS_MS — both derive from JUDGE_WINDOWS.good
      const tie = bestIdx !== -1 && target.noteId < this.targets[bestIdx]!.noteId;
      if (abs < bestAbs || (abs === bestAbs && tie)) {
        bestAbs = abs;
        bestIdx = i;
        bestDt = dt;
      }
    }

    if (bestIdx !== -1) {
      const target = this.targets[bestIdx]!;
      const g = grade(bestDt); // |bestDt| ≤ good → can never be "miss" (controller ruling, W2 T9)
      target.state = "hit";
      this.combo += 1;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      this.sumWeights += SCORE_WEIGHTS[g];
      events.push({ type: "hit", grade: g, lane, dt: bestDt, noteId: target.noteId });
    }
    // head miss-by-window: nothing marked — stays pending; update() expiry owns it (Review Focus 5)

    // emit immediately at keydown: rotation prev ← current ← new
    this.syncStates();
    const next = this.emit(inputMs, events);
    this.prev = this.current;
    this.current = next;
  }

  release(lane: number, inputMs: number): void {
    if (this.frozen) throw new Error("engine frozen");
    const events = this.markExpiredPendingNotes(inputMs, inputMs - this.deviceCalibrationOffsetMs);

    let tailIdx = -1;
    for (const [i, target] of this.targets.entries()) {
      if (target.lane === lane && target.state === "pending" && target.kind === "tail") {
        tailIdx = i;
        break;
      }
    }

    if (tailIdx !== -1) {
      const tail = this.targets[tailIdx]!;
      // ONE calibrated timing domain for every branch (controller ruling, W2 T17)
      const dt = judgeDt(inputMs, this.deviceCalibrationOffsetMs, tail.targetMs);
      if (dt < -150) {
        // early release → tail Miss immediately
        tail.state = "missed";
        this.combo = 0;
        events.push({ type: "miss", lane, chartTime: inputMs });
      } else if (dt <= 150) {
        const g = gradeTail(dt); // |dt| ≤ 150 → perfect/great/good; miss unreachable via release
        tail.state = "hit";
        this.combo += 1;
        if (this.combo > this.maxCombo) this.maxCombo = this.combo; // successful tail increments maxCombo too (full-combo hold = totalTargets)
        this.sumWeights += SCORE_WEIGHTS[g];
        events.push({ type: "hit", grade: g, lane, dt, noteId: tail.noteId });
      }
      // dt > 150 → ignore; the deadline already passed — update() owns expiry
    }

    this.syncStates();
    const next = this.emit(inputMs, events);
    this.prev = this.current;
    this.current = next;
  }

  update(): GameSnapshot {
    if (this.frozen) throw new Error("engine frozen");
    const chartTime = this.clock.chartTimeMs();
    const events = this.markExpiredPendingNotes(chartTime, chartTime - this.deviceCalibrationOffsetMs);
    this.syncStates();
    const renderStart = performance.now();
    this.renderer.render(chartTime, this.states);
    this.perf?.recordRenderDuration(performance.now() - renderStart);
    // Freeze when ALL targets resolved OR chartTime > endTimeMs in BOTH domains
    // (W2 T9 review: chartTime > endTimeMs + max(calib, 0)); unresolved → already missed by sweep.
    // length check: an empty chart has no targets and must NOT freeze via every() (vacuous true).
    const allResolved = this.targets.length > 0 && this.targets.every((t) => t.state !== "pending");
    if (allResolved || (chartTime > this.endTimeMs && chartTime - this.deviceCalibrationOffsetMs > this.endTimeMs)) this.freeze();
    const next = this.emit(chartTime, events);
    this.prev = this.current;
    this.current = next;
    return next;
  }

  private freeze(): void {
    this.frozen = true;
  }

  snapshot(): GameSnapshot {
    return this.current;
  }

  previousSnapshot(): GameSnapshot {
    return this.prev;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Miss only when overdue in BOTH domains (W2 T9 review): raw AND calibrated past
   * the target's deadline — tap/head: targetMs + 110; tail: targetMs + 150
   * (= (t+d) + 150). Equivalently deadline + max(calib, 0): positive calibration
   * never pre-ents a still-valid calibrated input; negative never expires early.
   * `calibratedChartTime` defaults to `chartTime` (raw) for single-domain callers.
   * A missed head never touches its tail (Review Focus 5).
   */
  protected markExpiredPendingNotes(chartTime: number, calibratedChartTime = chartTime): JudgementEvent[] {
    const events: JudgementEvent[] = [];
    for (const target of this.targets) {
      if (target.state !== "pending") continue;
      const expiryMs = target.targetMs + (target.kind === "tail" ? TAIL_WINDOW_MS : AUTO_MISS_MS);
      if (chartTime > expiryMs && calibratedChartTime > expiryMs) {
        target.state = "missed";
        this.combo = 0;
        events.push({ type: "miss", lane: target.lane, chartTime });
      }
    }
    return events;
  }

  /** Per-NOTE states for the renderer: pending if any target pending; hit iff all hit; else missed. */
  private syncStates(): void {
    for (let i = 0; i < this.states.length; i++) {
      let pending = false;
      let allHit = true;
      for (const target of this.targets) {
        if (target.noteIdx !== i) continue;
        if (target.state === "pending") pending = true;
        if (target.state !== "hit") allHit = false;
      }
      this.states[i] = pending ? "pending" : allHit ? "hit" : "missed";
    }
  }

  protected emit(chartTime: number, events: JudgementEvent[]): GameSnapshot {
    return {
      chartTimeMs: chartTime,
      score: scoreFromWeights(this.sumWeights, this.totalTargets, this.maxCombo),
      combo: this.combo,
      accuracy: accuracyFraction(this.sumWeights, this.totalTargets),
      frozen: this.frozen,
      endTimeMs: this.endTimeMs,
      noteStates: this.states.slice(), // copy — snapshot immutability (§2.7)
      events: events.slice(),
    };
  }
}

/** gradeTail (W2 T17): |dt| ≤ 35 perfect, ≤ 70 great, ≤ 150 good; miss unreachable via release. */
function gradeTail(dt: number): "perfect" | "great" | "good" | "miss" {
  const absDt = Math.abs(dt);
  if (absDt <= JUDGE_WINDOWS.perfect) return "perfect";
  if (absDt <= JUDGE_WINDOWS.great) return "great";
  return "good";
}
