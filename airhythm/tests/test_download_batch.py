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


class TestCs4Contract:
    """Review #2: preprocess_osz must never process a non-4K difficulty,
    even when the archive lists 5K first (zip order is arbitrary)."""

    @staticmethod
    def _make_osz_two_diffs() -> bytes:
        def osu(version: str, cs: int) -> str:
            return (
                "[General]\n"
                "Mode: 3\n"
                "AudioFilename: audio.mp3\n"
                "[Difficulty]\n"
                f"CircleSize: {cs}\n"
                "OverallDifficulty:4\n"
                "[Metadata]\n"
                "Title: T\n"
                "Artist: A\n"
                "BeatmapSetID: 7\n"
                f"Version: {version}\n"
                "[HitObjects]\n"
                "256,192,5000,1,0,0:0:0:0:\n"
            )

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("song/5K.osu", osu("5K", 5))  # listed FIRST on purpose
            zf.writestr("song/4K.osu", osu("4K", 4))
            zf.writestr("audio.mp3", b"x")
        return buf.getvalue()

    def test_skips_5k_processes_4k(self, tmp_path, monkeypatch):
        import json

        import numpy as np

        song_dir = tmp_path / "7"
        song_dir.mkdir()
        monkeypatch.setattr(
            "airhythm.audio_preproc.load_audio_from_osz",
            lambda *a, **k: (np.zeros(16000, dtype=np.float32), 16000),
        )
        monkeypatch.setattr(
            "airhythm.audio_preproc.audio_to_mel_spec",
            lambda *a, **k: np.zeros((1, 128, 900), dtype=np.float32),
        )

        files = preprocess_osz(self._make_osz_two_diffs(), 7, str(song_dir))

        metas = [f for f in files if f["file_type"] == "metadata"]
        assert len(metas) == 1
        assert metas[0]["difficulty_name"] == "4K"
        meta_json = next(song_dir.glob("*.json"))
        data = json.loads(meta_json.read_text())
        assert data["difficulty_name"] == "4K"
        assert data["cs"] == 4
        assert data["num_chunks"] >= 1


class TestTailLabels:
    """review #4 P2: tail chunk is edge-padded — a beatmap note beyond the
    real spectrogram must never become a target on synthetic frames."""

    @staticmethod
    def _make_osz_notes(*times_ms: int) -> bytes:
        mania = (
            "[General]\n"
            "Mode: 3\n"
            "AudioFilename: audio.mp3\n"
            "[Difficulty]\n"
            "CircleSize: 4\n"
            "OverallDifficulty:4\n"
            "[Metadata]\n"
            "Title: T\n"
            "Artist: A\n"
            "BeatmapSetID: 7\n"
            "Version: 4K\n"
            "[HitObjects]\n"
            + "".join(f"256,192,{t},1,0,0:0:0:0:\n" for t in times_ms)
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("song/4K.osu", mania)
            zf.writestr("audio.mp3", b"x")
        return buf.getvalue()

    def test_note_in_pad_zeroed_note_in_real_kept(self, tmp_path, monkeypatch):
        import numpy as np

        from airhythm import config

        song_dir = tmp_path / "7"
        song_dir.mkdir()
        # spec T=500 -> chunk 0 = frames [0,400), tail chunk 1 = [400,800)
        # with only [400,500) real; pad = [500,800)
        monkeypatch.setattr(
            "airhythm.audio_preproc.load_audio_from_osz",
            lambda *a, **k: (np.zeros(16000, dtype=np.float32), 16000),
        )
        monkeypatch.setattr(
            "airhythm.audio_preproc.audio_to_mel_spec",
            lambda *a, **k: np.zeros((1, 128, 500), dtype=np.float32),
        )

        f_keep, f_drop = config.ms_to_frame(4500), config.ms_to_frame(5500)
        assert 400 <= f_keep < 500 <= f_drop  # preconditions of the scenario

        files = preprocess_osz(self._make_osz_notes(4500, 5500), 7, str(song_dir))
        assert files  # wrote both chunks

        labels = np.load(song_dir / "0001_labels.npy")
        assert labels[1, f_keep - 400] == 1  # real audio frames keep targets
        assert labels[1, f_drop - 400] == 0  # synthetic pad never a target
