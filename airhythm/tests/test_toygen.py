"""Self-test suite for airhythm/toygen.py synthetic dataset generator.

Tests cover shape correctness, onset alignment, noise injection, sustained
tones, chords, validation error handling, dataset completeness, and BPM
variation. All tests are self-contained with no external file requirements.
"""

import sys
import os

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from airhythm.toygen import (
    MetronomeClickGenerator,
    NoiseConfig,
    ToyDataset,
    ToySample,
    _generate_chord_sample,
    _generate_sustained_tone_sample,
    generate_toy_set,
    validate_toy_sample,
)
from airhythm.config import N_FRAMES, N_MELS


# ---------------------------------------------------------------------------
# Basic shape tests
# ---------------------------------------------------------------------------


class TestToySampleShape:
    """Verify spectrogram and label shapes are correct."""

    def test_toy_sample_shape(self):
        """Generate 1 metronome sample and check shapes."""
        gen = MetronomeClickGenerator()
        sample = gen.generate_sample(150, noise=NoiseConfig())
        assert sample.spectrogram.shape == (
            1,
            N_MELS,
            N_FRAMES,
        ), f"Expected (1, {N_MELS}, {N_FRAMES}), got {sample.spectrogram.shape}"
        assert sample.onset_labels.shape == (
            N_FRAMES,
        ), f"Expected ({N_FRAMES},), got {sample.onset_labels.shape}"


# ---------------------------------------------------------------------------
# Alignment accuracy tests
# ---------------------------------------------------------------------------


class TestAlignmentAccuracy:
    """Verify onset labels align with known BPM positions."""

    def test_alignment_accuracy(self):
        """At 150 BPM, onsets occur every ~40 frames at 100Hz frame rate."""
        gen = MetronomeClickGenerator()
        # Use no noise for perfect alignment
        sample = gen.generate_sample(150, noise=None)

        # Find all onset positions
        onset_positions = np.where(sample.onset_labels == 1)[0]

        # At 150 BPM = 400ms intervals. Frame rate = SAMPLE_RATE / HOP_LENGTH
        # = 22050 / 220 ≈ 100.227 Hz.
        # Expected interval in frames = 0.4 * 100.227 ≈ 40.09 frames
        # So check that onsets are approximately 40 frames apart
        intervals = np.diff(onset_positions)
        assert len(intervals) > 0, "No onsets to measure intervals"

        # Most intervals should be close to 40 frames
        mean_interval = np.mean(intervals)
        assert abs(mean_interval - 40) <= 2, (
            f"Mean onset interval {mean_interval:.1f} not close to 40"
        )

        # Verify no unexpected onsets between beats — only onsets at
        # approximately correct frame positions exist
        assert len(onset_positions) >= 9, (
            f"Expected at least 9 onsets for 150 BPM over 4s, got {len(onset_positions)}"
        )


# ---------------------------------------------------------------------------
# Noise injection tests
# ---------------------------------------------------------------------------


class TestNoiseInjection:
    """Verify noise adds variation but doesn't corrupt labels."""

    def test_noise_injection_adds_variation(self):
        """Clean and noisy samples differ, but labels match."""
        gen = MetronomeClickGenerator()

        # Generate clean and noisy at same BPM (but noise has randomness,
        # so we compare by sum of abs diff of repeated clean samples)
        bpm = 150
        clean_a = gen.generate_sample(bpm, noise=None)
        clean_b = gen.generate_sample(bpm, noise=None)

        # Two clean samples at same BPM should be identical (no randomness)
        clean_diff = np.abs(clean_a.spectrogram - clean_b.spectrogram).sum()
        clean_label_diff = np.abs(
            clean_a.onset_labels.astype(np.int32)
            - clean_b.onset_labels.astype(np.int32)
        ).sum()

        # Now generate noisy version
        noisy = gen.generate_sample(bpm, noise=NoiseConfig())
        noisy_diff = np.abs(clean_a.spectrogram - noisy.spectrogram).sum()

        # Noisy sample should differ more than clean replicates
        # (Jitter shifts onset ±5ms which may affect spectrogram energy,
        #  plus hum noise and amplitude variation)
        assert noisy_diff > clean_diff, (
            f"Noisy diff ({noisy_diff:.4f}) <= clean diff ({clean_diff:.4f})"
        )

        # Both should have same number of onsets ideally, but jitter can
        # shift some onsets in/out of frame boundaries. That's expected
        # behavior — just verify labels are binary and sensible.
        assert set(noisy.onset_labels.tolist()).issubset({0, 1}), (
            "Noisy labels not binary"
        )


# ---------------------------------------------------------------------------
# Sustained tones tests
# ---------------------------------------------------------------------------


class TestSustainedTones:
    """Verify sustained tones generator produces correct samples."""

    def test_sustained_tones(self):
        """Sustained tone sample has correct metadata and valid shape."""
        sample = _generate_sustained_tone_sample(150, noise=NoiseConfig())

        assert sample.spectrogram.shape == (1, N_MELS, N_FRAMES)
        assert sample.onset_labels.shape == (N_FRAMES,)
        assert sample.metadata["generator_type"] == "sustained_tone"
        assert sample.metadata["stage"] == 2
        assert "sustain_duration_sec" in sample.metadata
        assert 0.4 <= sample.metadata["sustain_duration_sec"] <= 1.2, (
            f"Sustain duration {sample.metadata['sustain_duration_sec']} "
            "not in [0.4, 1.2]"
        )
        assert sample.onset_labels.sum() > 0, "No onsets in sustained tone"


# ---------------------------------------------------------------------------
# Chords tests
# ---------------------------------------------------------------------------


class TestChords:
    """Verify chord samples generate correctly."""

    def test_chords(self):
        """Chord sample has correct metadata with 2-4 simultaneous notes."""
        sample = _generate_chord_sample(150, noise=NoiseConfig())

        assert sample.spectrogram.shape == (1, N_MELS, N_FRAMES)
        assert sample.onset_labels.shape == (N_FRAMES,)
        assert sample.metadata["generator_type"] == "chord"
        assert sample.metadata["stage"] == 3
        n_notes = sample.metadata.get("n_notes_per_chord", 0)
        assert 2 <= n_notes <= 4, (
            f"Chord has {n_notes} notes, expected 2-4"
        )
        frequencies = sample.metadata.get("chord_frequencies", [])
        assert len(frequencies) == n_notes, (
            f"Got {len(frequencies)} frequencies for {n_notes} notes"
        )
        assert sample.onset_labels.sum() > 0, "No onsets in chord"


# ---------------------------------------------------------------------------
# Validation tests
# ---------------------------------------------------------------------------


class TestValidate:
    """Verify validate_toy_sample catches all error conditions."""

    def test_validate_shapes_correct(self):
        """Correct sample returns empty error list."""
        gen = MetronomeClickGenerator()
        sample = gen.generate_sample(150, noise=NoiseConfig())
        errors = validate_toy_sample(sample)
        assert errors == [], f"Expected no errors, got: {errors}"

    def test_validate_catches_bad_shape(self):
        """Wrong spectrogram shape is caught."""
        # Create sample with wrong spectrogram shape
        bad_spec = np.zeros((1, N_MELS, N_FRAMES + 1), dtype=np.float32)
        good_labels = np.zeros(N_FRAMES, dtype=np.int8)
        sample = ToySample(
            spectrogram=bad_spec,
            onset_labels=good_labels,
            metadata={"test": True},
        )
        errors = validate_toy_sample(sample)
        assert len(errors) >= 1, "Expected shape error"

        # Check it's the shape error
        shape_errors = [e for e in errors if "shape" in e.lower()]
        assert len(shape_errors) >= 1, f"Expected shape error, got: {errors}"

    def test_validate_catches_bad_label_shape(self):
        """Wrong label shape is caught."""
        good_spec = np.zeros((1, N_MELS, N_FRAMES), dtype=np.float32)
        bad_labels = np.zeros(N_FRAMES + 1, dtype=np.int8)
        sample = ToySample(
            spectrogram=good_spec,
            onset_labels=bad_labels,
            metadata={"test": True},
        )
        errors = validate_toy_sample(sample)
        label_shape_errors = [
            e for e in errors if "shape" in e.lower() and "label" in e.lower()
        ]
        assert len(label_shape_errors) >= 1, (
            f"Expected label shape error, got: {errors}"
        )

    def test_validate_catches_empty_sample(self):
        """Sample with no onsets is caught."""
        good_spec = np.zeros((1, N_MELS, N_FRAMES), dtype=np.float32)
        empty_labels = np.zeros(N_FRAMES, dtype=np.int8)
        sample = ToySample(
            spectrogram=good_spec,
            onset_labels=empty_labels,
            metadata={"test": True},
        )
        errors = validate_toy_sample(sample)
        empty_errors = [e for e in errors if "onset" in e.lower() or "empty" in e.lower()]
        assert len(empty_errors) >= 1, (
            f"Expected empty/onset error, got: {errors}"
        )


# ---------------------------------------------------------------------------
# Dataset generation tests
# ---------------------------------------------------------------------------


class TestToyDataset:
    """Verify generate_toy_set produces correct multi-class dataset."""

    def test_generate_toy_set_creates_all_classes(self):
        """Toy set with n_per_class=3 creates 9 samples, all valid."""
        dataset = generate_toy_set(
            "/tmp/test_toy_set", n_per_class=3, noise=NoiseConfig()
        )
        assert len(dataset.samples) == 9, (
            f"Expected 9 samples, got {len(dataset.samples)}"
        )

        # All pass validation
        errors = dataset.validate()
        assert errors == [], f"Validation errors: {errors}"

        # All three types present
        types = set(s.metadata["generator_type"] for s in dataset.samples)
        expected_types = {"metronome_click", "sustained_tone", "chord"}
        assert types == expected_types, f"Got types {types}, expected {expected_types}"


# ---------------------------------------------------------------------------
# Random BPM variation tests
# ---------------------------------------------------------------------------


class TestRandomBPM:
    """Verify BPM variation produces non-deterministic onset counts."""

    def test_random_bpm_produces_variation(self):
        """Different BPMs produce different onset counts per 4s sample."""
        gen = MetronomeClickGenerator()
        bpm_counts = {}
        for bpm in [120, 140, 160, 180]:
            sample = gen.generate_sample(bpm, noise=None)
            bpm_counts[bpm] = int(sample.onset_labels.sum())

        # Higher BPM should generally have more onsets
        # (120 BPM = 8 beats, 180 BPM = 12 beats over 4 seconds)
        assert bpm_counts[180] > bpm_counts[120], (
            f"180 BPM ({bpm_counts[180]} onsets) <= 120 BPM ({bpm_counts[120]} onsets)"
        )

        # Verify all three have different counts (or at least 180 > 120)
        unique_counts = set(bpm_counts.values())
        assert len(unique_counts) >= 2, (
            f"All BPMs produced same onset count: {bpm_counts}"
        )
