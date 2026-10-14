// apps/web/src/calibration-store.ts
export const CALIBRATION_KEY = "deviceCalibrationOffsetMs";

export function readCalibrationValue(stored: string | null): number {
  if (stored !== null) {
    const v = Number.parseFloat(stored);
    if (isValidCalibration(v)) return v; // finite AND within ±500 ms
  }
  return 0; // A2 (D21): contract-implied fallback — device latency is NEVER a calibration value
}

/** Plausible human-device range (spec-review guard). */
export const CALIBRATION_RANGE_MS = 500;
export function isValidCalibration(v: number): boolean {
  return Number.isFinite(v) && v >= -CALIBRATION_RANGE_MS && v <= CALIBRATION_RANGE_MS;
}

export function loadCalibration(): number {
  if (typeof localStorage === "undefined") return readCalibrationValue(null);
  return readCalibrationValue(localStorage.getItem(CALIBRATION_KEY));
}

export function saveCalibration(ms: number): void {
  if (!isValidCalibration(ms)) throw new Error(`invalid calibration value: ${ms} (must be finite, ±${CALIBRATION_RANGE_MS} ms)`);
  localStorage.setItem(CALIBRATION_KEY, String(ms));
}

export function computeCalibration(samples: { inputMs: number; beatMs: number }[]): number {
  if (samples.length === 0) throw new Error("no calibration taps");
  const diffs = samples.map((s) => s.inputMs - s.beatMs).sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2 === 1 ? diffs[mid]! : (diffs[mid - 1]! + diffs[mid]!) / 2;
}

/** Nearest-not-yet-consumed-beat pairing; rejects pairs beyond windowMs. Beat order preserved. */
export function associateTaps(
  tapCtxMs: number[],
  beatCtxMs: number[],
  opts: { windowMs?: number } = {},
): { inputMs: number; beatMs: number }[] {
  const windowMs = opts.windowMs ?? 250;
  const consumed = new Set<number>();
  const pairs: { inputMs: number; beatMs: number; beatIdx: number }[] = [];
  for (const tap of tapCtxMs) {
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < beatCtxMs.length; i++) {
      if (consumed.has(i)) continue;
      const d = Math.abs(tap - beatCtxMs[i]!);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx === -1 || bestDist > windowMs) continue; // rejected tap — no cascade
    consumed.add(bestIdx);
    pairs.push({ inputMs: tap, beatMs: beatCtxMs[bestIdx]!, beatIdx: bestIdx });
  }
  return pairs.sort((a, b) => a.beatIdx - b.beatIdx).map(({ inputMs, beatMs }) => ({ inputMs, beatMs }));
}
