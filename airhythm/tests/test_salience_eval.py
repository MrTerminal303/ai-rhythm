"""Gate-math fixture tests for salience_eval (EVL-03/EVL-04, D-01..D-04).

Task 1 (08-05): TestBucketCut — cut_frac parametrization + gate constants.
Task 2 (08-05): TestEstTimes/TestGateMath/TestGateFlag — appended.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from airhythm import config
from airhythm.pin_baseline import bucket_refs_by_salience

REPO_ROOT = Path(__file__).resolve().parents[2]
PIN_PATH = REPO_ROOT / "data" / "eval_pins.json"


def _synth_refs_oenv() -> tuple[np.ndarray, np.ndarray]:
    """10 equally spaced refs (1s apart); oenv flat 0.1 with peaks at first 3 ref frames."""
    ref_times = np.arange(10) * 1.0
    frames = np.clip(
        np.round(ref_times * config.SAMPLE_RATE / config.HOP_LENGTH).astype(int), 0, None
    )
    oenv = np.full(frames[-1] + 1, 0.1)
    for f in frames[:3]:
        oenv[max(0, f - 2) : f + 3] = 1.0
    return ref_times, oenv


class TestBucketCut:
    """bucket_refs_by_salience cut_frac parametrization (EVL-03)."""

    @pytest.mark.parametrize("frac", [0.2, 0.3, 0.5])
    def test_cut_frac_counts(self, frac):
        ref_times, oenv = _synth_refs_oenv()
        important, filler, cut = bucket_refs_by_salience(ref_times, oenv, cut_frac=frac)
        n_imp = int(np.count_nonzero(important))
        n_fill = int(np.count_nonzero(filler))
        assert n_imp + n_fill == 10
        assert n_imp == int(np.ceil(frac * 10))
        assert isinstance(cut, float)

    def test_default_matches_explicit_03(self):
        """Back-compat: no cut_frac == cut_frac=0.3 (pin path unchanged)."""
        ref_times, oenv = _synth_refs_oenv()
        default = bucket_refs_by_salience(ref_times, oenv)
        explicit = bucket_refs_by_salience(ref_times, oenv, cut_frac=0.3)
        np.testing.assert_array_equal(default[0], explicit[0])
        np.testing.assert_array_equal(default[1], explicit[1])
        assert default[2] == explicit[2]

    def test_pin_amended_per_option_b(self):
        """08-03 chose option-b: pin re-pinned, mean differs from pre-amendment value,
        D-01 amendment recorded in STATE.md."""
        pin = json.loads(PIN_PATH.read_text())
        mean_f = pin["aggregate"]["mean_F_important"]
        assert mean_f != 0.5355131656874282
        state = (REPO_ROOT / ".planning" / "STATE.md").read_text()
        assert "D-01" in state and "amend" in state.lower()

    def test_gate_constants(self):
        assert config.GATE_MARGIN == 0.01
        assert config.REPORT_CUTS == (0.2, 0.3, 0.5)
        assert config.GATE_MIN_WINS == 3
        assert config.GATE_TOTAL_SONGS == 5
        assert config.BOOTSTRAP_N == 10000
        assert config.MERGE_TOL_S == 0.05
