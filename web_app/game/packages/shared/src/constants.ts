export type Grade = "perfect" | "great" | "good" | "miss";

export const JUDGE_WINDOWS = {
  perfect: 35, // |dt| <= 35
  great: 70, // 35 < |dt| <= 70
  good: 110, // 70 < |dt| <= 110
  miss: Infinity, // |dt| > 110 (or auto-miss at chartTime > note.t + 110)
} as const;

export const SCORE_WEIGHTS: Record<Grade, number> = {
  perfect: 1,
  great: 0.75,
  good: 0.5,
  miss: 0,
};

export const PULSE_DURATION_MS = 80;

export const KEY_COUNT = 4; // lane count — single source for zod literal + renderer geometry
