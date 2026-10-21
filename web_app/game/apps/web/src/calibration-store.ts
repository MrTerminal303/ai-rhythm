// apps/web/src/calibration-store.ts
import { getSetting, setSetting } from "./settings/settings.js";

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

/**
 * W3 T22 ruling (see DECISIONS D36): `deviceCalibrationOffsetMs` is stored twice — this
 * legacy key (the gameplay read path, unchanged since W2) and the settings envelope (so
 * settings sync carries the value). ONE-DIRECTIONAL mirror: writing calibration copies the
 * value into the envelope; the envelope is NEVER read back into gameplay, so `loadCalibration`
 * stays the single source of truth for the applied offset and the two can never diverge
 * mid-run. A later settings-side edit lands on the next run (play reads `loadCalibration`).
 */
export function saveCalibration(ms: number): void {
  if (!isValidCalibration(ms)) throw new Error(`invalid calibration value: ${ms} (must be finite, ±${CALIBRATION_RANGE_MS} ms)`);
  localStorage.setItem(CALIBRATION_KEY, String(ms));
  mirrorCalibrationToSettings(ms);
}

function mirrorCalibrationToSettings(ms: number): void {
  try {
    if (getSetting("deviceCalibrationOffsetMs") !== ms) setSetting("deviceCalibrationOffsetMs", ms);
  } catch {
    // the mirror is best-effort portability — a settings/storage failure must never break
    // the save the player just made (the legacy key above is the gameplay source)
  }
}

/**
 * W3 T23 (B6) ruling — how a REMOTE-won `deviceCalibrationOffsetMs` reaches gameplay.
 * D36 made the mirror one-directional (calibration → envelope), which left a hole: a settings
 * sync that pulls a remote-won envelope updates the envelope only, so `loadCalibration` (the
 * single gameplay read path, read at `startGame`) would keep using the OLD offset until the
 * player touched the control — `/settings` would display a value `judgeDt` is not using.
 *
 * The rule: adopt the remote value through `saveCalibration`, i.e. only on a confirmed
 * `ok:true` sync — never per-render, never on an unconfirmed write. That preserves the
 * invariant D36 was protecting (one gameplay source of truth, and it is never written by a
 * mere read): both stores still change together, from one function. Validation is the same
 * guard the calibration control uses (±500 ms, finite); an out-of-range or missing remote
 * value is ignored and the local offset stands (`/settings` keeps the local value).
 *
 * Called AFTER `syncSettings` has finished; that matters — `saveCalibration` mirrors into the
 * envelope with a FRESH rev, so adopting mid-sync would bump the document under the sync loop.
 * A no-op when the merged value already matches the legacy key.
 */
export function adoptRemoteCalibration(remoteValue: unknown): void {
  if (typeof remoteValue !== "number" || !isValidCalibration(remoteValue)) return;
  if (loadCalibration() === remoteValue) return;
  try {
    saveCalibration(remoteValue);
  } catch {
    /* out-of-range is already filtered above; storage failure must not break a sync report */
  }
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
