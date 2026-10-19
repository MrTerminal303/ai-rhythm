import { fftInPlace, frameCount } from "./mel.js";
import type { PreprocParams } from "./mel.js";

/**
 * Spectral-flux core (B8, D30): the half-wave rectified first difference of
 * magnitude spectra, over the SHARED framing of `mel.ts` (same `n_fft`/`hop`/
 * Hann window + center padding — `computeLogMel`'s frame `f` reads absolute
 * samples `[f*hop - p, f*hop + 3p)` with `p = n_fft/2`). `fftInPlace` is the
 * FFT shared with the mel path (exported from `mel.ts`, behavior unchanged).
 *
 * All magnitude/flux math is Float64 (mel's internal precision); the emitted
 * flux frames are per-frame rows (`Float32Array(1)`) in the protocol layout,
 * and `computeFlux` returns the flat frame-major sequence.
 */

/**
 * The Hann window at `nFft` — re-derived here (identical formula to the one
 * `computeLogMel` builds inline) so the flux path carries its own state and
 * never aliases mel's scratch arrays.
 */
export function hannWindow(nFft: number): Float64Array {
  const w = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
  return w;
}

/** FFT scratch shared by the whole-buffer reference and the chunker. */
export interface FluxWindowState {
  re: Float64Array;
  im: Float64Array;
  window: Float64Array;
  prevMag: Float64Array;
  curMag: Float64Array;
  nBins: number;
}

export function createFluxWindowState(preproc: PreprocParams): FluxWindowState {
  const nFft = preproc.n_fft;
  const nBins = 1 + nFft / 2;
  return {
    re: new Float64Array(nFft),
    im: new Float64Array(nFft),
    window: hannWindow(nFft),
    prevMag: new Float64Array(nBins),
    curMag: new Float64Array(nBins),
    nBins,
  };
}

/**
 * Read the windowed frame at `local` (local index of the window's FIRST sample)
 * from `buf`, run the shared FFT, and advance the half-wave flux accumulator:
 * `flux = Σ_k max(0, mag_k - prevMag_k)`. Swaps `prevMag`/`curMag` in place.
 */
export function chunkFrame(
  buf: Float32Array,
  local: number,
  state: FluxWindowState,
): number {
  const { re, im, window, nBins } = state;
  for (let i = 0; i < re.length; i++) {
    const v = buf[local + i];
    re[i] = (v !== undefined && Number.isFinite(v) ? v : 0) * window[i]!;
    im[i] = 0;
  }
  fftInPlace(re, im);
  const cur = state.curMag;
  const prev = state.prevMag;
  for (let k = 0; k < nBins; k++) cur[k] = Math.hypot(re[k]!, im[k]!);
  let acc = 0;
  for (let k = 0; k < nBins; k++) acc += Math.max(0, cur[k]! - prev[k]!);
  const t = state.prevMag;
  state.prevMag = state.curMag;
  state.curMag = t;
  return acc;
}

/**
 * Reference whole-buffer flux: the flat frame-major sequence, one value per
 * frame (`frameCount(n, hop)` frames). First frame diffs against zero magnitude
 * — the same convention the chunker's stream start uses.
 */
export function computeFlux(mono: Float32Array, preproc: PreprocParams): Float32Array {
  const { n_fft: nFft, hop } = preproc;
  const pad = nFft / 2;
  const state = createFluxWindowState(preproc);
  const frames = frameCount(mono.length, hop);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    // Absolute window start `f*hop - pad`, zero-padded (center-padding contract).
    let acc = 0;
    const { re, im, window, prevMag, curMag, nBins } = state;
    for (let i = 0; i < nFft; i++) {
      const a = f * hop - pad + i;
      re[i] = (a >= 0 && a < mono.length ? mono[a]! : 0) * window[i]!;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < nBins; k++) curMag[k] = Math.hypot(re[k]!, im[k]!);
    for (let k = 0; k < nBins; k++) acc += Math.max(0, curMag[k]! - prevMag[k]!);
    out[f] = acc;
    const t = prevMag;
    state.prevMag = curMag;
    state.curMag = t;
  }
  return out;
}

/** Per-frame rows (the protocol layout) from a flat frame-major flux sequence. */
export function fluxRows(flat: Float32Array): Float32Array[] {
  const rows: Float32Array[] = [];
  for (let i = 0; i < flat.length; i++) rows.push(new Float32Array([flat[i]!]));
  return rows;
}

/** Inverse: flatten per-frame rows back to one frame-major sequence. */
export function flattenFluxRows(rows: Float32Array[]): Float32Array {
  const out = new Float32Array(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = rows[i]![0] ?? 0;
  return out;
}
