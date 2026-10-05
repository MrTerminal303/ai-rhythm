import type { Beatmap } from "@airhythm/shared";
import { accuracyFraction, scoreFromWeights, grade, SCORE_WEIGHTS, JUDGE_WINDOWS } from "@airhythm/shared";
import type { GameClock } from "./clock.js";
import type { GameSnapshot, JudgementEvent, NoteState, Renderer } from "./types.js";
import type { PerfMonitor } from "./perf.js";

const AUTO_MISS_MS = JUDGE_WINDOWS.good; // single source of truth — never restate 110 (D3)

export interface GameEngineOptions {
  chart: Beatmap;
  clock: GameClock;
  renderer: Renderer;
  perf?: PerfMonitor;
}

export class GameEngine {
  readonly chart: Beatmap;
  private readonly clock: GameClock;
  private readonly renderer: Renderer;
  private readonly states: NoteState[];
  private readonly totalTargets: number;
  private readonly endTimeMs: number;
  private readonly perf?: PerfMonitor;
  private sumWeights = 0;
  private combo = 0;
  private frozen = false;
  private current: GameSnapshot;
  private prev: GameSnapshot;

  constructor(opts: GameEngineOptions) {
    this.chart = opts.chart;
    this.clock = opts.clock;
    this.renderer = opts.renderer;
    this.perf = opts.perf;
    this.states = opts.chart.notes.map(() => "pending");
    this.totalTargets = opts.chart.notes.length;
    this.endTimeMs =
      this.totalTargets === 0
        ? opts.chart.song.durationMs
        : Math.max(...opts.chart.notes.map((n) => n.t)) + AUTO_MISS_MS;
    this.current = this.emit(0, []);
    this.prev = this.current;
  }

  judge(lane: number, chartTimeMs: number): void {
    if (this.frozen) throw new Error("engine frozen"); // contract defined here; unreachable until B5 activates freeze (tested in B5)
    const events = this.markExpiredPendingNotes(chartTimeMs);

    let bestIdx = -1;
    let bestAbs = Infinity;
    for (const [i, note] of this.chart.notes.entries()) {
      if (note.lane !== lane || this.states[i] !== "pending") continue;
      const abs = Math.abs(chartTimeMs - note.t);
      if (abs > JUDGE_WINDOWS.good) continue; // same bound as AUTO_MISS_MS — both derive from JUDGE_WINDOWS.good
      const tie = bestIdx !== -1 && note.id < this.chart.notes[bestIdx]!.id;
      if (abs < bestAbs || (abs === bestAbs && tie)) {
        bestAbs = abs;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      const note = this.chart.notes[bestIdx]!;
      const dt = chartTimeMs - note.t;
      const g = grade(dt);
      this.states[bestIdx] = "hit";
      this.combo += 1;
      this.sumWeights += SCORE_WEIGHTS[g];
      events.push({ type: "hit", grade: g, lane, dt, noteId: note.id });
    }

    // emit immediately at keydown: rotation prev ← current ← new
    const next = this.emit(chartTimeMs, events);
    this.prev = this.current;
    this.current = next;
  }

  update(): GameSnapshot {
    if (this.frozen) throw new Error("engine frozen");
    const chartTime = this.clock.chartTimeMs();
    const events = this.markExpiredPendingNotes(chartTime);
    const renderStart = performance.now();
    this.renderer.render(chartTime, this.states);
    this.perf?.recordRenderDuration(performance.now() - renderStart);
    if (chartTime > this.endTimeMs) this.freeze();
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

  protected markExpiredPendingNotes(chartTime: number): JudgementEvent[] {
    const events: JudgementEvent[] = [];
    for (const [i, note] of this.chart.notes.entries()) {
      if (this.states[i] !== "pending") continue;
      if (chartTime > note.t + AUTO_MISS_MS) {
        this.states[i] = "missed";
        this.combo = 0;
        events.push({ type: "miss", lane: note.lane, chartTime });
      }
    }
    return events;
  }

  protected emit(chartTime: number, events: JudgementEvent[]): GameSnapshot {
    return {
      chartTimeMs: chartTime,
      score: scoreFromWeights(this.sumWeights, this.totalTargets),
      combo: this.combo,
      accuracy: accuracyFraction(this.sumWeights, this.totalTargets),
      frozen: this.frozen,
      endTimeMs: this.endTimeMs,
      noteStates: this.states.slice(), // copy — snapshot immutability (§2.7)
      events: events.slice(),
    };
  }
}
