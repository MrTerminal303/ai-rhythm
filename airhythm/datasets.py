from __future__ import annotations

import random
from pathlib import Path

import librosa
import mir_eval
import mir_eval.onset  # needed for mir_eval.onset.util.match_events
import numpy as np
import torch

from airhythm import config
from airhythm.audio_preproc import audio_to_mel_spec, normalize_chunk

__all__ = [
    "split_song_ids",
    "boundary_fraction",
    "proximity_binned_recall",
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


def proximity_binned_recall(ref_frames, est_frames, *, n_frames: int = config.N_FRAMES,
                            n_bins: int = 4) -> dict:
    """D-05 mitigation-sizer: recall of matched refs as a function of distance-to-chunk-edge.

    edge_dist(f) = min(f % n_frames, n_frames - (f % n_frames))  # 0 = on the edge
    Refs binned into n_bins equal-width bins over [0, n_frames//2). Match ONCE globally
    (mir_eval.onset.util.match_events on frame->seconds conversion, window=0.05s —
    IDENTICAL to the eval path), then partitioned by ref bin. Per-bin recall =
    matched_in_bin / refs_in_bin (0.0 if empty). Returns {"bin_edges", "n_refs",
    "recall", "worst_bin", "edge_recall", "degradation"}.
    degradation=True (edge_recall < overall recall * 0.9) means the chunk edge REALLY
    hurts — the only condition under which D-05 allows context-margin mitigation.
    """
    ref = np.asarray(ref_frames, dtype=float)
    est = np.asarray(est_frames, dtype=float)
    bin_max = n_frames // 2
    width = max(1, bin_max // n_bins)
    bin_edges = [min(i * width, bin_max) for i in range(n_bins)] + [bin_max]

    # single global match, seconds conversion identical to eval path
    ref_times = librosa.frames_to_time(ref, sr=config.SAMPLE_RATE, hop_length=config.HOP_LENGTH)
    est_times = librosa.frames_to_time(est, sr=config.SAMPLE_RATE, hop_length=config.HOP_LENGTH)
    matched = mir_eval.onset.util.match_events(ref_times, est_times, window=0.05)
    matched_ref_idx = {r for r, _e in matched}

    if ref.size:
        dist = np.minimum(ref % n_frames, n_frames - (ref % n_frames))
        bin_idx = np.minimum(dist // width, n_bins - 1).astype(int)
    else:
        bin_idx = np.zeros(0, dtype=int)

    n_refs = [int((bin_idx == b).sum()) for b in range(n_bins)]
    matched_in_bin = [sum(1 for i in matched_ref_idx if bin_idx[i] == b)
                      for b in range(n_bins)]
    recall = [(m / n if n else 0.0) for m, n in zip(matched_in_bin, n_refs)]
    overall = (len(matched) / len(ref)) if ref.size else 0.0
    edge_recall = recall[0]
    return {
        "bin_edges": bin_edges,
        "n_refs": n_refs,
        "recall": recall,
        "worst_bin": int(np.argmin(recall)),
        "edge_recall": edge_recall,
        "degradation": bool(edge_recall < overall * 0.9),
    }


def _song_stem(song_dir: Path) -> str:
    metas = sorted(song_dir.glob("*_*.json"))
    for m in metas:
        if "_full_" not in m.name:
            return m.stem
    return song_dir.name


def build_full_song_cache(song_dir, cache_root=None) -> tuple[Path, Path]:
    """D-05: one-time per-song build of FULL-SONG spec + FULL-SONG labels for random crops.

    Spec: librosa/audio_to_mel_spec(load original.audio) -> raw (1,128,T) float32
      -> save `<stem>_full_spec.npy` (RAW, NOT per-chunk-normalized).
      If original.audio missing/empty: raise FileNotFoundError (caller falls back to
      fixed chunks — print, never silently fake a crop).
    Labels: np.concatenate(sorted *_labels.npy, axis=1) -> (3,T) int8
      -> save `<stem>_full_labels.npy` (exact concatenation of stored labels;
      they are already absolute-frame anchored, so no reparse needed).
    Cache location: song_dir itself (default) or cache_root when given —
    review #6: attached Kaggle corpus is read-only, caches must land in the
    writable working disk. Returns (spec_path, label_path). Idempotent: if
    both files exist, return them unchanged.
    """
    song_dir = Path(song_dir)
    stem = _song_stem(song_dir)
    out_dir = song_dir if cache_root is None else Path(cache_root)
    if cache_root is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
    spec_path = out_dir / f"{stem}_full_spec.npy"
    label_path = out_dir / f"{stem}_full_labels.npy"
    if spec_path.exists() and label_path.exists():
        return spec_path, label_path
    audio_path = song_dir / "original.audio"
    if not audio_path.exists() or audio_path.stat().st_size == 0:
        raise FileNotFoundError(f"original.audio missing/empty in {song_dir}")
    audio, _sr = librosa.load(str(audio_path), sr=config.SAMPLE_RATE, mono=True)
    spec = audio_to_mel_spec(audio.astype(np.float32), config.SAMPLE_RATE)
    label_files = sorted(
        p for p in song_dir.glob("*_labels.npy") if "_full_" not in p.name
    )
    if not label_files:
        raise FileNotFoundError(f"no *_labels.npy in {song_dir}")
    labels = np.concatenate([np.load(p) for p in label_files], axis=1)
    # ponytail: stored chunks drop the STFT tail (spec T >= labels T by up to
    # N_FRAMES-1); trim spec to labels T so crop offsets index both identically.
    n_spec, n_lab = spec.shape[2], labels.shape[1]
    if n_spec > n_lab:
        spec = spec[:, :, :n_lab].copy()
    elif n_lab > n_spec:
        spec = np.pad(spec, ((0, 0), (0, 0), (0, n_lab - n_spec)), mode="edge")
    np.save(spec_path, spec)
    np.save(label_path, labels.astype(np.int8))
    return spec_path, label_path


class RandomCropDataset(torch.utils.data.Dataset):
    """D-05 TRAIN-side only. Seeded random crops over full-song spec + labels."""

    def __init__(self, song_dirs, *, n_frames: int = config.N_FRAMES,
                 crops_per_song: int = 1, rng=None, cache_root=None):
        super().__init__()
        self.n_frames = n_frames
        self.crops_per_song = crops_per_song
        self.rng = rng if rng is not None else random.Random()
        self._specs: list[np.ndarray] = []
        self._labels: list[np.ndarray] = []
        for song_dir in song_dirs:
            spec_path, label_path = build_full_song_cache(song_dir, cache_root=cache_root)
            self._specs.append(np.load(spec_path))
            self._labels.append(np.load(label_path))

    def __len__(self):
        return len(self._specs) * self.crops_per_song

    def _worker_rng(self):
        info = torch.utils.data.get_worker_info()
        if info is None or isinstance(self.rng, torch.Generator):
            return self.rng
        # DataLoader workers inherit the same pickled rng state -> identical
        # crop streams across workers (duplicate crops). Fork once per worker
        # keyed by torch's unique per-worker seed. Main-process path (workers=0)
        # returns the seeded rng untouched — determinism unchanged.
        if getattr(self, "_wrng_seed", None) != info.seed:
            self._wrng_seed = info.seed
            self.rng = random.Random(info.seed)
        return self.rng

    def __getitem__(self, idx):
        song_idx = (idx // self.crops_per_song) % len(self._specs)
        spec = self._specs[song_idx]
        full_labels = self._labels[song_idx]
        T = spec.shape[2]
        rng = self._worker_rng()
        if T >= self.n_frames:
            if isinstance(rng, torch.Generator):
                off = int(torch.randint(0, T - self.n_frames + 1, (1,), generator=rng).item())
            else:
                off = int(rng.randint(0, T - self.n_frames + 1))
        else:
            off = 0
        crop = spec[:, :, off : off + self.n_frames]
        if crop.shape[2] < self.n_frames:
            crop = np.pad(crop, ((0, 0), (0, 0), (0, self.n_frames - crop.shape[2])), mode="edge")
        lab = full_labels[:, off : off + self.n_frames]
        if lab.shape[1] < self.n_frames:
            lab = np.pad(lab, ((0, 0), (0, self.n_frames - lab.shape[1])), mode="edge")
        crop = normalize_chunk(crop)
        return torch.tensor(crop).float(), torch.tensor(lab).float()


class FixedChunkDataset(torch.utils.data.Dataset):
    """VAL-side: loads stored 0000.npy/0000_labels.npy pairs as-is (stable val loss)."""

    def __init__(self, song_dirs):
        super().__init__()
        self._pairs: list[tuple[Path, Path]] = []
        for song_dir in song_dirs:
            song_dir = Path(song_dir)
            for spec_path in sorted(song_dir.glob("[0-9]*.npy")):
                if "_labels" in spec_path.name or "_full_" in spec_path.name:
                    continue
                label_path = spec_path.parent / f"{spec_path.stem}_labels.npy"
                if label_path.exists():
                    self._pairs.append((spec_path, label_path))

    def __len__(self):
        return len(self._pairs)

    def __getitem__(self, idx):
        spec_path, label_path = self._pairs[idx]
        spec = np.load(spec_path).astype(np.float32)
        labels = np.load(label_path).astype(np.float32)
        return torch.tensor(spec).float(), torch.tensor(labels).float()
