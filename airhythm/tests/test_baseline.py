"""Tests for the librosa onset detection baseline module."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import numpy as np
import pytest

from airhythm.baseline import (
    BASELINE_EVAL_CSV_HEADER,
    evaluate_onset_fscore,
    evaluate_on_song,
    run_baseline,
    run_librosa_onset_detection,
)
from airhythm.toygen import MetronomeClickGenerator, generate_toy_set


class TestRunLibrosaOnsetDetection:
    """Tests for run_librosa_onset_detection."""

    def test_returns_times_array(self):
        """Run on synthetic audio, verify returns array of times in seconds."""
        sr = 22050
        duration = 2.0
        t = np.linspace(0, duration, int(sr * duration), endpoint=False)
        # Simple sine wave with some clicks (impulse-like peaks)
        audio = np.sin(2 * np.pi * 440 * t).astype(np.float32)
        # Add some sharp transients
        for i in range(4):
            pos = int((i + 1) * sr * 0.5)
            if pos < len(audio):
                audio[pos : pos + int(0.02 * sr)] *= 10.0

        times = run_librosa_onset_detection(audio, sr)
        assert isinstance(times, np.ndarray)
        assert times.ndim == 1
        assert len(times) > 0
        assert np.all(times >= 0.0)
        assert np.all(times <= duration)


class TestEvaluateOnsetFscore:
    """Tests for evaluate_onset_fscore."""

    def test_perfect_match(self):
        """Identical ref and est yields F=1.0."""
        ref = np.array([0.5, 1.0, 1.5, 2.0])
        result = evaluate_onset_fscore(ref, ref.copy())
        assert result["f_measure"] == pytest.approx(1.0)
        assert result["precision"] == pytest.approx(1.0)
        assert result["recall"] == pytest.approx(1.0)
        assert result["n_ref"] == 4
        assert result["n_est"] == 4

    def test_no_match_empty_ref(self):
        """Empty ref yields F=0.0."""
        ref = np.array([])
        est = np.array([0.5, 1.0])
        result = evaluate_onset_fscore(ref, est)
        assert result["f_measure"] == 0.0
        assert result["precision"] == 0.0
        assert result["recall"] == 0.0
        assert result["n_ref"] == 0

    def test_no_match_empty_est(self):
        """Empty est yields F=0.0."""
        ref = np.array([0.5, 1.0])
        est = np.array([])
        result = evaluate_onset_fscore(ref, est)
        assert result["f_measure"] == 0.0
        assert result["n_est"] == 0

    def test_partial(self):
        """Partial match yields F between 0 and 1."""
        ref = np.array([0.5, 1.0, 1.5, 2.0, 2.5])
        est = np.array([0.5, 1.0, 1.5, 3.0, 3.5])
        result = evaluate_onset_fscore(ref, est, window=0.05)
        # 3 correct (0.5, 1.0, 1.5), 2 wrong (3.0, 3.5)
        assert 0.0 < result["f_measure"] < 1.0
        assert result["n_ref"] == 5
        assert result["n_est"] == 5

    def test_returns_all_keys(self):
        """Result dict has all required keys."""
        ref = np.array([0.5, 1.0])
        est = np.array([0.5, 1.0])
        result = evaluate_onset_fscore(ref, est)
        assert set(result.keys()) == {
            "f_measure",
            "precision",
            "recall",
            "n_ref",
            "n_est",
            "window",
        }


class TestEvaluateOnToy:
    """Tests for evaluate_on_toy."""

    def test_returns_aggregate_with_per_sample(self):
        """Run on toy samples, verify aggregate dict structure."""
        toy_samples = generate_toy_set(
            output_dir=tempfile.mkdtemp(),
            n_per_class=2,
        ).samples

        from airhythm.baseline import evaluate_on_toy

        result = evaluate_on_toy(toy_samples)
        assert "mean_f" in result
        assert "mean_p" in result
        assert "mean_r" in result
        assert "per_sample" in result
        assert len(result["per_sample"]) == len(toy_samples)
        for s in result["per_sample"]:
            assert "f_measure" in s
            assert "song_id" in s
            assert "is_toy" in s
            assert s["is_toy"] is True

    def test_baseline_on_toy_below_95_percent(self):
        """Baseline F < 0.95 with default noise (D-12 calibration)."""
        toy_samples = generate_toy_set(
            output_dir=tempfile.mkdtemp(),
            n_per_class=3,
        ).samples

        from airhythm.baseline import evaluate_on_toy

        result = evaluate_on_toy(toy_samples)
        assert result["mean_f"] < 0.95, (
            f"Baseline mean F={result['mean_f']:.4f} >= 0.95 — "
            "toy may be too clean. Increase noise in toygen."
        )


class TestEvaluateOnSong:
    """Tests for evaluate_on_song."""

    def test_returns_all_keys(self):
        """Verify returned dict has all required keys."""
        sr = 22050
        duration = 2.0
        t = np.linspace(0, duration, int(sr * duration), endpoint=False)
        audio = (np.sin(2 * np.pi * 440 * t) * 0.5).astype(np.float32)
        ref_times = np.array([0.5, 1.0, 1.5])

        result = evaluate_on_song(audio, sr, ref_times, "test_song_001")
        assert set(result.keys()) >= {
            "song_id",
            "f_measure",
            "precision",
            "recall",
            "n_ref",
            "n_est",
        }
        assert result["song_id"] == "test_song_001"


class TestRunBaseline:
    """Tests for run_baseline."""

    def test_creates_csv(self):
        """Run on toy samples, verify CSV file created with header."""
        toy_samples = generate_toy_set(
            output_dir=tempfile.mkdtemp(),
            n_per_class=2,
        ).samples

        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
            csv_path = f.name

        try:
            result = run_baseline(toy_samples, output_csv=csv_path)
            assert result["output_csv"] == csv_path
            assert result["total_samples"] == len(toy_samples)
            assert result["real_metrics"] is None

            assert os.path.exists(csv_path)
            with open(csv_path) as f:
                lines = f.readlines()

            assert len(lines) > 1  # header + at least one data row
            header = lines[0].strip()
            assert header == BASELINE_EVAL_CSV_HEADER

            # Check data row has correct number of columns
            for line in lines[1:]:
                cols = line.strip().split(",")
                assert len(cols) == 7
        finally:
            if os.path.exists(csv_path):
                os.unlink(csv_path)


class TestGoldenOnsetTimes:
    """Golden regression test for run_librosa_onset_detection.

    Captures pre-refactor onset times for each song in data/minimal_dataset/.
    First run saves fixtures; subsequent runs assert bit-identical output.
    Expected n_est per song with delta=0.3: 1-35 (degenerate pre-refactor regime).
    """

    # 6 song IDs in minimal_dataset
    SONG_IDS = [
        "2255671",
        "2256944",
        "2516285",
        "2527391",
        "2561773",
        "2589624",
    ]

    @pytest.fixture(scope="class")
    def fixtures_dir(self):
        """Get fixtures directory, create if needed."""
        fixtures = Path(__file__).parent / "fixtures"
        fixtures.mkdir(exist_ok=True)
        return fixtures

    @pytest.fixture(scope="class")
    def minimal_dataset_dir(self):
        """Path to minimal_dataset at repo root."""
        return Path(__file__).parent.parent.parent / "data" / "minimal_dataset"

    @pytest.mark.parametrize("song_id", SONG_IDS)
    def test_golden_onset_times_pre(self, song_id, fixtures_dir, minimal_dataset_dir):
        """Pre-refactor golden times: delta=0.3 regime, n_est in {1..35}."""
        import librosa
        from airhythm import config

        audio_path = minimal_dataset_dir / song_id / "original.audio"
        assert audio_path.exists(), f"Missing audio: {audio_path}"

        audio, sr = librosa.load(audio_path, sr=config.SAMPLE_RATE, mono=True)
        assert sr == config.SAMPLE_RATE

        # Call current (pre-refactor) run_librosa_onset_detection
        onset_times = run_librosa_onset_detection(audio, sr)

        # Verify degenerate pre-refactor regime: n_est in {1..35}
        n_est = len(onset_times)
        assert 1 <= n_est <= 35, (
            f"Song {song_id}: n_est={n_est} outside expected pre-refactor range 1-35. "
            f"This indicates the refactor may have already changed behavior."
        )

        # Fixture path
        fixture_path = fixtures_dir / f"golden_pre_{song_id}.npz"

        # Save + assert: first run writes, subsequent runs verify
        if fixture_path.exists():
            saved = np.load(fixture_path)["onset_times"]
            assert np.array_equal(onset_times, saved), (
                f"Song {song_id}: onset times differ from golden_pre fixture. "
                f"Refactor changed output — investigate."
            )
        else:
            np.savez(fixture_path, onset_times=onset_times)
            # First run: just ensure we saved something valid
            assert len(onset_times) > 0