"""Unit tests for airhythm/osu_parser.py.

Covers lane calculation, hit object parsing, full .osu parsing,
non-mania skip, timing point skip, missing/default sections,
and .osz archive handling.
"""

from __future__ import annotations

import io
import zipfile

import pytest

from airhythm import config
from airhythm.osu_parser import (
    BeatmapMetadata,
    HitObject,
    find_audio_file,
    lane_from_x,
    parse_hit_object_line,
    parse_osu,
    parse_osz,
)


class TestLaneCalculation:
    """Verify lane_from_x formula and clamping per D-09."""

    def test_lane_calculation(self):
        assert lane_from_x(0, 4) == 0
        assert lane_from_x(128, 4) == 1  # int(128/512*4) = 1
        assert lane_from_x(256, 4) == 2
        assert lane_from_x(384, 4) == 3
        assert lane_from_x(511, 4) == 3
        # Clamping: 512/512*4 = 4, clamped to [0, 3]
        assert lane_from_x(512, 4) == 3


class TestParseHitObject:
    """Verify hit object field extraction for circles, LNs, sliders."""

    def test_parse_hit_object_circle(self):
        line = "256,192,5000,1,0,0:0:0:0:"
        ho = parse_hit_object_line(line, 4)
        assert ho is not None
        assert ho.time == 5000.0
        assert ho.type_bitmask == 1
        assert ho.end_time == 5000.0  # same as time for circles

    def test_parse_hit_object_long_note(self):
        line = "256,192,10000,8,0,15000:0:0:0:0:"
        ho = parse_hit_object_line(line, 4)
        assert ho is not None
        assert ho.time == 10000.0
        assert ho.type_bitmask == 8
        assert ho.end_time == 15000.0

    def test_parse_hit_object_slider(self):
        """Slider with curve data in ext field —
        non-numeric ext falls back to end_time = time."""
        line = "128,192,8000,2,0,B|256:192|384:192,1,100,0|0,0:0|0:0,0:0:0:0:"
        ho = parse_hit_object_line(line, 4)
        assert ho is not None
        assert ho.time == 8000.0
        assert ho.type_bitmask == 2
        assert ho.lane == 1  # int(128/512*4)
        assert ho.end_time == 8000.0  # falls back to time

    def test_parse_malformed_line_returns_none(self):
        assert parse_hit_object_line("", 4) is None
        assert parse_hit_object_line("   ", 4) is None
        # Too few fields
        assert parse_hit_object_line("256,192", 4) is None


class TestParseOsu:
    """Verify full .osu section parsing."""

    MANIA_MINIMAL = (
        "[General]\n"
        "Mode: 3\n"
        "[Difficulty]\n"
        "OverallDifficulty:4\n"
        "[Metadata]\n"
        "Title: Test Song\n"
        "Artist: Test Artist\n"
        "BeatmapSetID: 999\n"
        "Version: 4K HD\n"
        "[HitObjects]\n"
        "256,192,5000,1,0,0:0:0:0:\n"
        "256,192,10000,8,0,15000:0:0:0:0:\n"
        "128,192,15000,2,0,B|256:192|384:192,1,100,0|0,0:0|0:0,0:0:0:0:\n"
    )

    def test_parse_osu_mania_difficulty(self):
        result = parse_osu(self.MANIA_MINIMAL)
        assert result is not None
        metadata, hit_objects = result

        assert metadata.mode == 3
        assert metadata.cs == 4
        assert metadata.title == "Test Song"
        assert metadata.artist == "Test Artist"
        assert metadata.beatmapset_id == 999
        assert metadata.difficulty_name == "4K HD"
        assert metadata.bpm == 0.0

        assert len(hit_objects) == 3
        # First object: circle
        assert hit_objects[0].type_bitmask == 1
        assert hit_objects[0].time == 5000.0
        # Second object: LN
        assert hit_objects[1].type_bitmask == 8
        assert hit_objects[1].end_time == 15000.0
        # Third object: slider
        assert hit_objects[2].type_bitmask == 2

    def test_parse_osu_skips_non_mania(self):
        content = "[General]\nMode: 0\n"
        assert parse_osu(content) is None

    def test_parse_osu_skips_std(self):
        """Mode: 0 (standard) should be skipped."""
        content = "[General]\nMode: 0\n[Difficulty]\nOverallDifficulty:5\n"
        assert parse_osu(content) is None

    def test_parse_osu_skips_taiko(self):
        """Mode: 1 (taiko) should be skipped."""
        content = "[General]\nMode: 1\n"
        assert parse_osu(content) is None

    def test_parse_osu_skips_ctb(self):
        """Mode: 2 (catch the beat) should be skipped."""
        content = "[General]\nMode: 2\n"
        assert parse_osu(content) is None


class TestTimingPoints:
    """Verify timing points are entirely skipped per D-08."""

    def test_timing_points_entirely_skipped(self):
        content = (
            "[General]\n"
            "Mode: 3\n"
            "[Difficulty]\n"
            "OverallDifficulty:4\n"
            "[TimingPoints]\n"
            "500,300.0,4,0,0,100,1,0\n"  # red (uninherited)
            "1000,-100.0,4,0,0,100,0,0\n"  # green (inherited)
            "[HitObjects]\n"
            "256,192,5000,1,0,0:0:0:0:\n"
        )
        result = parse_osu(content)
        assert result is not None
        metadata, _ = result
        # bpm must be 0.0 — no timing point parsing
        assert metadata.bpm == 0.0


class TestDefaultsAndEdgeCases:
    """Verify handling of missing sections, empty data, invalid input."""

    def test_parse_osu_missing_difficulty_uses_default(self):
        content = (
            "[General]\n"
            "Mode: 3\n"
            "[Metadata]\n"
            "Title: NoDiff\n"
            "[HitObjects]\n"
            "256,192,5000,1,0,0:0:0:0:\n"
        )
        result = parse_osu(content)
        assert result is not None
        metadata, hit_objects = result
        assert metadata.cs == config.CS_DEFAULT  # 4 from config
        assert len(hit_objects) == 1

    def test_parse_osu_empty_hit_objects(self):
        content = (
            "[General]\n"
            "Mode: 3\n"
            "[Difficulty]\n"
            "OverallDifficulty:4\n"
            "[HitObjects]\n"
        )
        result = parse_osu(content)
        assert result is not None
        _, hit_objects = result
        assert len(hit_objects) == 0

    def test_parse_osu_no_general_section(self):
        """If no [General] section, mode can't be determined —
        non-mania maps default to -1 and get skipped."""
        content = "[Difficulty]\nOverallDifficulty:4\n"
        result = parse_osu(content)
        assert result is None

    def test_parse_osu_missing_metadata_fields_default_to_empty(self):
        content = (
            "[General]\n"
            "Mode: 3\n"
            "[Difficulty]\n"
            "OverallDifficulty:4\n"
            "[HitObjects]\n"
            "256,192,5000,1,0,0:0:0:0:\n"
        )
        result = parse_osu(content)
        assert result is not None
        metadata, _ = result
        assert metadata.title == ""
        assert metadata.artist == ""
        assert metadata.beatmapset_id == 0
        assert metadata.difficulty_name == ""

    def test_parse_osu_invalid_beatmapset_id_defaults_zero(self):
        content = (
            "[General]\n"
            "Mode: 3\n"
            "[Metadata]\n"
            "BeatmapSetID: not-a-number\n"
            "[Difficulty]\n"
            "OverallDifficulty:4\n"
            "[HitObjects]\n"
            "256,192,5000,1,0,0:0:0:0:\n"
        )
        result = parse_osu(content)
        assert result is not None
        metadata, _ = result
        assert metadata.beatmapset_id == 0


class TestParseOsz:
    """Verify .osz archive parsing."""

    def _make_osz(self, files: dict[str, str]) -> bytes:
        """Create a .osz (zip) in memory."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, content in files.items():
                zf.writestr(name, content)
        return buf.getvalue()

    def test_parse_osz_invalid_zip(self):
        result = parse_osz(b"not a zip file")
        assert result == []

    def test_parse_osz_empty_bytes(self):
        result = parse_osz(b"")
        assert result == []

    def test_parse_osz_with_mania_and_non_mania(self):
        mania_content = (
            "[General]\n"
            "Mode: 3\n"
            "[Difficulty]\n"
            "OverallDifficulty:4\n"
            "[HitObjects]\n"
            "256,192,5000,1,0,0:0:0:0:\n"
        )
        non_mania_content = "[General]\nMode: 0\n[HitObjects]\n"

        osz_bytes = self._make_osz(
            {
                "song/4K HD.osu": mania_content,
                "song/Standard.osu": non_mania_content,
            }
        )
        results = parse_osz(osz_bytes)
        assert len(results) == 1  # only mania parsed
        metadata, hit_objects, filename = results[0]
        assert metadata.cs == 4
        assert len(hit_objects) == 1
        assert "4K HD.osu" in filename

    def test_parse_osz_empty_no_mania_osu(self):
        content = "[General]\nMode: 0\n"
        osz_bytes = self._make_osz({"song/Standard.osu": content})
        results = parse_osz(osz_bytes)
        assert results == []


class TestFindAudioFile:
    """Verify audio file extraction from .osz archives."""

    def _make_osz_with_audio(
        self, audio_name: str, audio_data: bytes = b"fake_audio_data"
    ) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("song/4K HD.osu", "[General]\nMode: 3\n")
            zf.writestr(audio_name, audio_data)
        return buf.getvalue()

    def test_find_audio_exact_name(self):
        osz_bytes = self._make_osz_with_audio("audio.mp3")
        result = find_audio_file(osz_bytes, "audio.mp3")
        assert result == b"fake_audio_data"

    def test_find_audio_basename_match(self):
        osz_bytes = self._make_osz_with_audio("subdir/audio.mp3")
        result = find_audio_file(osz_bytes, "subdir/audio.mp3")
        assert result == b"fake_audio_data"

    def test_find_audio_extension_variation(self):
        osz_bytes = self._make_osz_with_audio("audio.ogg")
        result = find_audio_file(osz_bytes, "audio.mp3")
        assert result == b"fake_audio_data"

    def test_find_audio_not_found_returns_none(self):
        osz_bytes = self._make_osz_with_audio("audio.mp3")
        result = find_audio_file(osz_bytes, "nonexistent.wav")
        assert result is None

    def test_find_audio_invalid_zip_returns_none(self):
        result = find_audio_file(b"garbage", "audio.mp3")
        assert result is None
