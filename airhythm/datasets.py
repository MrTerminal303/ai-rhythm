from __future__ import annotations

from pathlib import Path

import numpy as np

from airhythm import config

__all__ = [
    "split_song_ids",
    "boundary_fraction",
    "build_full_song_cache",
    "RandomCropDataset",
    "FixedChunkDataset",
]


def split_song_ids(all_ids, eval_ids, search_id, *, val_every: int = config.VAL_SPLIT_EVERY):
    """D-06/D-07: exclude eval+search IDs, then deterministic song-level split.

    Sort remaining IDs ascending; every `val_every`-th (0-indexed position % val_every == 0)
    goes to val, rest to train. Returns (train_ids, val_ids, excluded_ids) as sorted lists.
    Raises AssertionError-free ValueError if any eval/search ID missing exclusion — the
    function never returns an ID that appears in excluded anywhere else.
    """
    excluded = set(eval_ids) | {search_id}
    keep = sorted(set(all_ids) - excluded)
    val = [sid for i, sid in enumerate(keep) if i % val_every == 0]
    val_set = set(val)
    train = [sid for sid in keep if sid not in val_set]
    return train, val, sorted(excluded & set(all_ids))


def boundary_fraction(song_dir, *, k: int = config.BOUNDARY_K, n_frames: int = config.N_FRAMES) -> float:
    """D-05 measurement: fraction of positive onset frames within k frames of a fixed-chunk edge.

    Concatenate *_labels.npy (3, T) like reconstruct_ref_times; onset row = labels[1].
    Boundary iff (f % n_frames) < k or (f % n_frames) > n_frames - k.
    Returns 0.0 when there are zero onsets.
    """
    song_dir = Path(song_dir)
    files = sorted(song_dir.glob("*_labels.npy"))
    if not files:
        return 0.0
    labels = np.concatenate([np.load(p) for p in files], axis=1)  # (3, T)
    onset_frames = np.where(labels[1] == 1)[0]
    if onset_frames.size == 0:
        return 0.0
    mod = onset_frames % n_frames
    boundary = (mod < k) | (mod > n_frames - k)
    return float(boundary.mean())
