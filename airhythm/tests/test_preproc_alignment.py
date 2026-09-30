"""Mel↔label frame alignment + rate-drift gate (Phase 6).

Own file so a torchaudio import failure surfaces as ONE file's error while the
model gate (test_model.py) still runs first as its own command; multi-file runs
use --continue-on-collection-errors. NO importorskip: a silent skip is worse
than red."""
from __future__ import annotations

import numpy as np
import pytest

from airhythm import config
from airhythm.audio_preproc import audio_to_mel_spec, extract_chunk_labels
from airhythm.osu_parser import HitObject


class TestPreprocAlignment:
    """Mel-frame <-> label-frame agreement. labels[1] = onset row
    (audio_preproc.py:238/249). Parametrized to 120s: the label builder's
    rate must match the REAL mel grid (sr/hop = 100.227 fps), not 100 fps —
    at 2.0s the drift is 0.46 frame (invisible), at 120s it is 27 frames."""

    @pytest.mark.parametrize("t_click", [2.0, 61.234, 120.0])
    def test_click_alignment_no_drift(self, t_click):
        sr = config.SAMPLE_RATE
        audio = np.zeros(int(sr * (t_click + 3)), dtype=np.float32)
        audio[int(round(t_click * sr))] = 1.0          # click at t_click seconds
        mel = audio_to_mel_spec(audio, sr)
        assert mel.ndim == 3, f"unexpected mel shape {mel.shape}"
        peak = int(mel.sum(axis=(0, 1)).argmax())      # energy-peak mel frame
        start = max(0, peak - 150)                     # NONZERO at t=2.0 too (round-4: peak-200 == 0 there)
        ho = HitObject(time=t_click * 1000.0, end_time=t_click * 1000.0, lane=0, type_bitmask=1)
        labels = extract_chunk_labels([ho], chunk_start_frame=start, n_frames=400)
        onset = start + int(np.nonzero(labels[1])[0][0])
        print(f"t={t_click} mel_shape={mel.shape} labels_shape={labels.shape} peak={peak} onset={onset}")
        assert abs(peak - onset) <= 1, f"t={t_click}: mel peak {peak} vs label {onset} (drift)"


class TestFPSHelpers:
    """Shared frame-grid helpers (round-4 blocker): one helper, every consumer —
    120s round-trip proves the grid; grep ACs prove no consumer bypasses it."""

    def test_ms_to_frame_roundtrip_120s(self):
        f = config.ms_to_frame(120_000)
        assert f == round(120 * config.FPS), f"expected {round(120 * config.FPS)}, got {f}"
        assert abs(config.frame_to_ms(f) - 120_000) <= 1000 / config.FPS

    def test_fps_is_real_grid(self):
        assert config.FPS == config.SAMPLE_RATE / config.HOP_LENGTH
        f61 = config.ms_to_frame(61_234)
        assert abs(config.frame_to_ms(f61) - 61_234) <= 1000 / config.FPS
