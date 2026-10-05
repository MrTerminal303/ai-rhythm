"""Tests for extract_chunk_labels (hold + chord labels)."""

import numpy as np
import pytest

from airhythm.audio_preproc import chunk_spectrogram, extract_chunk_labels
from airhythm.osu_parser import HitObject


def _frame(ms):
    """Convert ms to frame index on the REAL grid, matching preprocess."""
    from airhythm import config
    return config.ms_to_frame(ms)


def test_tap_single():
    # one tap at 1000ms, chunk starts at frame 0
    hos = [HitObject(time=1000, end_time=1000, lane=0, type_bitmask=1)]
    labels = extract_chunk_labels(hos, chunk_start_frame=0, n_frames=400)
    assert labels.shape == (3, 400)
    assert labels.dtype == np.int8
    f = _frame(1000)
    assert labels[0, f] == 1      # active
    assert labels[1, f] == 1      # onset
    assert labels[2, f] == 1      # count
    assert labels[0, f + 1] == 0  # tap: no hold span after


def test_hold_span():
    # hold 1000ms -> 2000ms
    hos = [HitObject(time=1000, end_time=2000, lane=0, type_bitmask=8)]
    labels = extract_chunk_labels(hos, chunk_start_frame=0, n_frames=400)
    f0, f1 = _frame(1000), _frame(2000)
    assert labels[0, f0:f1].all() == 1  # active spans whole hold
    assert labels[1, f0] == 1           # onset at start only
    assert labels[1, f0 + 1] == 0
    assert labels[2, f0] == 1           # count at start


def test_chord_count():
    # 2 notes same time, one tap + one hold both at 1000ms
    hos = [
        HitObject(time=1000, end_time=1000, lane=0, type_bitmask=1),
        HitObject(time=1000, end_time=3000, lane=2, type_bitmask=8),
    ]
    labels = extract_chunk_labels(hos, chunk_start_frame=0, n_frames=400)
    f = _frame(1000)
    assert labels[2, f] == 2          # chord of 2
    assert labels[1, f] == 1          # single onset marker
    assert labels[0, f] == 1          # active (the hold starts)
    assert labels[0, _frame(2000)] == 1  # hold still active mid-span
    assert labels[0, _frame(3000)] == 0  # hold ended


def test_chunk_offset():
    # note at 2000ms, chunk starts at frame 200 -> frame 0 is 2000ms
    hos = [HitObject(time=2000, end_time=2000, lane=0, type_bitmask=1)]
    labels = extract_chunk_labels(hos, chunk_start_frame=200, n_frames=400)
    assert labels[1, 0] == 1  # onset at chunk-local frame 0


def test_out_of_chunk_ignored():
    hos = [HitObject(time=100000, end_time=100000, lane=0, type_bitmask=1)]
    labels = extract_chunk_labels(hos, chunk_start_frame=0, n_frames=400)
    assert not labels.any()


def test_chunk_spectrogram_keeps_tail():
    # review #3 Option B: 901-frame song -> 3 chunks, tail edge-padded (no silent loss)
    spec = np.zeros((1, 128, 901), dtype=np.float32)
    chunks = chunk_spectrogram(spec, n_frames=400)
    assert len(chunks) == 3
    assert all(c.shape == (1, 128, 400) for c in chunks)
    # exact-divisible song: no extra chunk
    exact = chunk_spectrogram(np.zeros((1, 128, 800), dtype=np.float32), n_frames=400)
    assert len(exact) == 2
    # short song: single padded chunk (pre-existing behavior)
    short = chunk_spectrogram(np.zeros((1, 128, 300), dtype=np.float32), n_frames=400)
    assert len(short) == 1
