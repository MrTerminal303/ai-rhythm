import { computeFlux } from "./flux.js";
import { computeLogMel, melFrameCount, type PreprocParams } from "./mel.js";

/**
 * Whole-buffer reference pipeline (B8, D30): the deterministic ground truth
 * that chunked mode must match within `CHUNK_FEATURE_TOL`. `analyzeWhole`
 * runs the flux over the full mono stream — the chunked path's frame
 * sequence must equal this within the tolerance.
 */

/** Tolerance: chunked ≡ whole (review P0 — the continuity contract). */
export const CHUNK_FEATURE_TOL = 1e-6;

export interface WholeReference {
  /** Flat frame-major flux (one value per frame). */
  flux: Float32Array;
  /** Per-frame rows (the protocol layout) of the frame-major log-mel. `undefined` if not requested. */
  mel?: Float32Array[];
}

/**
 * Reference whole-buffer analysis: `flux` = half-wave rectified first
 * difference of magnitude spectra over the shared framing; `mel` = the
 * frame-major log-mel spectrogram (optional — `withMel` opts in).
 *
 * `samples` is MONO (collapse channels first via `toMono` if needed).
 * `sampleRate` must equal `preproc.sr` (the rate contract, D25).
 */
export function analyzeWhole(
  samples: Float32Array,
  sampleRate: number,
  preproc: PreprocParams,
  withMel = false,
): WholeReference {
  if (sampleRate !== preproc.sr) {
    throw new Error(`analyzeWhole: sampleRate ${sampleRate} !== preproc.sr ${preproc.sr}`);
  }
  const flux = computeFlux(samples, preproc);
  const mel = withMel ? melRows(computeLogMel(samples, sampleRate, preproc), preproc.n_mels) : undefined;
  return { flux, mel };
}

// ------------------------------------------------------------------ helpers
/**
 * Per-frame rows (the protocol layout) from a flat frame-major mel array.
 * One `Float32Array(nMels)` row per frame.
 */
export function melRows(flat: Float32Array, nMels: number): Float32Array[] {
  const frames = melFrameCount(flat, nMels);
  const rows: Float32Array[] = [];
  for (let f = 0; f < frames; f++) rows.push(flat.slice(f * nMels, f * nMels + nMels));
  return rows;
}

// flux per-frame rows are defined once in `flux.ts` — re-exported here so the
// reference module's consumers get rows/flattening from the same place.
export { fluxRows, flattenFluxRows } from "./flux.js";
