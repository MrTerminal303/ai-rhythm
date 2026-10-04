"""Model-side full-song salience eval + gate (EVL-03/EVL-04, D-01..D-04).

Credibility comes from code identity with the pin path (identical-code rule):
peak-pick routes through baseline.normalize_envelope + peak_pick_frames with the
frozen OPTION_B_PARAMS; bucket math reuses pin_baseline.bucket_refs_by_salience
verbatim; gate reads data/eval_pins.json at gate time — never per-run recompute
(D-04: onset pipeline built into this module by reference only).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import librosa
import mir_eval
import mir_eval.onset  # needed for mir_eval.onset.util.match_events
import numpy as np

from airhythm import config
from airhythm.baseline import normalize_envelope, peak_pick_frames
from airhythm.pin_baseline import OPTION_B_PARAMS, bucket_refs_by_salience

__all__ = ["stitch_envelope", "est_times_from_envelope", "eval_song_buckets", "run_salience_gate"]


def stitch_envelope(windows: Sequence[Tuple[int, np.ndarray]], n_total: int) -> np.ndarray:
    """Stitch sliding-window sigmoid outputs onto the full-song frame grid.

    windows: list of (start_frame, sigmoid_sig_400) from sliding-window inference
    (hop = config.HOP_FRAMES = 200). Overlap = element-wise MAX (research A3: smoke
    both on 1 eval song at gate time; default max). Uncovered tail = 0.0.
    Returns (n_total,) float array in [0,1].
    """
    out = np.zeros(n_total, dtype=float)
    for start, sig in windows:
        if start >= n_total:
            continue
        seg = np.asarray(sig, dtype=float)[: n_total - start]
        end = start + seg.size
        out[start:end] = np.maximum(out[start:end], seg)
    return np.clip(out, 0.0, 1.0)


def est_times_from_envelope(
    env: np.ndarray, *, sr: int = config.SAMPLE_RATE, hop: int = config.HOP_LENGTH
) -> Tuple[np.ndarray, float]:
    """Envelope -> est onset times, identical-code rule + cluster-merge.

    est_frames = peak_pick_frames(normalize_envelope(env), **OPTION_B_PARAMS)
    -> est_times = librosa.frames_to_time. Then cluster-merge: sort; greedily keep
    an est only if it is > config.MERGE_TOL_S from the last kept one.
    Returns (merged_times, dedup_ratio) where dedup_ratio = raw/merged (>=1.0).
    """
    frames = peak_pick_frames(normalize_envelope(env), **OPTION_B_PARAMS)
    times = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
    if times.size == 0:
        return times, 1.0
    kept = [times[0]]
    for t in times[1:]:
        if t - kept[-1] > config.MERGE_TOL_S:
            kept.append(t)
    merged = np.asarray(kept, dtype=float)
    return merged, float(len(times)) / float(len(merged))


def eval_song_buckets(
    ref_times: np.ndarray, oenv: np.ndarray, est_times: np.ndarray, *, cut_frac: float = 0.3
) -> dict:
    """SAME math as pin_one_song (identical-code rule), only est source swapped.

    bucket via bucket_refs_by_salience(..., cut_frac), ONE global
    mir_eval.onset.util.match_events(ref_times, est_times, window=0.05), partition
    matches by bucket, per-bucket R + shared global P, harmonic F per bucket.
    """
    important_mask, filler_mask, cut = bucket_refs_by_salience(
        ref_times, oenv, cut_frac=cut_frac
    )
    imp_idx = set(np.where(important_mask)[0])
    fill_idx = set(np.where(filler_mask)[0])

    # Global one-to-one matching (SBOEP v1) — one match, then partition by bucket
    matched = mir_eval.onset.util.match_events(ref_times, est_times, window=0.05)
    matched_est_indices = {e for _r, e in matched}

    TP_imp = sum(1 for r, _e in matched if r in imp_idx)
    TP_fill = sum(1 for r, _e in matched if r in fill_idx)
    FN_imp = len(imp_idx) - TP_imp
    FN_fill = len(fill_idx) - TP_fill
    FP = len(est_times) - len(matched_est_indices)

    R_imp = TP_imp / (TP_imp + FN_imp) if (TP_imp + FN_imp) > 0 else 0.0
    R_fill = TP_fill / (TP_fill + FN_fill) if (TP_fill + FN_fill) > 0 else 0.0

    TP_total = TP_imp + TP_fill
    P_global = TP_total / (TP_total + FP) if (TP_total + FP) > 0 else 0.0

    F_imp = 2 * P_global * R_imp / (P_global + R_imp) if (P_global + R_imp) > 0 else 0.0
    F_fill = 2 * P_global * R_fill / (P_global + R_fill) if (P_global + R_fill) > 0 else 0.0

    return {
        "n_ref": int(len(ref_times)),
        "n_est": int(len(est_times)),
        "n_important": len(imp_idx),
        "n_filler": len(fill_idx),
        "F_important": F_imp,
        "P_important": P_global,
        "R_important": R_imp,
        "F_filler": F_fill,
        "P_filler": P_global,
        "R_filler": R_fill,
        "cut_percentile": cut,
    }


def run_salience_gate(
    song_evals: Sequence[dict],
    *,
    pin_path: str = "data/eval_pins.json",
    margin: float = config.GATE_MARGIN,
    min_wins: int = config.GATE_MIN_WINS,
) -> dict:
    """D-01/D-02 gate on cut 0.3; D-02 evidence; D-01 report-only 0.2/0.5 + fragile flag.

    song_evals: one dict per eval song — {"song_id", "ref_times", "oenv", "est_times",
    "pred_positive_rate"}. Reads ONLY pin_path (D-04: no per-run baseline recompute).

    Gate (D-01+D-02) at cut 0.3 ONLY:
      base_F = pin per_song F_important (option-b values from re-pinned file)
      bar    = pin aggregate mean_F_important + margin
      pass   = (mean(model_F@0.3) > bar) AND (wins over base >= min_wins)
    Evidence every run: per-song deltas + bootstrap percentile CI
    (BOOTSTRAP_N resamples, numpy Generator seeded BOOTSTRAP_SEED, 2.5/97.5 pct).
    Sensitivity: pass/fail ALSO computed at 0.2 and 0.5 (report-only); pass@0.3 and
    fail BOTH 0.2 and 0.5 -> flag "fragile win — cut-dependent" (print only, does
    NOT change pass — D-01: no auto-block on the flag alone).
    D-03 fail contract: pass=False -> diagnostics printed (per-song deltas, P/R per
    bucket per cut, predicted positive rate) and returned; never raises on fail —
    caller prints/asserts/halts.
    """
    pin = json.loads(Path(pin_path).read_text())
    base_f = {sid: v["F_important"] for sid, v in pin["per_song"].items()}
    bar = float(pin["aggregate"]["mean_F_important"]) + margin

    # EVL-03: bucket eval at every report cut, one parametrized path
    per_cut: Dict[float, List[dict]] = {
        cut: [
            eval_song_buckets(s["ref_times"], s["oenv"], s["est_times"], cut_frac=cut)
            for s in song_evals
        ]
        for cut in config.REPORT_CUTS
    }

    def _cut_stats(cut: float) -> Tuple[float, int]:
        Fs = [b["F_important"] for b in per_cut[cut]]
        mean_F = float(np.mean(Fs)) if Fs else 0.0
        wins = sum(1 for s, f in zip(song_evals, Fs) if f > base_f[s["song_id"]])
        return mean_F, wins

    mean_F, wins = _cut_stats(0.3)
    pass_by_cut: Dict[float, bool] = {}
    for cut in config.REPORT_CUTS:
        m, w = _cut_stats(cut)
        pass_by_cut[cut] = bool(m > bar and w >= min_wins)
    pass_flag = pass_by_cut[0.3]

    # D-02 evidence: per-song deltas @0.3 + bootstrap percentile CI
    deltas = [
        b["F_important"] - base_f[s["song_id"]]
        for s, b in zip(song_evals, per_cut[0.3])
    ]
    rng = np.random.default_rng(config.BOOTSTRAP_SEED)  # numpy Generator, vectorizable
    draws = rng.choice(
        np.asarray(deltas), (config.BOOTSTRAP_N, len(deltas)), replace=True
    ).mean(axis=1)
    lo, hi = np.percentile(draws, [2.5, 97.5])
    ci = (float(lo), float(hi))

    print("per-song deltas (model - base) @cut 0.3:")
    for s, d in zip(song_evals, deltas):
        print(f"  {s['song_id']}: {d:+.4f}")
    print(f"bootstrap 95% CI (n={config.BOOTSTRAP_N}, seed={config.BOOTSTRAP_SEED}): ({ci[0]:+.4f}, {ci[1]:+.4f})")
    for cut in config.REPORT_CUTS:
        m, w = _cut_stats(cut)
        print(f"cut {cut}: mean_F_important={m:.4f} bar={bar:.4f} wins={w} pass={pass_by_cut[cut]}")

    # D-01 stability flag — print for human review, never blocks
    fragile = bool(pass_flag and not pass_by_cut[0.2] and not pass_by_cut[0.5])
    if fragile:
        print("fragile win — cut-dependent")

    per_song = {}
    for i, s in enumerate(song_evals):
        sid = s["song_id"]
        per_song[sid] = {
            "pred_positive_rate": s.get("pred_positive_rate"),
            "base_F_important": base_f[sid],
            "delta": deltas[i],
            "cuts": {cut: per_cut[cut][i] for cut in config.REPORT_CUTS},
        }

    if not pass_flag:
        # D-03: halt + diagnose is the caller's job; we never raise, never stay silent
        print("GATE FAIL")
        print(f"  bar={bar:.4f} mean_F_important@0.3={mean_F:.4f} wins={wins} (min {min_wins})")
        for cut in config.REPORT_CUTS:
            for s, b in zip(song_evals, per_cut[cut]):
                print(
                    f"  {s['song_id']} cut={cut}: "
                    f"P_imp={b['P_important']:.4f} R_imp={b['R_important']:.4f} "
                    f"P_fill={b['P_filler']:.4f} R_fill={b['R_filler']:.4f} "
                    f"ppr={s.get('pred_positive_rate')}"
                )

    return {
        "pass": pass_flag,
        "mean_F_important": mean_F,
        "bar": bar,
        "wins": wins,
        "ci_95": ci,
        "per_song": per_song,
        "fragile": fragile,
        "deltas": deltas,
        "pass_by_cut": pass_by_cut,
    }
