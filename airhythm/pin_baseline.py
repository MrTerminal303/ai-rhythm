"""Pin the baseline important/filler-bucket F on the fixed eval-set songs.

CLI: python airhythm/pin_baseline.py --songs data/minimal_dataset \
       --eval-ids metadata/eval_song_ids.json --out data/eval_pins.json

Reconstructs refs from stitched labels, computes onset_strength, routes
through shared peak_pick_frames(normalize_envelope(...)), buckets refs by
top-30% oenv-at-frame salience (filter-refs-keep-ALL-ests), then mir_eval.

Option-b params as amended in STATE D-10 (2026-10-02): 0.02/15/15 are used for the pin AND written to
config.py afterward — the pin must not read config.PEAK_PICK_PARAMS (which
still holds pre-derivation delta=0.3 at pin time).
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import librosa
import mir_eval
import mir_eval.onset  # needed for mir_eval.onset.util.match_events
import numpy as np
from airhythm import config
from airhythm.baseline import normalize_envelope, peak_pick_frames

logger = logging.getLogger(__name__)

# Option b as amended in STATE D-10 (2026-10-02) — 0.02/15/15
OPTION_B_PARAMS = {
    "pre_max": 3,
    "post_max": 1,
    "pre_avg": 15,
    "post_avg": 15,
    "delta": 0.02,
    "wait": 3,
}

N_EST_BAND = (100, 4000)  # option-b empirical band per RESEARCH.md


def load_song_audio_sr(song_dir: Path) -> Tuple[np.ndarray, int]:
    audio, sr = librosa.load(str(song_dir / "original.audio"), sr=config.SAMPLE_RATE, mono=True)
    return audio, sr


def reconstruct_ref_times(song_dir: Path) -> np.ndarray:
    labels = np.concatenate(
        [np.load(p) for p in sorted(song_dir.glob("*_labels.npy"))], axis=1
    )  # (3, T)
    return np.where(labels[1] == 1)[0] * (config.HOP_LENGTH / config.SAMPLE_RATE)


def bucket_refs_by_salience(
    ref_times: np.ndarray, oenv: np.ndarray, window_frames: int = 5, cut_frac: float = 0.3
) -> Tuple[np.ndarray, np.ndarray, float]:
    """Rank-based top-cut_frac salience split (SBOEP v1; default 0.3 gates, D-01).

    Uses rank-based selection (exactly ceil(cut_frac*n) events) instead of
    percentile threshold to avoid ties inflating the important bucket.
    Perplexity review found percentile ties as a protocol bug.
    """
    if len(ref_times) == 0:
        return np.array([]), np.array([]), 0.0
    frames = np.clip(
        np.round(ref_times * config.SAMPLE_RATE / config.HOP_LENGTH).astype(int),
        0,
        len(oenv) - 1,
    )
    # Local contrast salience: max in +/- 50ms window minus local neighborhood average.
    win_size = 200  # ~2 seconds
    pad = win_size // 2
    padded_oenv = np.pad(oenv, (pad, pad), mode="edge")
    local_avg = np.convolve(padded_oenv, np.ones(win_size) / win_size, mode="valid")

    sal = np.array([
        np.max(oenv[max(0, f - window_frames) : min(len(oenv), f + window_frames + 1)]) - local_avg[f]
        for f in frames
    ])
    # Rank-based: exactly ceil(cut_frac*n) events, no ties inflation
    n_important = int(np.ceil(cut_frac * len(sal)))
    top_indices = np.argsort(sal)[-n_important:]
    mask = np.zeros(len(sal), dtype=bool)
    mask[top_indices] = True
    cut = float(sal[top_indices].min())
    return mask, ~mask, cut


def safe_f_measure(ref: np.ndarray, est: np.ndarray, window: float = 0.05) -> Dict[str, float]:
    if len(ref) == 0 or len(est) == 0:
        F = P = R = 0.0
    else:
        F, P, R = mir_eval.onset.f_measure(ref, est, window=window)
    return {"f_measure": F, "precision": P, "recall": R}


def pin_one_song(song_dir: Path, params: dict) -> dict:
    audio, sr = load_song_audio_sr(song_dir)
    ref_times = reconstruct_ref_times(song_dir)
    oenv = librosa.onset.onset_strength(
        y=audio, sr=sr, hop_length=config.HOP_LENGTH, fmax=config.FMAX
    )
    est_frames = peak_pick_frames(normalize_envelope(oenv), **params)
    est_times = librosa.frames_to_time(est_frames, sr=sr, hop_length=config.HOP_LENGTH)

    important_mask, filler_mask, cut = bucket_refs_by_salience(ref_times, oenv)
    imp_idx = set(np.where(important_mask)[0])
    fill_idx = set(np.where(filler_mask)[0])

    # Global one-to-one matching (SBOEP v1, Perplexity-reviewed Bug 1+3)
    # One match, then partition by reference bucket — eliminates
    # FP cross-contamination and double-counting from separate matching.
    matched = mir_eval.onset.util.match_events(ref_times, est_times, window=0.05)
    matched_est_indices = {e for _r, e in matched}

    TP_imp = sum(1 for r, _e in matched if r in imp_idx)
    TP_fill = sum(1 for r, _e in matched if r in fill_idx)
    FN_imp = len(imp_idx) - TP_imp
    FN_fill = len(fill_idx) - TP_fill
    FP = len(est_times) - len(matched_est_indices)

    # Per-bucket recall (primary reference-conditioned metric)
    R_imp = TP_imp / (TP_imp + FN_imp) if (TP_imp + FN_imp) > 0 else 0.0
    R_fill = TP_fill / (TP_fill + FN_fill) if (TP_fill + FN_fill) > 0 else 0.0

    # Global precision (estimate-conditioned, shared across buckets)
    TP_total = TP_imp + TP_fill
    P_global = TP_total / (TP_total + FP) if (TP_total + FP) > 0 else 0.0

    F_imp = 2 * P_global * R_imp / (P_global + R_imp) if (P_global + R_imp) > 0 else 0.0
    F_fill = 2 * P_global * R_fill / (P_global + R_fill) if (P_global + R_fill) > 0 else 0.0

    return {
        "n_ref": int(len(ref_times)),
        "n_est": int(len(est_times)),
        "n_important": len(imp_idx),
        "n_filler": len(fill_idx),
        "F_important": F_imp,
        "P_important": P_global,
        "R_important": R_imp,
        "F_filler": F_fill,
        "P_filler": P_global,
        "R_filler": R_fill,
        "cut_percentile": cut,
    }


def decide_derivation_option(search_id: str, search_dir: Path) -> Tuple[str, dict]:
    """Deterministic option-b per STATE D-10. Logs option-b F for the record."""
    res_b = pin_one_song(search_dir, OPTION_B_PARAMS)
    logger.info(
        "search song %s option-b F_important=%.4f (n_est=%d)",
        search_id, res_b["F_important"], res_b["n_est"],
    )
    return "b", OPTION_B_PARAMS


def capture_golden_fixtures(song_dirs: List[Path], fixtures_dir: Path, params: dict) -> None:
    for song_dir in song_dirs:
        song_id = song_dir.name
        audio, sr = load_song_audio_sr(song_dir)
        oenv = librosa.onset.onset_strength(
            y=audio, sr=sr, hop_length=config.HOP_LENGTH, fmax=config.FMAX
        )
        est_frames = peak_pick_frames(normalize_envelope(oenv), **params)
        est_times = librosa.frames_to_time(est_frames, sr=sr, hop_length=config.HOP_LENGTH)
        n_est = len(est_times)
        assert N_EST_BAND[0] <= n_est <= N_EST_BAND[1], (
            f"song {song_id}: n_est={n_est} outside option-b band {N_EST_BAND}"
        )
        np.savez(fixtures_dir / f"golden_post_{song_id}.npz", onset_times=est_times)


def pin_baseline(args) -> dict:
    eval_ids_path = Path(args.eval_ids)
    ids = json.loads(eval_ids_path.read_text())
    eval_ids = ids["song_ids"]
    search_ids = ids["search_set_ids"]

    songs_root = Path(args.songs)
    search_id = search_ids[0] if search_ids else None
    derivation_option = "b"
    if search_id is not None:
        derivation_option, params = decide_derivation_option(search_id, songs_root / search_id)
    else:
        params = OPTION_B_PARAMS

    per_song: Dict[str, dict] = {}
    for sid in eval_ids:
        per_song[sid] = pin_one_song(songs_root / sid, params)

    mean = lambda key: float(np.mean([per_song[s][key] for s in eval_ids]))
    aggregate = {
        "mean_F_important": mean("F_important"),
        "mean_F_filler": mean("F_filler"),
        "mean_P_important": mean("P_important"),
        "mean_R_important": mean("R_important"),
        "mean_P_filler": mean("P_filler"),
        "mean_R_filler": mean("R_filler"),
    }

    pin = {
        "derivation_option": derivation_option,
        "params": params,
        "eval_song_ids": eval_ids,
        "search_set_ids": search_ids,
        "normalize": "librosa x-min; /(max+tiny)",
        "fp_protocol": "global-one-to-one-match (SBOEP v1, Perplexity-reviewed)",
        "bucket_definition": "top-30% refs by oenv-at-frame, rank-based (ceil(0.3*n))",
        "pinned_at": datetime.now(timezone.utc).isoformat(),
        "decision_ref": "D-10 (amended 2026-10-02), D-16, RESEARCH.md Section 3.1 option b",
        "per_song": per_song,
        "aggregate": aggregate,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(pin, indent=2, sort_keys=True))

    print(
        f"pin_baseline: option={derivation_option} "
        f"mean_F_important={aggregate['mean_F_important']:.4f} "
        f"mean_F_filler={aggregate['mean_F_filler']:.4f}"
    )
    return pin


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--songs", default="data/minimal_dataset")
    parser.add_argument("--eval-ids", default="metadata/eval_song_ids.json")
    parser.add_argument("--out", default="data/eval_pins.json")
    parser.add_argument("--no-re-capture-goldens", dest="re_capture_goldens", action="store_false")
    args = parser.parse_args()

    pin = pin_baseline(args)

    if args.re_capture_goldens:
        songs_root = Path(args.songs)
        fixtures_dir = Path(__file__).parent / "tests" / "fixtures"
        fixtures_dir.mkdir(exist_ok=True)
        capture_golden_fixtures(
            [songs_root / sid for sid in pin["eval_song_ids"] + pin["search_set_ids"]],
            fixtures_dir,
            pin["params"],
        )
        print("golden_post fixtures re-captured under option-b params")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    main()