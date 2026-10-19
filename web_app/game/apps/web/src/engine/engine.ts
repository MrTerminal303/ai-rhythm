import type { Beatmap, Grade } from "@airhythm/shared";
import { accuracyFraction, scoreFromWeights, grade, SCORE_WEIGHTS, JUDGE_WINDOWS } from "@airhythm/shared";
import type { GameClock } from "./clock.js";
import { judgeDt } from "./time-math.js";
import { asCalibMs, asChartMs, type ChartMs } from "./branded.js";
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
  private readonly targetsByNote: Target[][] = []; // index = chart note index → that note's targets (≤ 2)
  private readonly states: NoteState[]; // per-NOTE states (aligned with chart.notes) for the renderer
  private readonly totalTargets: number;
  private readonly endTimeMs: number;
  private readonly perf?: PerfMonitor;
  private readonly deviceCalibrationOffsetMs: number;
  private recomputes = 0;
  private sumWeights = 0;
  private combo = 0;
  private maxCombo = 0;
  private judgementCounts: Record<Grade, number> = { perfect: 0, great: 0, good: 0, miss: 0 }; // W3 T21: per-grade aggregates, bumped at the existing grade sites
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
      (this.targetsByNote[noteIdx] ??= []);
      if (note.type === "hold") {
        const d = note.d ?? 0;
        this.targets.push({ noteIdx, noteId: note.id, lane: note.lane, kind: "head", targetMs: note.t, state: "pending" });
        this.targetsByNote[noteIdx]!.push(this.targets[this.targets.length - 1]!);
        this.targets.push({ noteIdx, noteId: note.id, lane: note.lane, kind: "tail", targetMs: note.t + d, state: "pending" });
        this.targetsByNote[noteIdx]!.push(this.targets[this.targets.length - 1]!);
      } else {
        this.targets.push({ noteIdx, noteId: note.id, lane: note.lane, kind: "tap", targetMs: note.t, state: "pending" });
        this.targetsByNote[noteIdx]!.push(this.targets[this.targets.length - 1]!);
      }
    }
    this.totalTargets = this.targets.length;
    this.states = opts.chart.notes.map(() => "pending"); // no recompute count at init
    // endTimeMs = last target's deadline (tap/head: t+110; tail: t+d+150) — tap-only charts keep max(t)+110
    this.endTimeMs =
      this.totalTargets === 0
        ? opts.chart.song.durationMs
        : Math.max(...this.targets.map((t) => t.targetMs + (t.kind === "tail" ? TAIL_WINDOW_MS : AUTO_MISS_MS)));
    this.current = this.emit(asChartMs(0), []);
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
      const dt = judgeDt(asChartMs(inputMs), asCalibMs(this.deviceCalibrationOffsetMs), asChartMs(target.targetMs)); // selection + grading share the calibrated domain (spec §7.1)
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
      this.setTargetState(target, "hit");
      this.combo += 1;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      this.sumWeights += SCORE_WEIGHTS[g];
      this.bumpCount(g);
      events.push({ type: "hit", grade: g, lane, dt: bestDt, noteId: target.noteId });
    }
    // head miss-by-window: nothing marked — stays pending; update() expiry owns it (Review Focus 5)

    // emit immediately at keydown: rotation prev ← current ← new
    const next = this.emit(asChartMs(inputMs), events);
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
      const dt = judgeDt(asChartMs(inputMs), asCalibMs(this.deviceCalibrationOffsetMs), asChartMs(tail.targetMs));
      if (dt < -150) {
        // early release → tail Miss immediately
        this.setTargetState(tail, "missed");
        this.combo = 0;
        this.bumpCount("miss");
        events.push({ type: "miss", lane, chartTime: inputMs });
      } else if (dt <= 150) {
        const g = gradeTail(dt); // |dt| ≤ 150 → perfect/great/good; miss unreachable via release
        this.setTargetState(tail, "hit");
        this.combo += 1;
        if (this.combo > this.maxCombo) this.maxCombo = this.combo; // successful tail increments maxCombo too (full-combo hold = totalTargets)
        this.sumWeights += SCORE_WEIGHTS[g];
        this.bumpCount(g);
        events.push({ type: "hit", grade: g, lane, dt, noteId: tail.noteId });
      }
      // dt > 150 → ignore; the deadline already passed — update() owns expiry
    }

    const next = this.emit(asChartMs(inputMs), events);
    this.prev = this.current;
    this.current = next;
  }

  update(): GameSnapshot {
    if (this.frozen) throw new Error("engine frozen");
    const chartTime = this.clock.chartTimeMs();
    const events = this.markExpiredPendingNotes(chartTime, chartTime - this.deviceCalibrationOffsetMs);
    const renderStart = performance.now();
    this.renderer.render(chartTime, this.states);
    this.perf?.recordRenderDuration(performance.now() - renderStart);
    // Freeze when ALL targets resolved OR chartTime > endTimeMs in BOTH domains
    // (W2 T9 review: chartTime > endTimeMs + max(calib, 0)); unresolved → already missed by sweep.
    // length check: an empty chart has no targets and must NOT freeze via every() (vacuous true).
    const allResolved = this.targets.length > 0 && this.targets.every((t) => t.state !== "pending");
    if (allResolved || (chartTime > this.endTimeMs && chartTime - this.deviceCalibrationOffsetMs > this.endTimeMs)) this.freeze();
    const next = this.emit(asChartMs(chartTime), events);
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
   *
   * A3 fix 1 (incremental per-note state): the per-note cross-product of the old
   * syncStates (O(notes×targets)) is gone. This expiry sweep still *iterates* every
   * target to find overdue work — that is a different loop than the defect named by
   * A3; only the per-note cross-product was removed. State recomputation now happens
   * per changed target only (via setTargetState).
   */
  protected markExpiredPendingNotes(chartTime: number, calibratedChartTime = chartTime): JudgementEvent[] {
    const events: JudgementEvent[] = [];
    for (const target of this.targets) {
      if (target.state !== "pending") continue;
      const expiryMs = target.targetMs + (target.kind === "tail" ? TAIL_WINDOW_MS : AUTO_MISS_MS);
      if (chartTime > expiryMs && calibratedChartTime > expiryMs) {
        this.setTargetState(target, "missed");
        this.combo = 0;
        this.bumpCount("miss");
        events.push({ type: "miss", lane: target.lane, chartTime });
      }
    }
    return events;
  }

  /** A3 fix 1 diagnostic counter: number of per-note state recomputes (operation-count tests; O(1) cost). */
  get noteStateRecomputes(): number {
    return this.recomputes;
  }

  /** Diagnostic view of the internal per-note states array; T6 removes `noteStates` from the snapshot. */
  noteStates(): readonly NoteState[] {
    return this.states;
  }

  /**
   * W3 T21: bump one grade count by REPLACING the record wholesale — never mutate in place, so a
   * snapshot already published keeps its own frozen counts object (Review Focus #4 immutability).
   */
  private bumpCount(g: Grade): void {
    this.judgementCounts = { ...this.judgementCounts, [g]: this.judgementCounts[g] + 1 };
  }

  /** THE ONLY mutation path for target state: assign + recompute that one note's derived state. */
  private setTargetState(target: Target, state: NoteState): void {
    target.state = state;
    this.recomputeNote(target.noteIdx);
  }

  /** Derive `states[noteIdx]` from that note's own targets only — O(≤2), O(1) vs O(notes×targets). */
  private recomputeNote(noteIdx: number): void {
    this.recomputes++;
    let pending = false;
    let allHit = true;
    for (const t of this.targetsByNote[noteIdx] ?? []) {
      if (t.state === "pending") pending = true;
      if (t.state !== "hit") allHit = false;
    }
    this.states[noteIdx] = pending ? "pending" : allHit ? "hit" : "missed";
  }

  protected emit(chartTime: ChartMs, events: JudgementEvent[]): GameSnapshot {
    const score = scoreFromWeights(this.sumWeights, this.totalTargets, this.maxCombo);
    const combo = this.combo;
    const accuracy = accuracyFraction(this.sumWeights, this.totalTargets);
    const frozen = this.frozen;
    const endTimeMs = this.endTimeMs;
    const counts = this.judgementCounts; // stable object identity — replaced wholesale on each observable grade change
    const maxCombo = this.maxCombo;
    const cur = this.current;
    // First emit (constructor) has no current yet — just allocate
    if (cur === undefined) {
      return {
        chartTimeMs: chartTime,
        score,
        combo,
        accuracy,
        frozen,
        endTimeMs,
        events: events.slice(),
        maxCombo,
        judgementCounts: counts, // engine-owned aggregate — carry the reference, not a copy
      };
    }
    // observable-change check FIRST — no allocation on the unchanged path, and a previously
    // published judgement flash must clear (cur.events non-empty → new snapshot with [])
    if (
      events.length === 0 && cur.events.length === 0 &&
      cur.chartTimeMs === chartTime && cur.score === score && cur.combo === combo &&
      cur.accuracy === accuracy && cur.frozen === frozen && cur.endTimeMs === endTimeMs &&
      cur.maxCombo === maxCombo && cur.judgementCounts === counts
    ) {
      return cur; // stable identity — useSyncExternalStore's React infinite-render guard
    }
    return {
      chartTimeMs: chartTime,
      score,
      combo,
      accuracy,
      frozen,
      endTimeMs,
      events: events.slice(), // judgement flash — small, per-event only; NO per-note array (A3)
      maxCombo,
      judgementCounts: counts, // engine-owned aggregate — carry the reference, not a copy
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
