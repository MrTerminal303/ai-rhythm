"""Unit tests for airhythm/scraper.py download and scraping pipeline.

Covers backoff logic, response validation, mania CS filtering,
retry exhaustion, and the full Scraper class workflow.
All tests use mocking — no real network calls.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import time
import zipfile
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from airhythm.scraper import (
    Scraper,
    batch_scrape,
    download_osz,
    pick_eval_songs,
    search_maps,
)
from airhythm.config import (
    BACKOFF_MAX_RETRIES,
    BACKOFF_MULTIPLIER,
    BACKOFF_START,
    TEST_BATCH_SIZE,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_search_response(items: list) -> str:
    """Return JSON string for Nerinyan-style search response (flat array)."""
    return json.dumps(items)


def _make_hina_search_response(items: list) -> str:
    """Return JSON string for Hinamizawa-style search response (dict with results key)."""
    return json.dumps({"results": items})


def _make_osz_bytes() -> bytes:
    """Create a minimal valid .osz with one mania .osu file and a fake audio file."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        mania_content = (
            "[General]\n"
            "Mode: 3\n"
            "AudioFilename: audio.mp3\n"
            "[Difficulty]\n"
            "OverallDifficulty:4\n"
            "[Metadata]\n"
            "Title: Test\n"
            "Artist: Artist\n"
            "BeatmapSetID: 12345\n"
            "Version: 4K HD\n"
            "[HitObjects]\n"
            "256,192,5000,1,0,0:0:0:0:\n"
        )
        zf.writestr("song/4K HD.osu", mania_content)
        zf.writestr("audio.mp3", b"fake_audio_data_" * 1000)
    return buf.getvalue()


def _mock_response(
    status_code: int = 200,
    content: bytes = b"",
    json_data: Any = None,
    content_type: str = "",
) -> MagicMock:
    """Create a mock requests.Response."""
    resp = MagicMock(spec=requests.Response)
    resp.status_code = status_code
    resp.content = content
    if json_data is not None:
        resp.json.return_value = json_data
    else:
        resp.json.return_value = {}
    resp.headers = {"content-type": content_type}
    return resp


# ---------------------------------------------------------------------------
# Search maps tests
# ---------------------------------------------------------------------------


class TestSearchMaps:
    """Verify search_maps parses different API response formats correctly."""

    def test_search_nerinyan_list_format(self):
        """Nerinyan returns flat array — should parse correctly."""
        mock_items = [
            {"beatmapset_id": 100, "title": "Song A", "artist": "Artist1", "bpm": 140, "cs": 4},
            {"beatmapset_id": 101, "title": "Song B", "artist": "Artist2", "bpm": 175, "cs": 4},
        ]
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200, json_data=mock_items, content_type="application/json"
            )
            results = search_maps("nerinyan")

        assert len(results) == 2
        assert results[0]["beatmapset_id"] == 100
        assert results[1]["title"] == "Song B"
        mock_get.assert_called_once()

    def test_search_hinamizawa_dict_format(self):
        """Hinamizawa returns dict with 'results' key — should parse correctly."""
        mock_data = {
            "results": [
                {"beatmapset_id": 200, "title": "Song C", "artist": "Artist3", "bpm": 160, "cs": 4},
            ]
        }
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200, json_data=mock_data, content_type="application/json"
            )
            results = search_maps("hinamizawa")

        assert len(results) == 1
        assert results[0]["beatmapset_id"] == 200

    def test_search_empty_response(self):
        """Empty search results should return empty list."""
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200, json_data=[], content_type="application/json"
            )
            results = search_maps("nerinyan")
        assert results == []

    def test_search_http_error_returns_empty(self):
        """HTTP error should log warning and return empty list."""
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(500)
            results = search_maps("nerinyan")
        assert results == []

    def test_search_unknown_source_returns_empty(self):
        """Unknown source name should return empty list."""
        results = search_maps("nonexistent")
        assert results == []


# ---------------------------------------------------------------------------
# CS filter tests
# ---------------------------------------------------------------------------


class TestManiaFilter:
    """Verify only cs=4 entries pass through search_maps."""

    def test_mania_filter_keeps_cs4(self):
        """Search results with cs=4 should be kept."""
        items = [
            {"beatmapset_id": 1, "cs": 4, "title": "4K Map", "artist": "A"},
            {"beatmapset_id": 2, "cs": 7, "title": "7K Map", "artist": "B"},
            {"beatmapset_id": 3, "cs": 4, "title": "Another 4K", "artist": "C"},
        ]
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200, json_data=items, content_type="application/json"
            )
            results = search_maps("nerinyan")
        assert len(results) == 2
        assert all(r["beatmapset_id"] in (1, 3) for r in results)

    def test_mania_filter_cs_string(self):
        """CS as string should still be parsed correctly."""
        items = [
            {"beatmapset_id": 1, "cs": "4", "title": "4K", "artist": "A"},
        ]
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200, json_data=items, content_type="application/json"
            )
            results = search_maps("nerinyan")
        assert len(results) == 1
        assert results[0]["beatmapset_id"] == 1


# ---------------------------------------------------------------------------
# Download .osz tests
# ---------------------------------------------------------------------------


class TestDownloadOsz:
    """Verify download_osz response validation and backoff behavior."""

    def test_download_osz_success(self):
        """Successful zip download should return bytes."""
        osz_content = b"PK\x03\x04" + b"a" * 2000  # looks like a zip
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200,
                content=osz_content,
                content_type="application/zip",
            )
            result = download_osz("nerinyan", 12345)
        assert result == osz_content

    def test_download_osz_validates_response(self):
        """Non-zip content-type with small size should return None."""
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200,
                content=b"not a zip",
                content_type="text/html",
            )
            result = download_osz("nerinyan", 12345)
        assert result is None

    def test_download_osz_small_content_fallback(self):
        """Content > 1000 bytes should pass even without zip content-type."""
        large_content = b"x" * 2000
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200,
                content=large_content,
                content_type="application/octet-stream",
            )
            result = download_osz("nerinyan", 12345)
        assert result == large_content

    def test_download_osz_retries_429(self):
        """429 responses should trigger exponential backoff and retry."""
        with patch("airhythm.scraper.requests.get") as mock_get:
            # 3x 429 then success
            mock_get.side_effect = [
                _mock_response(429),
                _mock_response(429),
                _mock_response(429),
                _mock_response(200, content=b"real_zip_data", content_type="application/zip"),
            ]

            with patch("airhythm.scraper.time.sleep") as mock_sleep:
                result = download_osz("nerinyan", 12345)

        assert result == b"real_zip_data"
        assert mock_get.call_count == 4  # 3 retries + 1 success

        # Verify increasing backoff delays
        expected_delays = [
            BACKOFF_START * (BACKOFF_MULTIPLIER ** i)
            for i in range(3)
        ]
        actual_calls = [c[0][0] for c in mock_sleep.call_args_list]
        for expected, actual in zip(expected_delays, actual_calls):
            assert actual == pytest.approx(expected, rel=0.1)

    def test_download_osz_exhausts_retries(self):
        """5x 429 should exhaust retries and return None."""
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(429)
            with patch("airhythm.scraper.time.sleep"):
                result = download_osz("nerinyan", 12345)

        assert result is None
        # 5 retries + 1 initial request = 6 calls
        assert mock_get.call_count == 6

    def test_download_osz_unknown_source(self):
        """Unknown source should return None."""
        result = download_osz("nonexistent", 12345)
        assert result is None


# ---------------------------------------------------------------------------
# Scraper class tests
# ---------------------------------------------------------------------------


class TestScraper:
    """Verify Scraper class orchestration of download + parse + preprocess."""

    def test_scraper_init(self):
        """Scraper should initialize with counters at 0."""
        s = Scraper(source="nerinyan", output_dir="/tmp")
        assert s.source == "nerinyan"
        assert s.downloaded == 0
        assert s.failed == 0
        assert s.skipped == 0

    def test_scraper_scrape_one_success(self):
        """Full scrape_one pipeline should return True."""
        osz_bytes = _make_osz_bytes()

        with patch("airhythm.scraper.download_osz") as mock_dl:
            mock_dl.return_value = osz_bytes
            with patch("airhythm.osu_parser.parse_osz") as mock_parse:
                # Simulate parse_osz returning one valid mania entry
                from airhythm.osu_parser import BeatmapMetadata, HitObject
                meta = BeatmapMetadata(
                    title="Test", artist="A", beatmapset_id=12345,
                    difficulty_name="4K HD",
                )
                mock_parse.return_value = [(meta, [HitObject(5000, 5000, 0, 1)], "song/4K HD.osu")]

                with patch("airhythm.audio_preproc.preprocess_osz") as mock_prep:
                    mock_prep.return_value = [
                        {"file_type": "spectrogram", "path": "/tmp/test.npy"}
                    ]
                    with patch("airhythm.scraper.time.sleep"):
                        s = Scraper(source="nerinyan", output_dir="/tmp")
                        result = s.scrape_one(12345)

        assert result is True
        assert s.downloaded == 1

    def test_scraper_scrape_one_download_failure(self):
        """When download_osz returns None, scrape_one should return False."""
        with patch("airhythm.scraper.download_osz") as mock_dl:
            mock_dl.return_value = None
            with patch("airhythm.scraper.time.sleep"):
                s = Scraper(source="nerinyan", output_dir="/tmp")
                result = s.scrape_one(12345)

        assert result is False
        assert s.failed == 1

    def test_scraper_scrape_one_no_mania(self):
        """When .osz has no mania maps, should be skipped."""
        with patch("airhythm.scraper.download_osz") as mock_dl:
            mock_dl.return_value = b"fake_osz_data"
            with patch("airhythm.osu_parser.parse_osz") as mock_parse:
                mock_parse.return_value = []  # no mania maps
                with patch("airhythm.scraper.time.sleep"):
                    s = Scraper(source="nerinyan", output_dir="/tmp")
                    result = s.scrape_one(12345)

        assert result is False
        assert s.skipped == 1

    def test_scraper_scrape_batch(self):
        """scrape_batch should process multiple IDs and return summary."""
        osz_bytes = _make_osz_bytes()
        from airhythm.osu_parser import BeatmapMetadata, HitObject
        meta = BeatmapMetadata(
            title="Test", artist="A", beatmapset_id=12345,
            difficulty_name="4K HD",
        )

        # Patch the inner dependency chain so scrape_one runs with real logic
        with patch("airhythm.scraper.download_osz") as mock_dl:
            mock_dl.side_effect = [osz_bytes, None, osz_bytes, osz_bytes]
            with patch("airhythm.osu_parser.parse_osz") as mock_parse:
                mock_parse.return_value = [
                    (meta, [HitObject(5000, 5000, 0, 1)], "song/4K HD.osu")
                ]
                with patch("airhythm.audio_preproc.preprocess_osz") as mock_prep:
                    mock_prep.return_value = [
                        {"file_type": "spectrogram", "path": "/tmp/test.npy"}
                    ]
                    with patch("airhythm.scraper.time.sleep"):
                        s = Scraper(source="nerinyan", output_dir="/tmp")
                        result = s.scrape_batch([1, 2, 3, 4])

        assert result["downloaded"] == 3  # ids 1, 3, 4 succeed (osz bytes returned)
        assert result["total"] == 4
        assert result["ids_downloaded"] == [1, 3, 4]
        assert result["ids_failed"] == [2]


# ---------------------------------------------------------------------------
# batch_scrape tests
# ---------------------------------------------------------------------------


class TestBatchScrape:
    """Verify batch_scrape phases: test batch then scale."""

    def test_batch_scrape_test_batch(self):
        """batch_scrape should call scrape_one TEST_BATCH_SIZE times during test phase."""
        candidate_ids = list(range(100, 200))

        with patch("airhythm.scraper.search_maps") as mock_search:
            mock_search.return_value = [
                {"beatmapset_id": id_, "title": f"S{id_}", "artist": "A"}
                for id_ in candidate_ids
            ]
            with patch.object(Scraper, "scrape_batch") as mock_scrape_batch:
                mock_scrape_batch.return_value = {
                    "downloaded": 3, "failed": 2, "skipped": 0, "total": 5,
                    "ids_downloaded": candidate_ids[:3],
                    "ids_failed": candidate_ids[3:5],
                }
                with patch.object(Scraper, "scrape_all") as mock_scrape_all:
                    mock_scrape_all.return_value = {
                        "downloaded": 10, "failed": 2, "skipped": 0, "total": 95,
                        "ids_downloaded": candidate_ids[5:15],
                        "ids_failed": candidate_ids[15:17],
                    }
                    result = batch_scrape(
                        source="nerinyan",
                        output_dir="/tmp",
                        target_count=300,
                    )

        assert result["phase"] == "complete"
        assert result["total_candidates"] == 100
        assert mock_scrape_batch.call_count == 1
        assert mock_scrape_all.call_count == 1

    def test_batch_scrape_test_all_fail(self):
        """If all test batch items fail, should stop early."""
        with patch("airhythm.scraper.search_maps") as mock_search:
            mock_search.return_value = [
                {"beatmapset_id": i, "title": f"S{i}", "artist": "A"}
                for i in range(10)
            ]
            with patch.object(Scraper, "scrape_batch") as mock_scrape_batch:
                mock_scrape_batch.return_value = {
                    "downloaded": 0, "failed": 5, "skipped": 0, "total": 5,
                    "ids_downloaded": [], "ids_failed": list(range(5)),
                }
                result = batch_scrape(
                    source="nerinyan",
                    output_dir="/tmp",
                    target_count=300,
                )

        assert result["phase"] == "test_batch_failed"


# ---------------------------------------------------------------------------
# pick_eval_songs tests
# ---------------------------------------------------------------------------


class TestPickEvalSongs:
    """Verify eval song selection with artist diversity."""

    def test_pick_eval_songs_below_n(self):
        """If fewer IDs than n, return all."""
        result = pick_eval_songs([1, 2, 3], {}, n=5)
        assert result == [1, 2, 3]

    def test_pick_eval_songs_exact_n(self):
        """If exactly n IDs, return all sorted."""
        result = pick_eval_songs([3, 1, 4, 2, 5], {}, n=5)
        assert result == [1, 2, 3, 4, 5]

    def test_pick_eval_songs_artist_diversity(self):
        """Should prefer different artists."""
        ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        metadata = {
            id_: {"artist": f"Artist{i % 3}", "bpm": 140 + i * 5}
            for i, id_ in enumerate(ids)
        }
        result = pick_eval_songs(ids, metadata, n=3)
        assert len(result) == 3
        assert len(set(result)) == 3
        # Should have at most one per artist
        artists = [metadata[bid]["artist"] for bid in result]
        assert len(set(artists)) == len(artists)

    def test_pick_eval_songs_returns_unique_ids(self):
        """Should always return unique sorted IDs."""
        ids = list(range(20))
        metadata = {i: {"artist": "A", "bpm": 150} for i in ids}
        result = pick_eval_songs(ids, metadata, n=5)
        assert len(result) == 5
        assert len(set(result)) == 5
        assert result == sorted(result)


# ---------------------------------------------------------------------------
# User-Agent header tests
# ---------------------------------------------------------------------------


class TestUserAgent:
    """Verify User-Agent is set on all requests."""

    def test_search_sets_user_agent(self):
        """search_maps should pass User-Agent header."""
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200, json_data=[], content_type="application/json"
            )
            search_maps("nerinyan")
            _, kwargs = mock_get.call_args
            assert "User-Agent" in kwargs["headers"]
            assert "airhythm/1.0" in kwargs["headers"]["User-Agent"]

    def test_download_sets_user_agent(self):
        """download_osz should pass User-Agent header."""
        with patch("airhythm.scraper.requests.get") as mock_get:
            mock_get.return_value = _mock_response(
                200, content=b"data", content_type="application/zip"
            )
            download_osz("nerinyan", 12345)
            _, kwargs = mock_get.call_args
            assert "User-Agent" in kwargs["headers"]
            assert "airhythm/1.0" in kwargs["headers"]["User-Agent"]
