// apps/web/src/engine/play-phase.ts — A12 (spec §3 A12, arch §31).
// Small and explicit: legal transitions, side effects, terminal states.
// NO state-machine library (spec: dependency only on demonstrated need → DECISIONS entry + exact pin).
//
// Side effects are page-owned (asserted by e2e, not by this machine):
//   * → paused | recovering : flushHeldLanesBeforePause BEFORE clock.pause (D7 ordering)
//   paused | recovering → countdown : 3-2-1, then clock.start(recorded position)
//   playing → completed : engine frozen (chart end) — results overlay, distinct from pause (A9/T13)
//   idle → loading : AudioContext creation only inside the start user-gesture
export type PlayPhase = "idle" | "loading" | "countdown" | "playing" | "paused" | "recovering" | "completed";

export const PLAY_TRANSITIONS: Readonly<Record<PlayPhase, readonly PlayPhase[]>> = {
  idle: ["loading"],
  loading: ["countdown", "idle"],
  countdown: ["playing", "idle"],
  playing: ["paused", "recovering", "completed"],
  paused: ["countdown"],
  recovering: ["countdown"],
  completed: ["idle"],
};

export class PlayPhaseMachine {
  private phase: PlayPhase;
  constructor(initial: PlayPhase = "idle") { this.phase = initial; } // production: default; initial = tests only
  get current(): PlayPhase { return this.phase; }
  can(next: PlayPhase): boolean { return PLAY_TRANSITIONS[this.phase].includes(next); }
  to(next: PlayPhase): PlayPhase {
    if (!this.can(next)) throw new Error(`illegal play-phase transition: ${this.phase} → ${next}`);
    this.phase = next;
    return next;
  }
}
