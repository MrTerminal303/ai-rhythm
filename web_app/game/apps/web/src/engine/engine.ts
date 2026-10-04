import type { Beatmap } from "@airhythm/shared";
import { accuracyFraction, scoreFromWeights, JUDGE_WINDOWS } from "@airhythm/shared";
import type { GameClock } from "./clock.js";
import type { GameSnapshot, JudgementEvent, NoteState, Renderer } from "./types.js";

const AUTO_MISS_MS = JUDGE_WINDOWS.good; // single source of truth — never restate 110 (D3)

export interface GameEngineOptions {
  chart: Beatmap;
  clock: GameClock;
  renderer: Renderer;
}

export class GameEngine {
  readonly chart: Beatmap;
  private readonly clock: GameClock;
  private readonly renderer: Renderer;
  private readonly states: NoteState[];
  private readonly totalTargets: number;
  private readonly endTimeMs: number;
  private sumWeights = 0;
  private combo = 0;
  private frozen = false;
  private current: GameSnapshot;
  private prev: GameSnapshot;

  constructor(opts: GameEngineOptions) {
    this.chart = opts.chart;
    this.clock = opts.clock;
    this.renderer = opts.renderer;
    this.states = opts.chart.notes.map(() => "pending");
    this.totalTargets = opts.chart.notes.length;
    this.endTimeMs =
      this.totalTargets === 0
        ? opts.chart.song.durationMs
        : Math.max(...opts.chart.notes.map((n) => n.t)) + AUTO_MISS_MS;
    this.current = this.emit(0, []);
    this.prev = this.current;
  }

  // B3 adds judge(lane, chartTimeMs) here — spec §2.3 pipeline

  update(): GameSnapshot {
    const chartTime = this.clock.chartTimeMs();
    const events = this.markExpiredPendingNotes(chartTime);
    this.renderer.render(chartTime, this.states);
    // B5 adds: freeze when chartTime > endTimeMs (strict) + reject updates once frozen
    const next = this.emit(chartTime, events);
    this.prev = this.current;
    this.current = next;
    return next;
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
