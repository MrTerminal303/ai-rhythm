"""Pure logic for the baseline-fit test app. No streamlit import here."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

import librosa
import numpy as np

from airhythm import config
import mir_eval
import mir_eval.onset  # needed for mir_eval.onset.util.match_events
from airhythm.pin_baseline import (
    load_song_audio_sr,
    reconstruct_ref_times,
    bucket_refs_by_salience,
    normalize_envelope,
    peak_pick_frames,
)

DEGENERATE_F = 0.01


def is_degenerate(F_important: float, n_est: int) -> bool:
    """A song is degenerate if the baseline finds nothing or fails F badly."""
    return F_important < DEGENERATE_F or n_est == 0


def load_song_tags(eval_ids_path: str = "metadata/eval_song_ids.json") -> Dict[str, str]:
    """Map song_id -> 'eval' | 'search' from the seeded ids file."""
    data = json.loads(Path(eval_ids_path).read_text())
    tags: Dict[str, str] = {}
    for sid in data.get("song_ids", []):
        tags[str(sid)] = "eval"
    for sid in data.get("search_set_ids", []):
        tags[str(sid)] = "search"
    return tags


def discover_songs(data_dir: str = "data/minimal_dataset") -> List[dict]:
    """Scan song dirs with a decodable original.audio; tag eval/search/other."""
    tags = load_song_tags()
    root = Path(data_dir)
    if not root.is_dir():
        return []
    songs = []
    for song_dir in sorted(root.iterdir()):
        if not song_dir.is_dir() or not (song_dir / "original.audio").exists():
            continue
        sid = song_dir.name
        songs.append({"song_id": sid, "path": song_dir, "tag": tags.get(sid, "other")})
    return songs


def analyze_song(song_dir: Path, params: dict) -> dict:
    """Run detection + bucketed F for one song; return raw arrays for viz.

    Uses global one-to-one matching then partitions by reference bucket
    (SBOEP v1, Perplexity-reviewed). Eliminates FP cross-contamination.
    """
    audio, sr = load_song_audio_sr(song_dir)
    ref_times = reconstruct_ref_times(song_dir)
    oenv = librosa.onset.onset_strength(
        y=audio, sr=sr, hop_length=config.HOP_LENGTH, fmax=config.FMAX
    )
    est_frames = peak_pick_frames(normalize_envelope(oenv), **params)
    est_times = librosa.frames_to_time(est_frames, sr=sr, hop_length=config.HOP_LENGTH)

    important_times, filler_times, cut = bucket_refs_by_salience(ref_times, oenv)
    # Map back to global indices for matching
    imp_set = set(important_times.tolist())
    fill_set = set(filler_times.tolist())
    imp_idx = {i for i, t in enumerate(ref_times) if t in imp_set}
    fill_idx = {i for i, t in enumerate(ref_times) if t in fill_set}

    # Global matching (SBOEP v1 — Bug 1+3 fix)
    matched = mir_eval.onset.util.match_events(ref_times, est_times, window=0.05)
    matched_est_indices = {e for _r, e in matched}

    TP_imp = sum(1 for r, _e in matched if r in imp_idx)
    TP_fill = sum(1 for r, _e in matched if r in fill_idx)
    FN_imp = len(imp_idx) - TP_imp
    FN_fill = len(fill_idx) - TP_fill
    FP = len(est_times) - len(matched_est_indices)

    R_imp = TP_imp / (TP_imp + FN_imp) if (TP_imp + FN_imp) > 0 else 0.0
    R_fill = TP_fill / (TP_fill + FN_fill) if (TP_fill + FN_fill) > 0 else 0.0
    TP_total = TP_imp + TP_fill
    P_global = TP_total / (TP_total + FP) if (TP_total + FP) > 0 else 0.0

    F_important = 2 * P_global * R_imp / (P_global + R_imp) if (P_global + R_imp) > 0 else 0.0
    F_filler = 2 * P_global * R_fill / (P_global + R_fill) if (P_global + R_fill) > 0 else 0.0

    n_est = int(len(est_times))
    return {
        "audio": audio,
        "sr": sr,
        "oenv": oenv,
        "est_times": est_times,
        "ref_times": ref_times,
        "important": important_times,
        "filler": filler_times,
        "cut": cut,
        "F_important": F_important,
        "F_filler": F_filler,
        "n_ref": int(len(ref_times)),
        "n_est": n_est,
        "degenerate": is_degenerate(F_important, n_est),
    }