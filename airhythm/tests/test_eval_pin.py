"""Tests for pin_baseline.py and eval_pins.json artifact."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from airhythm.pin_baseline import OPTION_B_PARAMS, pin_baseline, safe_f_measure


class TestPinBaseline:
    """Smoke and correctness tests for the pin_baseline CLI and output."""

    def test_pin_baseline_smoke(self, tmp_path):
        """Run pin_baseline.py on local 6-song set; output file exists, required keys present."""
        out_file = tmp_path / "eval_pins.json"
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "airhythm.pin_baseline",
                "--songs",
                "data/minimal_dataset",
                "--eval-ids",
                "metadata/eval_song_ids.json",
                "--out",
                str(out_file),
                "--no-re-capture-goldens",
            ],
            capture_output=True,
            text=True,
            cwd="/home/Code/AIRhythm",
            env={**os.environ, "PYTHONPATH": "."},
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert out_file.exists(), "pin JSON not created"

        pin = json.loads(out_file.read_text())
        required_keys = [
            "derivation_option",
            "params",
            "eval_song_ids",
            "search_set_ids",
            "normalize",
            "fp_protocol",
            "bucket_definition",
            "pinned_at",
            "decision_ref",
            "per_song",
            "aggregate",
        ]
        for k in required_keys:
            assert k in pin, f"missing key: {k}"
        assert len(pin["eval_song_ids"]) == 5
        assert len(pin["search_set_ids"]) == 1

    def test_pin_baseline_no_nan(self):
        """All F values in committed pin are finite; both buckets present per song."""
        pin = json.load(open("data/eval_pins.json"))
        for song_id, vals in pin["per_song"].items():
            for k in [
                "F_important",
                "P_important",
                "R_important",
                "F_filler",
                "P_filler",
                "R_filler",
                "n_ref",
                "n_est",
                "n_important",
                "n_filler",
                "cut_percentile",
            ]:
                v = vals[k]
                assert np.isfinite(v), f"{song_id}.{k} is NaN/inf: {v}"
            assert "n_important" in vals
            assert "n_filler" in vals

    def test_pin_baseline_handles_short_songs(self):
        """safe_f_measure returns F=0.0 with n=0 for empty ref/est."""
        ref = np.array([], dtype=np.float64)
        est = np.array([1.0, 2.0])
        res = safe_f_measure(ref, est)
        assert res["f_measure"] == 0.0
        assert res["precision"] == 0.0
        assert res["recall"] == 0.0

        res = safe_f_measure(est, ref)
        assert res["f_measure"] == 0.0

    def test_pin_baseline_decision_recorded(self):
        """pin JSON contains derivation_option and decision_ref fields."""
        pin = json.load(open("data/eval_pins.json"))
        assert pin["derivation_option"] == "b"
        assert "decision_ref" in pin
        assert "D-10" in pin["decision_ref"]
        assert "D-16" in pin["decision_ref"]

    def test_pin_baseline_derivation_is_option_b(self):
        """Derivation option is deterministically 'b' and params match OPTION_B_PARAMS."""
        pin = json.load(open("data/eval_pins.json"))
        assert pin["params"] == OPTION_B_PARAMS
        assert pin["params"] == pin["params"]

    def test_golden_post_n_est_in_band(self):
        """Every golden_post_*.npz fixture has n_est in {100..4000}."""
        fixtures = Path(__file__).parent / "fixtures"
        for p in sorted(fixtures.glob("golden_post_*.npz")):
            data = np.load(p)
            n_est = len(data["onset_times"])
            assert 100 <= n_est <= 4000, f"{p.name}: n_est={n_est} outside band"