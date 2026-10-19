import type { Grade } from "@airhythm/shared";

export type NoteState = "pending" | "hit" | "missed";

export type JudgementEvent =
  | { type: "hit"; grade: Grade; lane: number; dt: number; noteId: number }
  | { type: "miss"; lane: number; chartTime: number };

export interface GameSnapshot {
  chartTimeMs: number;
  score: number;
  combo: number;
  accuracy: number;
  frozen: boolean;
  endTimeMs: number;
  events: readonly JudgementEvent[];
  // W3 T21 (B4): additive run-level aggregates (NOT a per-note array — T6 compact shape kept).
  maxCombo: number;
  judgementCounts: Record<Grade, number>;
}

export interface Renderer {
  render(chartTimeMs: number, noteStates: readonly NoteState[]): void;
  dispose(): void; // release GL program/buffer; called from the /play effect cleanup (Strict Mode double-mount would otherwise leak)
}
