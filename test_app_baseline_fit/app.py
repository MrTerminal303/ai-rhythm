"""Baseline-fit test app: interactive peak-pick param exploration.

Works both locally and on Kaggle web (no kagglehub needed).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# Resolve project root: parent of this file's directory, or search on Kaggle
_APP_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _APP_DIR.parent
if not (_PROJECT_ROOT / "airhythm" / "__init__.py").exists():
    _kaggle_input = Path("/kaggle/input")
    if _kaggle_input.is_dir():
        for _d1 in _kaggle_input.iterdir():
            if not _d1.is_dir():
                continue
            if (_d1 / "airhythm" / "__init__.py").exists():
                _PROJECT_ROOT = _d1
                break
            for _d2 in _d1.iterdir():
                if not _d2.is_dir():
                    continue
                if (_d2 / "airhythm" / "__init__.py").exists():
                    _PROJECT_ROOT = _d2
                    break
                for _d3 in _d2.iterdir():
                    if _d3.is_dir() and (_d3 / "airhythm" / "__init__.py").exists():
                        _PROJECT_ROOT = _d3
                        break
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import librosa
import numpy as np
import streamlit as st
import plotly.graph_objects as go

from airhythm import config
from airhythm.pin_baseline import normalize_envelope, peak_pick_frames
from test_app_baseline_fit.core import (
    discover_songs,
    is_degenerate,
    load_song_audio_sr,
    reconstruct_ref_times,
    bucket_refs_by_salience,
    safe_f_measure,
)

st.set_page_config(page_title="Baseline Fit Test", layout="wide")
st.title("Baseline Fit Test")
st.caption(
    "Inspect how well the librosa onset baseline fits each song. "
    "Drag sliders to explore peak-pick params; the scorecard shows spread, not maximization."
)

DEFAULTS = config.PEAK_PICK_PARAMS


# —— Cached, bounded data loads (keyed by stable song path, not params) ——

@st.cache_data(show_spinner=False, max_entries=16)
def _cached_audio(song_path_str: str) -> np.ndarray:
    """Full audio decode keyed on song path only. Bounded.

    Audio is the big RAM object; keying by path (not params) keeps exactly one
    copy per song regardless of how many param combos the user tries.
    """
    audio, _sr = load_song_audio_sr(Path(song_path_str))
    return audio


@st.cache_data(show_spinner=False, max_entries=16)
def _cached_refs(song_path_str: str) -> np.ndarray:
    """Label-stitch + ref reconstruction keyed on song path."""
    return reconstruct_ref_times(Path(song_path_str))


@st.cache_data(show_spinner=False, max_entries=16)
def _cached_oenv(song_path_str: str) -> np.ndarray:
    """Onset_strength envelope (params-independent) keyed on song path."""
    audio = _cached_audio(song_path_str)
    return librosa.onset.onset_strength(
        y=audio, sr=config.SAMPLE_RATE, hop_length=config.HOP_LENGTH, fmax=config.FMAX
    )


@st.cache_data(show_spinner="Running detection on all songs...", max_entries=64)
def analyze_scores(songs_key: tuple, params_key: str) -> dict:
    """Per-song scalar F metrics only — no arrays held in cache.

    Result is small (floats/ints per song), cache bounded at 64 param combos.
    The only array-holding caches (_cached_audio/_cached_oenv/_cached_refs) are
    keyed by song path and capped at 16 entries, so RAM stays flat.
    """
    params = json.loads(params_key)
    out = {}
    for sid, path_str in songs_key:
        oenv = _cached_oenv(path_str)
        ref_times = _cached_refs(path_str)
        est_frames = peak_pick_frames(normalize_envelope(oenv), **params)
        est_times = librosa.frames_to_time(
            est_frames, sr=config.SAMPLE_RATE, hop_length=config.HOP_LENGTH
        )
        important, filler, _ = bucket_refs_by_salience(ref_times, oenv)
        fi = safe_f_measure(important, est_times)
        ff = safe_f_measure(filler, est_times)
        F_important = float(fi["f_measure"])
        n_est = int(len(est_times))
        out[sid] = {
            "F_important": F_important,
            "F_filler": float(ff["f_measure"]),
            "n_est": n_est,
            "n_ref": int(len(ref_times)),
            "degenerate": is_degenerate(F_important, n_est),
        }
    return out


# —— Sidebar ——
with st.sidebar:
    st.header("Peak-pick parameters")
    params = {
        "delta": st.slider("delta", 0.01, 0.5, float(DEFAULTS["delta"]), 0.01),
        "pre_max": st.slider("pre_max", 1, 20, int(DEFAULTS["pre_max"]), 1),
        "post_max": st.slider("post_max", 1, 20, int(DEFAULTS["post_max"]), 1),
        "pre_avg": st.slider("pre_avg", 1, 30, int(DEFAULTS["pre_avg"]), 1),
        "post_avg": st.slider("post_avg", 1, 30, int(DEFAULTS["post_avg"]), 1),
        "wait": st.slider("wait", 0, 20, int(DEFAULTS["wait"]), 1),
    }

    st.divider()
    if st.button("Download more songs", icon=":material/download:"):
        with st.status("Running download_minimal.py...", expanded=True):
            proc = subprocess.run(
                [sys.executable, str(_PROJECT_ROOT / "download_minimal.py")],
                capture_output=True, text=True, cwd=str(_PROJECT_ROOT),
            )
        st.code((proc.stdout or "")[-2000:] + "\n" + (proc.stderr or "")[-1000:])


# —— Discover songs (cheap) ——
_data_dir = str(_PROJECT_ROOT / "data" / "minimal_dataset")
songs = discover_songs(data_dir=_data_dir)
if not songs:
    st.warning("No songs found in data/minimal_dataset/. Use the sidebar to download more.")
    st.stop()

tags = {s["song_id"]: s["tag"] for s in songs}
songs_key = tuple((s["song_id"], str(s["path"])) for s in songs)
path_by_id = {sid: p for sid, p in songs_key}
params_key = json.dumps(params, sort_keys=True)

# Scalar results only — no numpy arrays enter this cache
scores = analyze_scores(songs_key, params_key)


# —— Scorecard (always renders) ——
fis = [r["F_important"] for r in scores.values()]
mean_fi = float(np.mean(fis))
mean_ff = float(np.mean([r["F_filler"] for r in scores.values()]))
spread = float(max(fis) - min(fis))
degenerate_ids = [sid for sid, r in scores.items() if r["degenerate"]]

c1, c2, c3, c4 = st.columns(4)
c1.metric("mean F_important", f"{mean_fi:.3f}")
c2.metric("mean F_filler", f"{mean_ff:.3f}")
c3.metric("F_important spread", f"{spread:.3f}",
          help="Max minus min across songs. Large spread = some songs degenerate.")
c4.metric("Degenerate songs", len(degenerate_ids),
          help="F_important < 0.01 OR n_est = 0")
if degenerate_ids:
    st.warning(f"Degenerate: {', '.join(degenerate_ids)}")


# —— Per-song bar chart (always renders) ——
def _label(sid: str) -> str:
    tag = tags[sid]
    return {"eval": sid, "search": f"{sid} ★", "other": f"{sid} ?"}[tag]


fig = go.Figure()
fig.add_bar(x=[_label(sid) for sid in scores], y=fis, name="F_important")
fig.add_bar(x=[_label(sid) for sid in scores],
            y=[r["F_filler"] for r in scores.values()], name="F_filler")
fig.update_layout(barmode="group", height=320,
                  title="Per-song F (★ = search, ? = other)",
                  xaxis_title="song",
                  yaxis_title="F-measure")
fig.update_xaxes(type="category", categoryorder="array",
                 categoryarray=[_label(sid) for sid in scores])
st.plotly_chart(fig, width="stretch")


# —— Song detail (fragment: reruns independently; loads one song's audio lazily) ——
@st.fragment
def song_detail():
    selected = st.selectbox("Song detail", list(scores), key="song_select")
    r = scores[selected]

    cdf1, cdf2 = st.columns(2)
    with cdf1:
        st.metric("F_important", f"{r['F_important']:.3f}")
        st.metric("n_est", r["n_est"])
    with cdf2:
        st.metric("F_filler", f"{r['F_filler']:.3f}")
        st.metric("n_ref", r["n_ref"])

    # Lazy-load this song's arrays (cached & bounded; audio lives only for this song)
    path_str = path_by_id[selected]
    audio = _cached_audio(path_str)
    oenv = _cached_oenv(path_str)
    ref_times = _cached_refs(path_str)

    est_frames = peak_pick_frames(normalize_envelope(oenv), **params)
    est_times = librosa.frames_to_time(
        est_frames, sr=config.SAMPLE_RATE, hop_length=config.HOP_LENGTH
    )
    important, filler, _ = bucket_refs_by_salience(ref_times, oenv)

    # Waveform + onset markers (waveform downsampled to bound render payload).
    # Onsets drawn as tall vertical stems so they stand out over the waveform,
    # each a distinct color + legend entry.
    fig2 = go.Figure()
    t = np.arange(len(audio)) / config.SAMPLE_RATE
    peak = float(np.abs(audio).max() or 1.0)
    max_pts = 200_000
    step = max(1, len(audio) // max_pts)
    fig2.add_trace(go.Scatter(
        x=t[::step], y=audio[::step], mode="lines",
        name="waveform", opacity=0.6,
        line=dict(color="#64748b", width=1),
    ))

    def _stems(xs, name, color):
        if not len(xs):
            return
        # Stacked x/y: NaN separators draw vertical stems at each onset time.
        x = np.empty(3 * len(xs))
        y = np.empty(3 * len(xs))
        x[0::3] = xs; x[1::3] = xs; x[2::3] = np.nan
        y[0::3] = -peak; y[1::3] = peak; y[2::3] = np.nan
        fig2.add_trace(go.Scatter(
            x=x, y=y, mode="lines", name=name,
            line=dict(color=color, width=2),
        ))

    _stems(important, "important ref", "#16a34a")
    _stems(filler, "filler ref", "#94a3b8")
    _stems(est_times, "detected", "#dc2626")

    fig2.update_layout(
        title=f"{selected}: waveform with onset refs and detections",
        height=360,
        xaxis_title="time (s)",
        yaxis_title="amplitude",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    )
    st.plotly_chart(fig2, width="stretch")

    # Onset envelope + threshold with detected-peak markers.
    norm = normalize_envelope(oenv)
    est_frames = np.round(est_times * config.SAMPLE_RATE / config.HOP_LENGTH).astype(int)
    est_frames = est_frames[(est_frames >= 0) & (est_frames < len(norm))]

    fig3 = go.Figure()
    fig3.add_trace(go.Scatter(x=np.arange(len(norm)), y=norm, mode="lines",
                             name="normalized onset_strength",
                             line=dict(color="#64748b", width=1)))
    if len(est_frames):
        fig3.add_trace(go.Scatter(
            x=est_frames, y=norm[est_frames], mode="markers",
            name="detected", marker=dict(color="#dc2626", size=6,
                                         symbol="triangle-up"),
        ))
    fig3.add_hline(y=params["delta"], line_color="red", line_dash="dot",
                   annotation_text=f"delta={params['delta']}")
    fig3.update_layout(
        title=f"{selected}: normalized envelope + peak-pick threshold",
        height=360,
        xaxis_title="frame index",
        yaxis_title="normalized onset strength",
    )
    st.plotly_chart(fig3, width="stretch")


song_detail()