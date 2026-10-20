"""Baseline flux-v1 onset reference (W3 T25 / B8b) — the Python mirror of the TS onset core.

This script is the REFERENCE side of the cross-implementation PARITY row in
``packages/chartgen/src/flux-v1.test.ts`` ("onset sanity — cross-implementation
PARITY (NOT accuracy)"). It re-implements the TS onset pipeline in a second
language so that a drift in either implementation shows up as a failing row.

HARD OUTPUT CONTRACT (set by T25a fix r1, binding on this script):
the parity row reads ``models/spike/testvectors/baseline_onsets.json`` as a JSON
array of ``{tMs, confidence}`` and scores the TS ``detectOnsets`` over
``models/spike/testvectors/input.wav``. THIS SCRIPT MUST EMIT EXACTLY THAT SHAPE
FROM EXACTLY THAT INPUT:

    python models/spike/baseline_flux.py \\
        --input models/spike/testvectors/input.wav \\
        --out   models/spike/testvectors/baseline_onsets.json

The emitted file is a JSON array of objects ``{"tMs": <int>, "confidence": <float>}``,
one per detected onset, in ascending ``tMs`` order. ``tMs`` is
``round(frame * hop * 1000 / sr)``; ``confidence`` is the normalized-envelope
value at the picked frame.

WHAT IS MIRRORED (function by function, from ``packages/chartgen/src/flux-v1.ts``):

* ``computeFlux`` (``flux.ts``) — the magnitude spectral flux: the shared
  ``n_fft``/``hop``/Hann/center-padded framing, the shared radix-2 FFT, and the
  half-wave-rectified first difference of the magnitude spectra. The TS flux path
  is magnitude-based (there is NO mel filterbank and NO log stage in it); the
  "log-mel" wording in the task brief refers to the shared framing contract, not
  to a mel filterbank — mirroring ``computeFlux`` verbatim is the contract.
* ``normalizeEnvelope`` (``flux-v1.ts``) — ``out[i] = (x[i] - min) / (range * (1 + eps))``.
  NOTE: this is the post-R20 form, which the TS side pins: the minimum maps to
  exactly 0 and the maximum to just under 1. The older "``x / (max + tiny)``"
  snippet drops the min subtraction and lands the peak on exactly 1.0; it is NOT
  what the TS side does and would make the parity row compare two different
  normalizations.
* ``peakPick`` (``flux-v1.ts``) — ``librosa.util.peak_pick`` semantics: the delta
  floor, the local-maximum test, the mean-over-window test, and the wait.
* ``frameToMs`` (``flux-v1.ts``).

``numpy`` is used when it is importable (it only accelerates the FFT); the
script NEVER requires ``librosa`` (nor any other third-party package) to be
readable or runnable. The standard library alone is enough.

R13 (controller ruling, carried here verbatim): on the machine this task was
authored on, NO usable pinned Python environment exists (bare ``python`` is the
WindowsApps stub; ``E:/Code/Python/python.exe`` is 3.12 with numpy but no
librosa; the D17-pinned env is not installed). The generation of
``models/spike/testvectors/baseline_onsets.json`` is therefore reported
**NOT RUN — operator-gated**, exactly like T1's Python gate. The parity row stays
a NOT-A-PASS skip with a printed banner until the operator runs this script on
the pinned env.

Usage:
    python models/spike/baseline_flux.py --input <path.wav> [--out <path.json>]

A missing/unreadable input is a hard failure: this script never emits a silent
empty reference.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path
from typing import List, Sequence, Tuple

try:  # optional accelerator only — the script is fully stdlib-capable
    import numpy as _np
except ImportError:  # pragma: no cover - exercised only on numpy-less interpreters
    _np = None  # type: ignore[assignment]

# --------------------------------------------------------------------- constants
# These MUST equal the values pinned in ``packages/chartgen/src/flux-v1.ts``
# (``PINNED_PREPROC`` + the ``ONSET_*`` peak-pick constants). They are printed
# on every run so that a drift in either file is visible in the operator log.
SR = 22050
HOP = 220
N_FFT = 2048
N_BINS = 1 + N_FFT // 2
ONSET_PRE_MAX = 3
ONSET_POST_MAX = 1
ONSET_PRE_AVG = 15
ONSET_POST_AVG = 15
ONSET_DELTA = 0.02
ONSET_WAIT = 3

# ``librosa.util.tiny`` — np.finfo(np.float32).tiny (2 ** -126).
ENVELOPE_TINY = 2.0**-126
# ``Number.EPSILON`` in JS == ``sys.float_info.epsilon`` in Python (IEEE-754
# binary64). The TS normalizer scales the range by ``1 + EPSILON`` (a RELATIVE
# guard) so the peak stays strictly below 1.
FLOAT_EPS = 2.220446049250313e-16


# ------------------------------------------------------------------ wav reading
def _f32(values: Sequence[float]) -> List[float]:
    """Round a list of doubles to float32 precision (what a Float32Array holds).

    The TS side decodes the spike vector into a ``Float32Array``; the flux math
    then reads those float32 values widened back to double. Mirroring the
    rounding keeps both sides on identical samples.
    """
    if _np is not None:
        return _np.asarray(values, dtype=_np.float32).astype(_np.float64).tolist()
    packed = struct.pack("<%df" % len(values), *values)
    return list(struct.unpack("<%df" % len(values), packed))


def read_wav_mono_f32(path: Path) -> List[float]:
    """Read a RIFF/WAVE PCM file as mono float32 samples in [-1, 1).

    Minimal RIFF walker (the ``fmt `` / ``data`` chunks are found by id, never
    assumed to sit at fixed offsets) — the same shape as the TS helper
    ``decodeWavMono`` in ``flux-v1.test.ts``. Only 16-bit PCM is accepted: that
    is the format of the committed spike vector, and a different encoding would
    silently change the reference.
    """
    raw = path.read_bytes()
    if len(raw) < 12 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError(f"{path}: not a RIFF/WAVE file")
    fmt: Tuple[int, int, int] | None = None
    data: bytes | None = None
    pos = 12
    while pos + 8 <= len(raw):
        chunk_id = raw[pos : pos + 4]
        size = struct.unpack_from("<I", raw, pos + 4)[0]
        body = raw[pos + 8 : pos + 8 + size]
        if chunk_id == b"fmt ":
            audio_format, channels, sample_rate, _byte_rate, _align, bits = struct.unpack_from(
                "<HHIIHH", body, 0
            )
            fmt = (channels, sample_rate, bits)
            if audio_format != 1:
                raise ValueError(f"{path}: not PCM (audioFormat {audio_format})")
        elif chunk_id == b"data":
            data = body
        pos += 8 + size + (size % 2)  # RIFF chunks are word-aligned
    if fmt is None or data is None:
        raise ValueError(f"{path}: missing fmt/data chunk")
    channels, sample_rate, bits = fmt
    if channels != 1:
        raise ValueError(f"{path}: expected mono, got {channels} channels")
    if sample_rate != SR:
        raise ValueError(f"{path}: sample rate {sample_rate} != pinned {SR}")
    if bits != 16:
        raise ValueError(f"{path}: expected 16-bit PCM, got {bits}-bit")
    count = len(data) // 2
    ints = struct.unpack("<%dh" % count, data[: count * 2])
    return _f32([value / 32768.0 for value in ints])


# ------------------------------------------------------------------------- fft
def _fft_in_place(re: List[float], im: List[float]) -> None:
    """Radix-2 in-place iterative FFT — the verbatim port of ``mel.ts:fftInPlace``.

    Same bit-reversal permutation, same per-length twiddle factor, same
    multiply order, so the float64 arithmetic matches the TS side step for step.
    """
    n = len(re)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    length = 2
    while length <= n:
        angle = (-2.0 * math.pi) / length
        w_re = math.cos(angle)
        w_im = math.sin(angle)
        half = length // 2
        for base in range(0, n, length):
            cur_re = 1.0
            cur_im = 0.0
            for k in range(half):
                a_re = re[base + k]
                a_im = im[base + k]
                b_re = re[base + k + half] * cur_re - im[base + k + half] * cur_im
                b_im = re[base + k + half] * cur_im + im[base + k + half] * cur_re
                re[base + k] = a_re + b_re
                im[base + k] = a_im + b_im
                re[base + k + half] = a_re - b_re
                im[base + k + half] = a_im - b_im
                next_re = cur_re * w_re - cur_im * w_im
                next_im = cur_re * w_im + cur_im * w_re
                cur_re = next_re
                cur_im = next_im
        length <<= 1


def _magnitudes(frame: Sequence[float]) -> List[float]:
    """Magnitude spectrum of one windowed frame (n_bins = 1 + n_fft/2).

    ``numpy`` (when present) only replaces the FFT itself; the magnitude formula
    (``hypot(re, im)``) and everything downstream are identical either way.
    """
    if _np is not None:
        spectrum = _np.fft.rfft(_np.asarray(frame, dtype=_np.float64))
        return [math.hypot(float(re), float(im)) for re, im in zip(spectrum.real, spectrum.imag)]
    re = list(frame)
    im = [0.0] * len(re)
    _fft_in_place(re, im)
    return [math.hypot(re[k], im[k]) for k in range(N_BINS)]


# ------------------------------------------------------------------ flux core
def hann_window(n: int) -> List[float]:
    """The Hann window at ``n`` — ``0.5 - 0.5 * cos(2*pi*i/n)`` (TS verbatim)."""
    return [0.5 - 0.5 * math.cos((2.0 * math.pi * i) / n) for i in range(n)]


def frame_count(n_samples: int, hop: int) -> int:
    """Center-padded frame count: ``1 + floor(n/hop)`` (TS ``mel.ts:frameCount``)."""
    return 1 + n_samples // hop


def compute_flux(samples: Sequence[float]) -> List[float]:
    """The flux curve — the verbatim port of ``flux.ts:computeFlux``.

    Frame ``f`` reads the absolute window ``[f*hop - n_fft/2, f*hop + n_fft/2)``
    (zero-padded at both edges), multiplies it by the Hann window, FFTs it, and
    accumulates the half-wave-rectified difference against the previous frame's
    magnitudes. The first frame differences against zero magnitude.

    The per-frame values are stored as float32 (the TS ``Float32Array``), which
    the normalizer then widens back to double.
    """
    window = hann_window(N_FFT)
    pad = N_FFT // 2
    frames = frame_count(len(samples), HOP)
    prev_mag = [0.0] * N_BINS
    out: List[float] = []
    for f in range(frames):
        start = f * HOP - pad
        frame = [
            (samples[start + i] if 0 <= start + i < len(samples) else 0.0) * window[i]
            for i in range(N_FFT)
        ]
        cur_mag = _magnitudes(frame)
        acc = 0.0
        for k in range(N_BINS):
            diff = cur_mag[k] - prev_mag[k]
            if diff > 0.0:
                acc += diff
        out.append(acc)
        prev_mag = cur_mag
    return _f32(out)


def normalize_envelope(x: Sequence[float]) -> List[float]:
    """``out[i] = (x[i] - min) / (range * (1 + eps))`` — the TS ``normalizeEnvelope``.

    The minimum maps to exactly 0 and the maximum to just under 1 (the relative
    epsilon keeps it off the float64 boundary). A degenerate all-equal envelope
    divides by ``ENVELOPE_TINY`` so the result is 0 rather than NaN.
    """
    if not x:
        return []
    lo = min(x)
    hi = max(x)
    span = hi - lo
    scale = ENVELOPE_TINY if span == 0.0 else span * (1.0 + FLOAT_EPS)
    return [(value - lo) / scale for value in x]


def peak_pick(x: Sequence[float]) -> List[int]:
    """``librosa.util.peak_pick`` semantics — the TS ``peakPick`` port.

    A frame is picked when it is at or above the delta floor, is the local
    maximum of its ``pre_max``/``post_max`` neighbourhood, is at or above the
    mean of its ``pre_avg``/``post_avg`` neighbourhood plus the delta, and is at
    least ``wait`` frames past the previous pick.
    """
    n = len(x)
    picked: List[int] = []
    last = -math.inf
    for i in range(n):
        value = x[i]
        if value < ONSET_DELTA:
            continue
        local_max = -math.inf
        for j in range(max(0, i - ONSET_PRE_MAX), min(n - 1, i + ONSET_POST_MAX) + 1):
            if x[j] > local_max:
                local_max = x[j]
        if value != local_max:
            continue
        total = 0.0
        count = 0
        for j in range(max(0, i - ONSET_PRE_AVG), min(n - 1, i + ONSET_POST_AVG) + 1):
            total += x[j]
            count += 1
        if value < total / count + ONSET_DELTA:
            continue
        if i - last < ONSET_WAIT:
            continue
        picked.append(i)
        last = i
    return picked


def frame_to_ms(frame: int, sample_rate: int = SR, hop: int = HOP) -> int:
    """``round(frame * hop * 1000 / sr)`` — JS ``Math.round`` semantics."""
    return math.floor((frame * hop * 1000) / sample_rate + 0.5)


def detect_onsets(samples: Sequence[float]) -> List[dict]:
    """Mono samples → the onset list (``tMs`` + normalized ``confidence``)."""
    envelope = normalize_envelope(compute_flux(samples))
    return [
        {"tMs": frame_to_ms(frame), "confidence": envelope[frame]}
        for frame in peak_pick(envelope)
    ]


# ------------------------------------------------------------------------ cli
def _print_constants() -> None:
    print(f"[baseline_flux] sr={SR} hop={HOP} n_fft={N_FFT} n_bins={N_BINS}")
    print(
        f"[baseline_flux] ONSET_PRE_MAX={ONSET_PRE_MAX} ONSET_POST_MAX={ONSET_POST_MAX} "
        f"ONSET_PRE_AVG={ONSET_PRE_AVG} ONSET_POST_AVG={ONSET_POST_AVG} "
        f"ONSET_DELTA={ONSET_DELTA} ONSET_WAIT={ONSET_WAIT}"
    )
    print(f"[baseline_flux] numpy={'yes' if _np is not None else 'no (stdlib path)'}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Emit the flux-v1 onset reference ([{tMs, confidence}, ...]) for a WAV file."
    )
    parser.add_argument("--input", required=True, help="input .wav (16-bit PCM mono @ 22050 Hz)")
    parser.add_argument("--out", help="output .json (default: stdout)")
    args = parser.parse_args(argv)

    _print_constants()

    input_path = Path(args.input)
    if not input_path.is_file():
        print(f"[baseline_flux] ERROR: input not found: {input_path}", file=sys.stderr)
        return 2
    try:
        samples = read_wav_mono_f32(input_path)
    except (OSError, ValueError) as err:
        print(f"[baseline_flux] ERROR: cannot read {input_path}: {err}", file=sys.stderr)
        return 2
    if not samples:
        print(f"[baseline_flux] ERROR: {input_path} contains no samples", file=sys.stderr)
        return 2

    onsets = detect_onsets(samples)
    payload = json.dumps(onsets, indent=2) + "\n"
    if args.out:
        out_path = Path(args.out)
        out_path.write_text(payload, encoding="utf8")
        print(f"[baseline_flux] wrote {len(onsets)} onsets -> {out_path}")
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
