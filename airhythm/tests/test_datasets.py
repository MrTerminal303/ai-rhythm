from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pytest

from airhythm import config
from airhythm.datasets import boundary_fraction, split_song_ids


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
