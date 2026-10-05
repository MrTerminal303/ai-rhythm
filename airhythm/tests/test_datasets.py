from __future__ import annotations

import random
import shutil
from pathlib import Path

import numpy as np
import pytest

from airhythm import config
from airhythm.datasets import (
    boundary_fraction,
    FixedChunkDataset,
    proximity_binned_recall,
    RandomCropDataset,
    build_full_song_cache,
    split_song_ids,
)


class TestSplit:
    def test_exact_lists_and_no_overlap(self):
        train, val, excluded = split_song_ids(
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            eval_ids=[2, 3],
            search_id=5,
        )
        assert excluded == [2, 3, 5]
        # sorted keep = [1,4,6,7,8,9,10,11,12]; position 0 -> val
        assert val == [1]
        assert train == [4, 6, 7, 8, 9, 10, 11, 12]
        assert set(train) & set(val) == set()
        assert set(train) | set(val) == {1, 4, 6, 7, 8, 9, 10, 11, 12}

    def test_real_minimal_dataset_no_leakage(self):
        base = Path("data/minimal_dataset")
        all_ids = [p.name for p in base.iterdir() if p.is_dir()]
        eval_ids = ["2255671", "2256944", "2516285", "2527391", "2589624"]
        train, val, excluded = split_song_ids(
            all_ids, eval_ids=eval_ids, search_id="2561773"
        )
        assert set(train) & set(val) == set()
        assert set(train + val) & set(excluded) == set()
        for eid in eval_ids + ["2561773"]:
            if eid in all_ids:
                assert eid in excluded
                assert eid not in train and eid not in val

    def test_determinism(self):
        ids = [str(i) for i in range(30, 1, -1)]
        a = split_song_ids(ids, eval_ids=["7"], search_id="8")
        b = split_song_ids(ids, eval_ids=["7"], search_id="8")
        assert a == b


class TestBoundary:
    def _write_labels(self, song_dir: Path, idx: int, onset_frames: list[int]):
        labels = np.zeros((3, config.N_FRAMES), dtype=np.int8)
        for f in onset_frames:
            if 0 <= f < config.N_FRAMES:
                labels[1, f] = 1
        np.save(song_dir / f"{idx:04d}_labels.npy", labels)

    def test_all_boundary_fraction_one(self, tmp_path):
        song = tmp_path / "song"
        song.mkdir()
        # absolute frames [0, 4, 396] in chunk 0, [402] in chunk 1 (402 % 400 == 2)
        self._write_labels(song, 0, [0, 4, 396])
        self._write_labels(song, 1, [2])
        assert boundary_fraction(song) == pytest.approx(1.0)

    def test_none_boundary_fraction_zero(self, tmp_path):
        song = tmp_path / "song"
        song.mkdir()
        self._write_labels(song, 0, [10])
        self._write_labels(song, 1, [10])
        # absolute: chunk1 frame 10 -> 410; add third chunk frame 10 -> 810
        self._write_labels(song, 2, [10])
        assert boundary_fraction(song) == pytest.approx(0.0)

    def test_empty_onsets_zero(self, tmp_path):
        song = tmp_path / "song"
        song.mkdir()
        self._write_labels(song, 0, [])
        assert boundary_fraction(song) == pytest.approx(0.0)

    def test_real_song_in_range(self):
        song = Path("data/minimal_dataset/2255671")
        frac = boundary_fraction(song)
        assert 0.0 <= frac <= 1.0
        print(f"\nboundary_fraction(2255671)={frac:.4f}")


class TestFullSongCache:
    def _copy_song(self, src: str, dst: Path) -> Path:
        song = dst / "song"
        shutil.copytree(Path("data/minimal_dataset") / src, song)
        return song

    def test_build_and_idempotent_and_bitwise(self, tmp_path):
        song = self._copy_song("2255671", tmp_path)
        spec_path, label_path = build_full_song_cache(song)
        assert spec_path.exists() and label_path.exists()
        expected = np.concatenate(
            [np.load(p) for p in sorted(song.glob("*_labels.npy")) if "_full_" not in p.name],
            axis=1,
        )
        assert np.array_equal(np.load(label_path), expected)
        spec = np.load(spec_path)
        labels = np.load(label_path)
        assert spec.shape[0] == 1 and spec.shape[1] == config.N_MELS
        assert spec.shape[2] == labels.shape[1]
        mtime = (spec_path.stat().st_mtime, label_path.stat().st_mtime)
        spec_path2, label_path2 = build_full_song_cache(song)
        assert (spec_path2, label_path2) == (spec_path, label_path)
        assert (spec_path.stat().st_mtime, label_path.stat().st_mtime) == mtime

    def test_spec_shape_matches_labels(self, tmp_path):
        song = self._copy_song("2256944", tmp_path)
        spec_path, label_path = build_full_song_cache(song)
        spec = np.load(spec_path)
        labels = np.load(label_path)
        assert spec.shape == (1, config.N_MELS, labels.shape[1])

    def test_missing_audio_raises(self, tmp_path):
        song = tmp_path / "song"
        song.mkdir()
        np.save(song / "0000_labels.npy", np.zeros((3, config.N_FRAMES), dtype=np.int8))
        with pytest.raises(FileNotFoundError):
            build_full_song_cache(song)


class TestRandomCrop:
    def _songs(self, tmp_path) -> list[Path]:
        out = []
        for sid in ("2255671", "2256944"):
            dest = tmp_path / sid
            shutil.copytree(Path("data/minimal_dataset") / sid, dest)
            out.append(dest)
        return out

    def test_len_and_shapes(self, tmp_path):
        songs = self._songs(tmp_path)
        ds = RandomCropDataset(songs, rng=random.Random(0))
        assert len(ds) == 2
        spec, labels = ds[0]
        assert tuple(spec.shape) == (1, 128, 400)
        assert tuple(labels.shape) == (3, 400)
        assert spec.dtype == labels.dtype

    def test_label_consistency_with_seeded_offset(self, tmp_path):
        import torch

        songs = self._songs(tmp_path)
        seed = 0
        ds = RandomCropDataset(songs, rng=random.Random(seed))
        # Re-derive the offset the dataset used for idx 0: first rng draw
        probe = random.Random(seed)
        song_idx = 0  # idx 0 maps to songs[0] with crops_per_song=1
        full_labels = np.load(
            next(iter(sorted(songs[song_idx].glob("*_full_labels.npy"))))
            if list(songs[song_idx].glob("*_full_labels.npy"))
            else build_full_song_cache(songs[song_idx])[1]
        )
        T = full_labels.shape[1]
        off = int(probe.randint(0, T - config.N_FRAMES + 1)) if T >= config.N_FRAMES else 0
        _, labels = ds[0]
        assert torch.equal(labels, torch.tensor(full_labels[:, off : off + 400]).float())

    def test_fixed_chunk_matches_stored(self):
        ds = FixedChunkDataset([Path("data/minimal_dataset/2255671")])
        spec, labels = ds[0]
        assert tuple(spec.shape) == (1, 128, 400)
        assert tuple(labels.shape) == (3, 400)
        assert np.array_equal(
            spec.numpy(), np.load("data/minimal_dataset/2255671/0000.npy")
        )

    def test_same_seed_same_first_crop(self, tmp_path):
        songs = self._songs(tmp_path)
        a = RandomCropDataset(songs, rng=random.Random(0))
        b = RandomCropDataset(songs, rng=random.Random(0))
        sa, la = a[0]
        sb, lb = b[0]
        import torch

        assert torch.equal(sa, sb) and torch.equal(la, lb)


class TestProximityBins:
    """D-05 mitigation-sizer: recall binned by distance-to-chunk-edge."""

    @staticmethod
    def _edge_dist(f, n_frames=400):
        return min(f % n_frames, n_frames - (f % n_frames))

    def test_identical_est_full_recall(self):
        # refs at chunk edge (f=1..3), bin interiors, and center (f=190..210)
        refs = [1, 2, 3, 60, 110] + list(range(190, 211))
        out = proximity_binned_recall(refs, list(refs))
        assert out["n_refs"] == [3, 1, 1, 21]  # 4 bins over [0, 200)
        assert all(r == 1.0 for r in out["recall"])
        assert out["degradation"] is False
        assert out["edge_recall"] == 1.0

    def test_edge_blind_model_degrades(self):
        refs = [1, 2, 3] + list(range(190, 211))
        est = [f for f in refs if self._edge_dist(f) >= 20]  # drop edge refs
        out = proximity_binned_recall(refs, est)
        assert out["recall"][0] == 0.0  # bin 0 saw all its refs dropped
        assert out["worst_bin"] == 0
        assert out["degradation"] is True

    def test_empty_refs(self):
        out = proximity_binned_recall([], [10, 20])
        assert out["recall"] == [0.0, 0.0, 0.0, 0.0]
        assert out["n_refs"] == [0, 0, 0, 0]
        assert out["degradation"] is False

    def test_n_refs_partition(self):
        refs = list(range(1, 400, 7))  # spread across all bins
        out = proximity_binned_recall(refs, refs)
        assert sum(out["n_refs"]) == len(refs)
        assert len(out["bin_edges"]) == 5


class TestWorkerRNG:
    """Review #2: DataLoader workers inherit the same pickled rng state ->
    identical crop streams. _worker_rng forks per worker; workers=0 unchanged."""

    @staticmethod
    def _ds() -> RandomCropDataset:
        ds = RandomCropDataset.__new__(RandomCropDataset)
        ds.rng = random.Random(0)
        return ds

    def test_main_process_returns_untouched_rng(self, monkeypatch):
        ds = self._ds()
        monkeypatch.setattr("torch.utils.data.get_worker_info", lambda: None)
        before = ds.rng.getstate()
        assert ds._worker_rng() is ds.rng
        assert ds.rng.getstate() == before

    def test_workers_get_distinct_stable_streams(self, monkeypatch):
        class W:
            def __init__(self, seed):
                self.seed = seed

        monkeypatch.setattr("torch.utils.data.get_worker_info", lambda: W(111))
        a = self._ds()
        ra = a._worker_rng()
        monkeypatch.setattr("torch.utils.data.get_worker_info", lambda: W(222))
        rb = self._ds()._worker_rng()
        assert ra is not rb
        assert [ra.random() for _ in range(5)] != [rb.random() for _ in range(5)]
        # same worker seed again -> same rng object (no re-fork mid-epoch)
        monkeypatch.setattr("torch.utils.data.get_worker_info", lambda: W(111))
        assert a._worker_rng() is ra
