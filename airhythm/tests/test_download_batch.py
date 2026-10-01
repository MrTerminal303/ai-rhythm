"""Tests for airhythm/download_batch.py and the corrupt-audio decode guard.

Regression focus: the Kaggle crash where soundfile's LibsndfileError escaped
preprocess_osz and killed a whole batch run.
"""

from __future__ import annotations

import io
import os
import zipfile
from unittest.mock import patch

import pytest

from airhythm.audio_preproc import load_audio_from_osz, preprocess_osz
from airhythm.download_batch import _prune_incomplete, main


def _make_osz(audio_bytes: bytes) -> bytes:
    """Minimal .osz: one mania .osu + given (possibly corrupt) audio."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        mania = (
            "[General]\n"
            "Mode: 3\n"
            "AudioFilename: audio.mp3\n"
            "[Difficulty]\n"
            "OverallDifficulty:4\n"
            "[Metadata]\n"
            "Title: T\n"
            "Artist: A\n"
            "BeatmapSetID: 7\n"
            "Version: 4K\n"
            "[HitObjects]\n"
            "256,192,5000,1,0,0:0:0:0:\n"
        )
        zf.writestr("song/4K.osu", mania)
        zf.writestr("audio.mp3", audio_bytes)
    return buf.getvalue()


GARBAGE = b"this is not audio" * 200


class TestCorruptAudio:
    """Corrupt audio must surface as ValueError, never escape as a crash."""

    def test_load_raises_valueerror_not_libsndfile(self):
        with pytest.raises(ValueError):
            load_audio_from_osz(_make_osz(GARBAGE), "audio.mp3")

    def test_preprocess_returns_empty_not_crash(self, tmp_path):
        """Regression: LibsndfileError used to kill the whole batch run."""
        song_dir = tmp_path / "7"
        song_dir.mkdir()
        files = preprocess_osz(_make_osz(GARBAGE), 7, str(song_dir))
        assert files == []
        assert not any(song_dir.iterdir())  # no partial output left behind


class TestPruneIncomplete:
    """Complete = metadata .json exists; partial dirs get deleted."""

    def test_prune_keeps_complete_deletes_partial(self, tmp_path):
        (tmp_path / "111").mkdir()  # partial: crashed before json write
        (tmp_path / "222").mkdir()
        (tmp_path / "222" / "0000.json").write_text("{}")  # complete
        (tmp_path / "notadigit").mkdir()  # unrelated — untouched

        ids = _prune_incomplete(str(tmp_path))

        assert ids == {222}
        assert not (tmp_path / "111").exists()
        assert (tmp_path / "222").exists()
        assert (tmp_path / "notadigit").exists()

    def test_missing_dir_returns_empty(self, tmp_path):
        assert _prune_incomplete(str(tmp_path / "nope")) == set()


class TestMainBatch:
    """Batch loop: skips complete, survives per-song failure, cleans partials."""

    def test_skips_complete_survives_failure_cleans_partial(self, tmp_path):
        output = tmp_path / "ds"
        output.mkdir()
        (output / "10").mkdir()
        (output / "10" / "0000.json").write_text("{}")  # already complete

        candidates = [
            {"beatmapset_id": 10, "title": "done", "artist": "a", "bpm": 1.0, "cs": 4},
            {"beatmapset_id": 20, "title": "bad", "artist": "a", "bpm": 1.0, "cs": 4},
            {"beatmapset_id": 30, "title": "good", "artist": "a", "bpm": 1.0, "cs": 4},
        ]

        def fake_preprocess(osz, bid, outdir):
            if bid == 20:
                # The exact crash class from the pasted traceback
                raise RuntimeError("LibsndfileError: Unspecified internal error.")
            with open(os.path.join(outdir, "0000.json"), "w") as f:
                f.write("{}")
            return [{"file_type": "metadata"}]

        def fake_download(src, bid, *args, **kwargs):
            return b"osz-bytes"

        with (
            patch("airhythm.scraper.search_all_sources", return_value=candidates),
            patch("airhythm.scraper.download_osz", side_effect=fake_download),
            patch(
                "airhythm.audio_preproc.preprocess_osz", side_effect=fake_preprocess
            ),
            patch("airhythm.download_batch.time.sleep"),
        ):
            saved = main(output=str(output), n_songs=10)

        assert saved == 1  # only bid 30 saved; 10 skipped, 20 failed
        assert (output / "10" / "0000.json").exists()  # complete kept
        assert not (output / "20").exists()  # failure cleaned for retry
        assert (output / "30" / "0000.json").exists()  # success recorded

    def test_total_target_reached_skips_download(self, tmp_path):
        """n_songs = TOTAL target: already-complete counts, no new downloads."""
        output = tmp_path / "ds"
        (output / "11").mkdir(parents=True)
        (output / "11" / "0000.json").write_text("{}")
        candidates = [
            {"beatmapset_id": 99, "title": "t", "artist": "a", "bpm": 1.0, "cs": 4}
        ]

        with (
            patch(
                "airhythm.scraper.search_all_sources", return_value=candidates
            ),
            patch("airhythm.scraper.download_osz") as mock_dl,
        ):
            saved = main(output=str(output), n_songs=1)

        assert saved == 0
        mock_dl.assert_not_called()
