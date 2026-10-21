import { z } from "zod";

// CSP: zod 4's allowsEval() probes with `new Function("")`; a strict script-src logs that
// as a securitypolicyviolation even though the throw is swallowed (zod #4461/#5041).
// jitless makes the probe return early — set before any schema is constructed/parsed.
z.config({ jitless: true });

/**
 * Deterministic audio analysis (B7's first slice of `packages/chartgen`, PLAN §13).
 *
 * Everything here is a pure function of (samples, sampleRate, preproc). The
 * preprocessing contract is the committed `preproc.json` (D25) — the SAME file
 * the Python generator read to produce `expected_mel.json`, so the TS and Python
 * sides can never drift onto different parameters.
 */

/** Fixed by D25 — a measured MAE may not re-define these (threshold-shopping ban). */
export const MEL_FEATURE_TOL = 1e-3;
export const MODEL_OUTPUT_TOL = 1e-3;

const PREPROC_SCHEMA = z.object({
  version: z.number().int(),
  sr: z.number().int().positive(),
  channels: z.number().int().positive(),
  n_fft: z.number().int().positive(),
  hop: z.number().int().positive(),
  n_mels: z.number().int().positive(),
  fmin: z.number(),
  fmax: z.number(),
  htk: z.boolean(),
  norm: z.literal("slaney"),
  power: z.number(),
  log: z.literal("power_to_db_ref_max"),
  amin: z.number(),
  top_db: z.number(),
  center: z.boolean(),
  pad_mode: z.string(),
  window: z.literal("hann"),
});

export type PreprocParams = z.infer<typeof PREPROC_SCHEMA>;

/** Parse the committed `preproc.json` (single source of truth for both languages). */
export function parsePreproc(json: unknown): PreprocParams {
  return PREPROC_SCHEMA.parse(json);
}

// --------------------------------------------------------------------- mel bank
const SLANEY_F_SP = 200.0 / 3.0;
const SLANEY_MIN_LOG_HZ = 1000.0;
const SLANEY_MIN_LOG_MEL = (SLANEY_MIN_LOG_HZ - 0.0) / SLANEY_F_SP;
const SLANEY_LOGSTEP = Math.log(6.4) / 27.0;

function hzToMel(f: number, htk: boolean): number {
  if (htk) return 2595.0 * Math.log10(1.0 + f / 700.0);
  const mels = f / SLANEY_F_SP;
  return f >= SLANEY_MIN_LOG_HZ
    ? SLANEY_MIN_LOG_MEL + Math.log(f / SLANEY_MIN_LOG_HZ) / SLANEY_LOGSTEP
    : mels;
}

function melToHz(mels: number, htk: boolean): number {
  if (htk) return 700.0 * (10 ** (mels / 2595.0) - 1.0);
  return mels >= SLANEY_MIN_LOG_MEL
    ? SLANEY_MIN_LOG_HZ * Math.exp(SLANEY_LOGSTEP * (mels - SLANEY_MIN_LOG_MEL))
    : SLANEY_F_SP * mels;
}

/** librosa.filters.mel with norm='slaney' — triangular filters, `htk=false` mapping. */
function melFilterbank(nMels: number, nFft: number, sr: number, fmin: number, fmax: number, htk: boolean): Float32Array[] {
  const nBins = 1 + nFft / 2;
  const minMel = hzToMel(fmin, htk);
  const maxMel = hzToMel(fmax, htk);
  const melF = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    melF[i] = melToHz(minMel + ((maxMel - minMel) * i) / (nMels + 1), htk);
  }
  const fdiff = new Float64Array(nMels + 1);
  for (let i = 0; i < nMels + 1; i++) fdiff[i] = melF[i + 1]! - melF[i]!;

  const bank: Float32Array[] = [];
  for (let m = 0; m < nMels; m++) {
    const row = new Float32Array(nBins);
    // Slaney area normalization: 2 / (melF[m+2] - melF[m])
    const enorm = 2.0 / (melF[m + 2]! - melF[m]!);
    for (let k = 0; k < nBins; k++) {
      const freq = (sr / 2) * (k / (nBins - 1));
      const lower = (freq - melF[m]!) / fdiff[m]!;
      const upper = (melF[m + 2]! - freq) / fdiff[m + 1]!;
      row[k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
    bank.push(row);
  }
  return bank;
}

// ------------------------------------------------------------------------- FFT
/** Radix-2 in-place iterative FFT (n_fft = 2048 here) — no dependency added. */
// D30 (T24): exported so the spectral-flux path shares the mel FFT verbatim (behavior unchanged).
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!;
      re[i] = re[j]!;
      re[j] = t;
      t = im[i]!;
      im[i] = im[j]!;
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]!;
        const aIm = im[i + k]!;
        const bRe = re[i + k + len / 2]! * curRe - im[i + k + len / 2]! * curIm;
        const bIm = re[i + k + len / 2]! * curIm + im[i + k + len / 2]! * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Frames: center-padded (pad_mode=constant), `1 + floor(n/hop)` windows (§13.1 — never assume 10 ms). */
export function frameCount(samples: number, hop: number): number {
  return 1 + Math.floor(samples / hop);
}

/**
 * Compute the log-mel spectrogram.
 *
 * Returns a SINGLE flat `Float32Array` of length `frames × n_mels`, **frame-major**
 * (`flat[f * n_mels + m]`) — the one declared layout (review P0). `expected_mel.json`
 * stores the same shape row-by-row (`[frames][n_mels]`).
 *
 * The sample rate MUST equal `preproc.sr` (round 3 P1-1): `decodeAudioData` resamples
 * to the AudioContext's rate, so a caller that skips the 22050 decode (or `toAnalysisPcm`)
 * would silently drift in frame count and mel values.
 */
export function computeLogMel(samples: Float32Array, sampleRate: number, preproc: PreprocParams): Float32Array {
  if (sampleRate !== preproc.sr) {
    throw new Error(`computeLogMel: sampleRate ${sampleRate} !== preproc.sr ${preproc.sr}`);
  }
  const { n_fft: nFft, hop, n_mels: nMels } = preproc;
  if (preproc.window !== "hann" || !preproc.center || preproc.power !== 1.0) {
    throw new Error("computeLogMel: only the pinned preproc (hann / center=true / power=1.0) is implemented");
  }
  let log2 = 0;
  for (let v = nFft; v > 1; v >>= 1) log2++;
  if (1 << log2 !== nFft) throw new Error(`computeLogMel: n_fft ${nFft} is not a power of two`);

  const nBins = 1 + nFft / 2;
  const pad = nFft / 2;
  const padded = new Float32Array(samples.length + 2 * pad);
  padded.set(samples, pad);

  const window = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);

  const bank = melFilterbank(nMels, nFft, preproc.sr, preproc.fmin, preproc.fmax, preproc.htk);
  const frames = frameCount(samples.length, hop);
  const mag = new Float64Array(nBins);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  // mel energies (linear) — log scaling is applied after the global max is known (ref=max)
  const mel = new Float64Array(frames * nMels);

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < nFft; i++) {
      re[i] = padded[start + i]! * window[i]!;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < nBins; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    for (let m = 0; m < nMels; m++) {
      const row = bank[m]!;
      let acc = 0;
      for (let k = 0; k < nBins; k++) acc += row[k]! * mag[k]!;
      mel[f * nMels + m] = acc;
    }
  }

  // librosa.power_to_db(ref=max): 10*log10(max(amin, S)) - 10*log10(max(amin, S.max())),
  // then the top_db floor relative to that same max.
  const { amin, top_db } = preproc;
  let ref = 0;
  for (let i = 0; i < mel.length; i++) if (mel[i]! > ref) ref = mel[i]!;
  const refDb = 10 * Math.log10(Math.max(amin, ref));
  const out = new Float32Array(mel.length);
  let maxOut = -Infinity;
  for (let i = 0; i < mel.length; i++) {
    const db = 10 * Math.log10(Math.max(amin, mel[i]!)) - refDb;
    out[i] = db;
    if (db > maxOut) maxOut = db;
  }
  const floor = maxOut - top_db;
  for (let i = 0; i < out.length; i++) if (out[i]! < floor) out[i] = floor;
  return out;
}

/** Frame count of a flat frame-major mel array. */
export function melFrameCount(flat: Float32Array, nMels: number): number {
  if (flat.length % nMels !== 0) {
    throw new Error(`melFrameCount: length ${flat.length} not divisible by n_mels ${nMels}`);
  }
  return flat.length / nMels;
}

/**
 * Transpose the frame-major flat mel into the model's NCHW input `(1, 1, n_mels, frames)`.
 *
 * The model consumes mel-frequency-major data (`[c][m][f]`) while the analysis layer
 * produces frame-major — this is the single conversion point between the two orderings.
 */
export function toMelTensor(flat: Float32Array, frames: number, nMels: number): Float32Array {
  const out = new Float32Array(frames * nMels);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < nMels; m++) out[m * frames + f] = flat[f * nMels + m]!;
  }
  return out;
}

// --------------------------------------------------------- shared analysis boundary
/**
 * Collapse channels to the ONE channel the mel/flux pipelines consume (round 4 P1-6).
 *
 * length 1 → returned as-is; length 2 → equal-weight average `(L[i] + R[i]) / 2`
 * (no volume weighting, no per-channel paths); more than 2 → throw (import caps at 2).
 *
 * KNOWN LIMITATION (round 5 P2): phase-inverted stereo cancels to ~0. That is accepted —
 * B7 and B8 `flux-v1` both call this identical rule, so the cancellation is at least
 * deterministic and consistent between generators.
 */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) throw new Error("toMono: no channels");
  if (channels.length > 2) throw new Error(`toMono: ${channels.length} channels (import caps at 2)`);
  const first = channels[0]!;
  if (channels.length === 1) return first;
  const right = channels[1]!;
  const out = new Float32Array(first.length);
  for (let i = 0; i < out.length; i++) out[i] = (first[i]! + right[i]!) / 2;
  return out;
}

/**
 * Decode-time analysis PCM (round 3 P1-1). At `targetRate`: copy via `copyFromChannel`
 * into owned arrays (the playback buffer is left untouched). Otherwise render through an
 * `OfflineAudioContext` at `targetRate` and copy the resampled output.
 */
export async function toAnalysisPcm(
  decoded: AudioBuffer,
  targetRate = 22050,
): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const copy = (buf: AudioBuffer, ch: number, length: number): Float32Array => {
    const out = new Float32Array(length);
    buf.copyFromChannel(out, ch);
    return out;
  };
  if (decoded.sampleRate === targetRate) {
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) channels.push(copy(decoded, ch, decoded.length));
    return { channels, sampleRate: targetRate };
  }
  const targetLength = Math.ceil((decoded.length * targetRate) / decoded.sampleRate);
  const offline = new OfflineAudioContext(decoded.numberOfChannels, targetLength, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) channels.push(copy(rendered, ch, rendered.length));
  return { channels, sampleRate: rendered.sampleRate };
}
