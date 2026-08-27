"""Pure logic for the baseline-fit test app. No streamlit import here."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

import librosa
import numpy as np

from airhythm import config
from airhythm.pin_baseline import (
    load_song_audio_sr,
    reconstruct_ref_times,
    bucket_refs_by_salience,
    safe_f_measure,
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
    """Run detection + bucketed F for one song; return raw arrays for viz."""
    audio, sr = load_song_audio_sr(song_dir)
    ref_times = reconstruct_ref_times(song_dir)
    oenv = librosa.onset.onset_strength(
        y=audio, sr=sr, hop_length=config.HOP_LENGTH, fmax=config.FMAX
    )
    est_frames = peak_pick_frames(normalize_envelope(oenv), **params)
    est_times = librosa.frames_to_time(est_frames, sr=sr, hop_length=config.HOP_LENGTH)

    important, filler, cut = bucket_refs_by_salience(ref_times, oenv)
    fi = safe_f_measure(important, est_times)
    ff = safe_f_measure(filler, est_times)

    F_important = float(fi["f_measure"])
    n_est = int(len(est_times))
    return {
        "audio": audio,
        "sr": sr,
        "oenv": oenv,
        "est_times": est_times,
        "ref_times": ref_times,
        "important": important,
        "filler": filler,
        "cut": cut,
        "F_important": F_important,
        "F_filler": float(ff["f_measure"]),
        "n_ref": int(len(ref_times)),
        "n_est": n_est,
        "degenerate": is_degenerate(F_important, n_est),
    }