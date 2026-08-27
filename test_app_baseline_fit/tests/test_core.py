"""Tests for test_app_baseline_fit.core."""
from __future__ import annotations

import numpy as np

from airhythm.pin_baseline import OPTION_B_PARAMS
from test_app_baseline_fit.core import (
    analyze_song,
    discover_songs,
    is_degenerate,
    load_song_tags,
)


def test_load_song_tags():
    tags = load_song_tags()
    assert tags["2255671"] == "eval"
    assert tags["2561773"] == "search"
    evals = [v for v in tags.values() if v == "eval"]
    searches = [v for v in tags.values() if v == "search"]
    assert len(evals) == 5
    assert len(searches) == 1


def test_discover_songs_empty(tmp_path):
    assert discover_songs(str(tmp_path)) == []


def test_analyze_song_finite():
    songs = discover_songs()
    assert songs, "expected songs in data/minimal_dataset/"
    res = analyze_song(songs[0]["path"], OPTION_B_PARAMS)
    assert np.isfinite(res["F_important"])
    assert np.isfinite(res["F_filler"])
    assert res["n_est"] > 0
    assert res["degenerate"] is False


def test_is_degenerate():
    assert is_degenerate(0.0, 0) is True       # zero onsets
    assert is_degenerate(0.005, 100) is True   # below F threshold
    assert is_degenerate(0.3, 100) is False    # healthy
    assert is_degenerate(0.3, 0) is True       # no detections despite F