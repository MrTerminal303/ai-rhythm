"""Librosa onset detection baseline for AIRhythm model evaluation.

This module is the permanent yardstick for all onset detection model stages.
Every model output must be compared against this baseline using identical
eval code. Phase 1+ imports ``evaluate_onset_fscore`` — never reimplemented.

Per RESEARCH.md Section 4:
    - oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=220, fmax=11025)
    - onset_frames = librosa.onset.onset_detect(onset_envelope=oenv, sr=sr, hop_length=220)
    - mir_eval.onset.f_measure(ref_times, est_times, window=0.05)
"""

from __future__ import annotations

import csv
import logging
from typing import Any, Dict, List, Optional

import librosa
import mir_eval
import numpy as np
from airhythm import config
from airhythm.toygen import ToySample

__all__ = [
    "run_librosa_onset_detection",
    "evaluate_onset_fscore",
    "evaluate_on_song",
    "evaluate_on_toy",
    "run_baseline",
    "BASELINE_EVAL_CSV_HEADER",
    "normalize_envelope",
    "peak_pick_frames",
]

logger = logging.getLogger(__name__)

BASELINE_EVAL_CSV_HEADER = "song_id,f_measure,precision,recall,n_ref,n_est,is_toy"


def normalize_envelope(x: np.ndarray) -> np.ndarray:
    """Exact librosa onset_detect normalize (VERIFIED equals librosa formula).

    Formula: x = x - min(x); x = x / (max(x) + librosa.util.tiny(x))
    Result: min=0.0, max strictly < 1.0 (by tiny/scale)

    Args:
        x: Input envelope array.

    Returns:
        Normalized envelope in [0, 1) range.
    """
    x = x - np.min(x, keepdims=True)
    x = x / (np.max(x, keepdims=True) + librosa.util.tiny(x))
    return x


def peak_pick_frames(envelope: np.ndarray, **params) -> np.ndarray:
    """Peak-pick a min-max normalized envelope -> frame indices.

    Contract: envelope must already be in [0,1] (caller runs normalize_envelope,
    or feeds sigmoid-based [0,1] activation). Raises ValueError otherwise.

    Args:
        envelope: Normalized onset envelope in [0,1].
        **params: Peak-pick parameters (pre_max, post_max, pre_avg, post_avg, delta, wait).

    Returns:
        Array of onset frame indices.
    """
    if envelope.size == 0:
        raise ValueError("empty envelope")
    if envelope.min() < -1e-6 or envelope.max() > 1.0 + 1e-6:
        raise ValueError(f"envelope outside [0,1]: [{envelope.min():.4f}, {envelope.max():.4f}]")
    assert np.all(np.isfinite(envelope))
    # scalar-statistic self-check
    stat = float(np.mean(envelope > params.get("delta", 0.3)))
    logger.debug("peak_pick envelope stat (frac>delta): %.4f", stat)
    return librosa.util.peak_pick(envelope, **params)


def run_librosa_onset_detection(audio: np.ndarray, sr: int) -> np.ndarray:
    """Run librosa onset detection on an audio waveform.

    Computes onset strength envelope, detects onset frames via shared
    peak_pick_frames(normalize_envelope(...)), and converts to onset times.

    Args:
        audio: Audio waveform as float32 np.ndarray shape (N,).
        sr: Sample rate in Hz.

    Returns:
        np.ndarray of onset times in seconds, shape (M,).
    """
    onset_strength = librosa.onset.onset_strength(
        y=audio,
        sr=sr,
        hop_length=config.HOP_LENGTH,
        fmax=config.FMAX,
    )
    onset_frames = peak_pick_frames(
        normalize_envelope(onset_strength),
        **config.PEAK_PICK_PARAMS,
    )
    onset_times = librosa.frames_to_time(
        onset_frames,
        sr=sr,
        hop_length=config.HOP_LENGTH,
    )
    return onset_times


def evaluate_onset_fscore(
    ref_times: np.ndarray, est_times: np.ndarray, window: float = 0.05
) -> Dict[str, Any]:
    """Compute F-measure between reference and estimated onset times.

    Uses mir_eval.onset.f_measure with MIREX standard 50ms tolerance.
    Handles empty arrays correctly — mir_eval returns 0.0 for empty ref or est.

    Args:
        ref_times: Reference onset times in seconds.
        est_times: Estimated onset times in seconds.
        window: Tolerance window in seconds (default 0.05).

    Returns:
        Dict with keys: f_measure, precision, recall, n_ref, n_est, window.
    """
    F, P, R = mir_eval.onset.f_measure(ref_times, est_times, window=window)
    return {
        "f_measure": float(F),
        "precision": float(P),
        "recall": float(R),
        "n_ref": int(len(ref_times)),
        "n_est": int(len(est_times)),
        "window": window,
    }


def evaluate_on_song(
    audio: np.ndarray,
    sr: int,
    ref_times: np.ndarray,
    song_id: str,
) -> Dict[str, Any]:
    """Run librosa baseline detection on a single song and compute F-measure.

    Args:
        audio: Audio waveform as float32 np.ndarray shape (N,).
        sr: Sample rate in Hz.
        ref_times: Reference onset times in seconds.
        song_id: Identifier for this song (used in CSV output).

    Returns:
        Dict with keys: song_id, f_measure, precision, recall, n_ref, n_est.
    """
    est_times = run_librosa_onset_detection(audio, sr)
    score = evaluate_onset_fscore(ref_times, est_times)
    score["song_id"] = song_id
    return score


def evaluate_on_toy(
    toy_samples: List[ToySample], sr: int = config.SAMPLE_RATE
) -> Dict[str, Any]:
    """Evaluate baseline onset detection on a list of toy samples.

    For each ToySample, reference onset times are derived from the binary
    onset_labels vector at config.FPS frame rate. Estimated
    onsets come from running librosa onset detection on reconstructed audio
    generated from the sample's noise/metadata parameters.

    Args:
        toy_samples: List of ToySample instances.
        sr: Sample rate in Hz (default 22050).

    Returns:
        Dict with keys: mean_f, mean_p, mean_r, per_sample.
    """
    per_sample: List[Dict[str, Any]] = []

    for idx, sample in enumerate(toy_samples):
        # Reference times from onset_labels: frame indices on the REAL grid
        ref_frames = np.where(sample.onset_labels == 1)[0].astype(np.float64)
        ref_times = ref_frames / config.FPS

        # Reconstruct audio from metadata parameters
        bpm = sample.metadata.get("bpm", 120.0)

        from airhythm.toygen import MetronomeClickGenerator, NoiseConfig

        gen = MetronomeClickGenerator(sample_rate=sr)

        noise_params = sample.metadata.get("noise_params")
        noise = None
        if noise_params:
            noise = NoiseConfig(
                jitter_ms=noise_params.get("jitter_ms", 0.0),
                amplitude_db=noise_params.get("amplitude_db", 0.0),
                hum_db=noise_params.get("hum_db", 0.0),
                extra_noise_floor=noise_params.get("extra_noise_floor", 0.0),
                random_phase=noise_params.get("random_phase", False),
            )

        audio, _ = gen.generate(bpm, noise=noise)

        # Pad or truncate to 4 seconds
        expected_samples = int(sr * 4.0)
        if len(audio) < expected_samples:
            audio = np.pad(audio, (0, expected_samples - len(audio)), mode="constant")
        else:
            audio = audio[:expected_samples]

        est_times = run_librosa_onset_detection(audio, sr)

        score = evaluate_onset_fscore(ref_times, est_times)
        score["song_id"] = f"toy_{idx:04d}"
        score["is_toy"] = True
        per_sample.append(score)

    mean_f = float(np.mean([s["f_measure"] for s in per_sample]))
    mean_p = float(np.mean([s["precision"] for s in per_sample]))
    mean_r = float(np.mean([s["recall"] for s in per_sample]))

    return {
        "mean_f": mean_f,
        "mean_p": mean_p,
        "mean_r": mean_r,
        "per_sample": per_sample,
    }


def run_baseline(
    toy_dataset: List[ToySample],
    real_songs: Optional[List[dict]] = None,
    output_csv: str = "baseline_eval.csv",
) -> Dict[str, Any]:
    """Run full baseline evaluation and write results to CSV.

    Evaluates on the toy set and optionally on real songs. Writes a CSV
    with columns defined by BASELINE_EVAL_CSV_HEADER.

    Args:
        toy_dataset: List of ToySample instances for synthetic evaluation.
        real_songs: Optional list of dicts with keys:
            "audio" (np.ndarray), "sr" (int), "ref_times" (np.ndarray),
            "song_id" (str).
        output_csv: Path for output CSV file.

    Returns:
        Summary dict with keys: toy_metrics, real_metrics (if real_songs
        provided), total_songs, output_csv.
    """
    toy_metrics = evaluate_on_toy(toy_dataset)

    real_metrics_list: List[Dict[str, Any]] = []
    if real_songs:
        for song in real_songs:
            score = evaluate_on_song(
                audio=song["audio"],
                sr=song["sr"],
                ref_times=song["ref_times"],
                song_id=song["song_id"],
            )
            score["is_toy"] = False
            real_metrics_list.append(score)

    with open(output_csv, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(BASELINE_EVAL_CSV_HEADER.split(","))
        for s in toy_metrics["per_sample"]:
            writer.writerow(
                [
                    s["song_id"],
                    s["f_measure"],
                    f'{s["precision"]:.6f}',
                    f'{s["recall"]:.6f}',
                    s["n_ref"],
                    s["n_est"],
                    True,
                ]
            )
        for s in real_metrics_list:
            writer.writerow(
                [
                    s["song_id"],
                    s["f_measure"],
                    f'{s["precision"]:.6f}',
                    f'{s["recall"]:.6f}',
                    s["n_ref"],
                    s["n_est"],
                    False,
                ]
            )

    real_agg: Dict[str, Any] = {}
    if real_metrics_list:
        real_agg = {
            "mean_f": float(np.mean([s["f_measure"] for s in real_metrics_list])),
            "mean_p": float(np.mean([s["precision"] for s in real_metrics_list])),
            "mean_r": float(np.mean([s["recall"] for s in real_metrics_list])),
            "per_song": real_metrics_list,
        }

    return {
        "toy_metrics": toy_metrics,
        "real_metrics": real_agg if real_metrics_list else None,
        "total_samples": len(toy_dataset) + (len(real_metrics_list) if real_metrics_list else 0),
        "output_csv": output_csv,
    }
