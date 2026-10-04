"""Gate-math fixture tests for salience_eval (EVL-03/EVL-04, D-01..D-04)."""

from __future__ import annotations

import json
from pathlib import Path

import librosa
import numpy as np
import pytest

from airhythm import config
from airhythm.pin_baseline import OPTION_B_PARAMS, bucket_refs_by_salience

REPO_ROOT = Path(__file__).resolve().parents[2]
PIN_PATH = REPO_ROOT / "data" / "eval_pins.json"

SONG_IDS = ["s1", "s2", "s3", "s4", "s5"]


# ---------------------------------------------------------------- fixtures


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


def _refs_oenv() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """10 refs @1s; strong oenv peaks at refs 0,3 (top-2 salience), medium at ref 1.

    Salience ranking -> important@0.2 = {0,3}, @0.3 = {0,3,1}, @0.5 = +2 background.
    """
    ref_times = np.arange(10) + 1.0
    frames = np.round(ref_times * config.SAMPLE_RATE / config.HOP_LENGTH).astype(int)
    oenv = np.full(frames[-1] + 8, 0.1)
    for i in (0, 3):
        oenv[frames[i] : frames[i] + 5] = 1.0
    oenv[frames[1] : frames[1] + 5] = 0.55
    return ref_times, oenv, frames


def _est(kind: str) -> np.ndarray:
    """Est sets with analytically known F_important at cut 0.3 (imp = {0,3,1})."""
    ref, _, _ = _refs_oenv()
    spurious = np.arange(36) + 0.5  # 0.5s off any ref -> never matches
    if kind == "f10":   # P=1, R=1    -> F=1.0
        return ref.copy()
    if kind == "f8":    # drop ref0: P=1, R=2/3 -> F=0.8
        return ref[1:].copy()
    if kind == "f5":    # matched={ref0}: P=1, R=1/3 -> F=0.5
        return np.array([ref[0]])
    if kind == "f4":    # P=1/2, R=1/3 -> F=0.4
        return np.array([ref[0], 0.5])
    if kind == "f25":   # P=1/5, R=1/3 -> F=0.25
        return np.concatenate([[ref[0]], spurious[:4]])
    if kind == "f05":   # P=1/37, R=1/3 -> F=0.05
        return np.concatenate([[ref[0]], spurious])
    if kind == "flag":  # P=1/2; R@.2=1/2, R@.3=2/3, R@.5=2/5 -> F 0.5 / 0.5714 / 0.4444
        return np.array([1.0, 2.0, 2.5, 3.5])
    raise AssertionError(kind)


def _song(i: int, kind: str) -> dict:
    ref, oenv, _ = _refs_oenv()
    return {
        "song_id": SONG_IDS[i],
        "ref_times": ref,
        "oenv": oenv,
        "est_times": _est(kind),
        "pred_positive_rate": 0.02,
    }


def _write_pin(tmp_path: Path, mean: float, base_f: list[float]) -> str:
    pin = {
        "aggregate": {"mean_F_important": mean},
        "per_song": {s: {"F_important": f} for s, f in zip(SONG_IDS, base_f)},
        "eval_song_ids": SONG_IDS,
    }
    p = tmp_path / "pins.json"
    p.write_text(json.dumps(pin))
    return str(p)


# ---------------------------------------------------------------- Task 1


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


# ---------------------------------------------------------------- Task 2


class TestEstTimes:
    """est_times_from_envelope: identical-code peak-pick + cluster-merge (0.05s)."""

    @staticmethod
    def _spikes(*frames: int, n: int = 1000) -> np.ndarray:
        env = np.zeros(n)
        for f in frames:
            env[f] = 1.0
        return env

    def test_merge_close_peaks(self):
        """Raw picks 2 peaks 4 frames (~0.04s) apart; merge -> 1, dedup_ratio 2.0."""
        from airhythm.salience_eval import est_times_from_envelope

        env = self._spikes(100, 104)
        times, dedup = est_times_from_envelope(env)
        assert len(times) == 1
        assert dedup == pytest.approx(2.0)

    def test_peaks_0p3s_kept(self):
        """Plan (a) first clause: two peaks 0.3s apart (> MERGE_TOL_S) -> both kept."""
        from airhythm.salience_eval import est_times_from_envelope

        env = self._spikes(100, 130)  # 30 frames ~ 0.3s
        times, dedup = est_times_from_envelope(env)
        assert len(times) == 2
        assert dedup == pytest.approx(1.0)

    def test_peaks_1s_kept(self):
        from airhythm.salience_eval import est_times_from_envelope

        times, dedup = est_times_from_envelope(self._spikes(100, 200))
        assert len(times) == 2
        assert dedup == pytest.approx(1.0)

    def test_matches_direct_pipeline(self):
        """Un-mergeable case equals the direct baseline pipeline (identical-code rule)."""
        from airhythm.baseline import normalize_envelope, peak_pick_frames
        from airhythm.salience_eval import est_times_from_envelope

        env = self._spikes(100, 200, 400)
        direct_frames = peak_pick_frames(normalize_envelope(env), **OPTION_B_PARAMS)
        direct = librosa.frames_to_time(
            direct_frames, sr=config.SAMPLE_RATE, hop_length=config.HOP_LENGTH
        )
        times, _ = est_times_from_envelope(env)
        np.testing.assert_allclose(times, direct)


class TestStitch:
    def test_overlap_max_and_tail_zero(self):
        from airhythm.salience_eval import stitch_envelope

        w = [(0, np.full(400, 0.5)), (200, np.full(400, 0.9))]
        out = stitch_envelope(w, n_total=500)
        assert out.shape == (500,)
        assert np.all(out[:200] == 0.5)
        assert np.all(out[200:400] == 0.9)  # overlap = element-wise max
        assert np.all(out[400:] == 0.0)      # uncovered tail


class TestGateMath:
    """run_salience_gate: D-01 bar strictness, D-02 wins rule, D-02 bootstrap CI."""

    # model F@0.3 per song: [1.0, 0.8, 0.5, 0.4, 0.05] -> mean 0.55
    MODEL_A = ["f10", "f8", "f5", "f4", "f05"]

    @pytest.fixture
    def song_a(self):
        return [_song(i, k) for i, k in enumerate(self.MODEL_A)]

    def test_pass_case(self, tmp_path, song_a, capsys):
        pin = _write_pin(tmp_path, 0.50, [0.4, 0.4, 0.45, 0.35, 0.6])
        from airhythm.salience_eval import run_salience_gate

        res = run_salience_gate(song_a, pin_path=pin)
        assert res["pass"] is True
        assert res["wins"] == 4
        assert res["bar"] == pytest.approx(0.51)
        assert res["mean_F_important"] == pytest.approx(0.55)
        lo, hi = res["ci_95"]
        assert lo < hi
        out = capsys.readouterr().out
        assert "per-song delta" in out  # D-02 evidence printed every run

    def test_teeth_margin_only_fail(self, tmp_path, song_a):
        """mean 0.55 > bar but wins 2/5 -> FAIL (D-02 has teeth)."""
        pin = _write_pin(tmp_path, 0.50, [0.5, 0.5, 0.9, 0.9, 0.9])
        from airhythm.salience_eval import run_salience_gate

        res = run_salience_gate(song_a, pin_path=pin)
        assert res["mean_F_important"] == pytest.approx(0.55)
        assert res["wins"] == 2
        assert res["pass"] is False

    def test_teeth_wins_only_fail(self, tmp_path):
        """wins 4/5 but mean 0.50 < bar -> FAIL (margin has teeth)."""
        songs = [_song(i, "f5") for i in range(5)]  # F=0.5 each -> mean 0.50
        pin = _write_pin(tmp_path, 0.50, [0.49, 0.49, 0.49, 0.49, 0.9])
        from airhythm.salience_eval import run_salience_gate

        res = run_salience_gate(songs, pin_path=pin)
        assert res["wins"] == 4
        assert res["mean_F_important"] == pytest.approx(0.50)
        assert res["pass"] is False

    def test_boundary_mean_equals_bar_fails(self, tmp_path):
        """mean == bar -> strict > fails."""
        kinds = ["f10", "f5", "f5", "f5", "f25"]  # mean = (1+.5+.5+.5+.25)/5 = 0.51
        songs = [_song(i, k) for i, k in enumerate(kinds)]
        pin = _write_pin(tmp_path, 0.50, [0.4, 0.4, 0.4, 0.4, 0.9])
        from airhythm.salience_eval import run_salience_gate

        res = run_salience_gate(songs, pin_path=pin)
        assert res["mean_F_important"] == pytest.approx(0.51)
        assert res["bar"] == pytest.approx(0.51)
        assert res["wins"] == 4
        assert res["pass"] is False  # strict >

    def test_bootstrap_ci_percentiles(self, tmp_path, song_a):
        pin = _write_pin(tmp_path, 0.50, [0.4, 0.4, 0.45, 0.35, 0.6])
        from airhythm.salience_eval import run_salience_gate

        res = run_salience_gate(song_a, pin_path=pin)
        deltas = np.asarray(res["deltas"])
        assert deltas == pytest.approx([0.6, 0.4, 0.05, 0.05, -0.55])
        rng = np.random.default_rng(config.BOOTSTRAP_SEED)
        draws = rng.choice(deltas, (config.BOOTSTRAP_N, len(deltas)), replace=True).mean(axis=1)
        exp_lo, exp_hi = np.percentile(draws, [2.5, 97.5])
        lo, hi = res["ci_95"]
        assert lo == pytest.approx(exp_lo)
        assert hi == pytest.approx(exp_hi)
        assert lo < hi

    def test_no_baseline_recompute(self, tmp_path, song_a):
        """D-04: gate reads pin file only; never run_librosa_onset_detection."""
        import airhythm.salience_eval as se

        pin = _write_pin(tmp_path, 0.50, [0.4, 0.4, 0.45, 0.35, 0.6])
        se.run_salience_gate(song_a, pin_path=pin)
        assert not hasattr(se, "run_librosa_onset_detection")
        src = Path(se.__file__).read_text()
        assert "run_librosa_onset_detection" not in src

    def test_fail_diagnostics_contract(self, tmp_path, capsys):
        """D-03: fail -> diagnostics dict, pass False, never raises."""
        songs = [_song(i, "f5") for i in range(5)]
        pin = _write_pin(tmp_path, 0.90, [0.95] * 5)  # impossible bar
        from airhythm.salience_eval import run_salience_gate

        res = run_salience_gate(songs, pin_path=pin)
        assert res["pass"] is False
        assert len(res["per_song"]) == 5
        for sid in SONG_IDS:
            entry = res["per_song"][sid]
            assert "pred_positive_rate" in entry
            assert entry["pred_positive_rate"] == 0.02
            for cut in config.REPORT_CUTS:
                b = entry["cuts"][str(cut)] if str(cut) in entry["cuts"] else entry["cuts"][cut]
                for k in ("P_important", "R_important", "P_filler", "R_filler"):
                    assert k in b, f"{sid}@{cut} missing {k}"
        assert "GATE FAIL" in capsys.readouterr().out


class TestGateFlag:
    """D-01 stability flag: pass@0.3 + fail BOTH 0.2/0.5 -> fragile, non-blocking."""

    @staticmethod
    def _flag_songs(kind: str = "flag"):
        return [_song(i, kind) for i in range(5)]

    def test_fragile_flag_printed_not_blocking(self, tmp_path, capsys):
        pin = _write_pin(tmp_path, 0.50, [0.45] * 5)
        from airhythm.salience_eval import run_salience_gate

        res = run_salience_gate(self._flag_songs(), pin_path=pin)
        assert res["pass"] is True           # flag does NOT block (D-01)
        assert res["fragile"] is True
        out = capsys.readouterr().out
        assert "fragile win — cut-dependent" in out

    def test_not_fragile_when_all_cuts_pass(self, tmp_path, capsys):
        pin = _write_pin(tmp_path, 0.50, [0.45] * 5)
        from airhythm.salience_eval import run_salience_gate

        res = run_salience_gate(self._flag_songs(kind="f10"), pin_path=pin)
        assert res["pass"] is True
        assert res["fragile"] is False
        assert "fragile win — cut-dependent" not in capsys.readouterr().out
