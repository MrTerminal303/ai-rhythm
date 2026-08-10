"""Beatmap scraper for AIRhythm data pipeline.

Downloads .osz files from verified mirror sources, extracts audio,
converts to mel-spectrograms via audio_preproc, and saves labeled
training chunks for all downstream training phases.

Per D-14: Serial requests only, 1-2s delay between downloads.
Per D-15: Exponential backoff on 429 (start 2s, double, max 5 retries).
Per D-02: Uses pre-selected fastest source. Beatconnect token only
  used if it wins speed test (test_mirrors.py).
"""

from __future__ import annotations

import logging
import random
import time
from typing import Any, Callable, Dict, List, Optional

import requests

from airhythm import config

__all__ = [
    "search_maps",
    "download_osz",
    "Scraper",
    "batch_scrape",
    "pick_eval_songs",
]

logger = logging.getLogger(__name__)

# User-Agent for all requests per mirror requirements
USER_AGENT = "airhythm/1.0 (+github.com/MrTerminal/airhythm)"

# Source API base URLs
SOURCES: Dict[str, Dict[str, str]] = {
    "nerinyan": {
        "search": "https://api.nerinyan.moe/v2/search",
        "download": "https://api.nerinyan.moe/d",
    },
    "hinamizawa": {
        "search": "https://mirror.hinamizawa.ai/api/v1/hinai/search",
        "download": "https://mirror.hinamizawa.ai/api/v1/hinai/d",
    },
}

# Field name mappings for different API response formats
_FIELD_ALIASES: Dict[str, List[str]] = {
    "beatmapset_id": [
        "beatmapset_id",
        "BeatmapSetID",
        "beatmapset",
        "id",
        "set_id",
        "SetID",
    ],
    "title": ["title", "Title", "song_name"],
    "artist": ["artist", "Artist", "song_artist"],
    "bpm": ["bpm", "BPM", "bpm_min"],
    "cs": ["cs", "CS", "difficultyrating", "diff"],
}


def _extract_field(item: dict, name: str) -> Any:
    """Extract a field from a response dict using known aliases.

    Tries each alias for the given field name and returns the first
    non-None match.
    """
    for alias in _FIELD_ALIASES.get(name, [name]):
        value = item.get(alias)
        if value is not None:
            return value
    return None


def _normalize_beatmap_entry(item: dict) -> Optional[dict]:
    """Normalize a single API response entry to a standard format.

    Returns None for entries missing beatmapset_id or that don't pass
    the cs=4 filter.

    Returns:
        Dict with keys: beatmapset_id, title, artist, bpm, cs.
    """
    beatmapset_id = _extract_field(item, "beatmapset_id")
    if beatmapset_id is None:
        return None

    # Post-filter: only keep cs=4 (4K) maps.
    # hinai top-level has no CS — read it from ChildrenBeatmaps[].CS.
    cs = _extract_field(item, "cs")
    if cs is None and isinstance(item.get("ChildrenBeatmaps"), list):
        for cb in item["ChildrenBeatmaps"]:
            if _extract_field(cb, "cs") is not None:
                cs = _extract_field(cb, "cs")
                break
    if cs is not None:
        try:
            cs_int = int(float(cs))
            if cs_int != 4:
                return None
        except (ValueError, TypeError):
            pass

    return {
        "beatmapset_id": int(beatmapset_id),
        "title": str(_extract_field(item, "title") or ""),
        "artist": str(_extract_field(item, "artist") or ""),
        "bpm": float(_extract_field(item, "bpm") or 0.0),
        "cs": cs,
    }


def search_maps(
    source: str, api_key: Optional[str] = None
) -> List[dict]:
    """Search the source API for ranked/loved mania 4K beatmaps.

    Args:
        source: Source name ('nerinyan' or 'hinamizawa').
        api_key: Optional API key for sources that require one.

    Returns:
        List of dicts with keys: beatmapset_id, title, artist, bpm, cs.
        Empty list on error (logs warning, doesn't crash).
    """
    source_config = SOURCES.get(source)
    if source_config is None:
        logger.warning("Unknown source: %s", source)
        return []

    search_url = source_config["search"]

    # Build query params per source
    # Nerinyan: mode=3 (mania), status=2 (ranked), cs=4
    # Hinamizawa: mode=3 (mania), status=1 (ranked), cs=4
    params: Dict[str, Any] = {"mode": 3}
    if source == "nerinyan":
        params["status"] = 2
        params["cs"] = 4
    elif source == "hinamizawa":
        params["status"] = 1
        params["cs"] = 4

    headers = {"User-Agent": USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        response = requests.get(
            search_url, params=params, headers=headers, timeout=30
        )
        response.raise_for_status()

        data = response.json()
    except requests.RequestException as e:
        logger.warning("Search request to %s failed: %s", source, e)
        return []
    except ValueError as e:
        logger.warning("Invalid JSON from %s search: %s", source, e)
        return []

    # Normalize response format to list of dicts
    # Nerinyan v2 returns array directly
    # Hinamizawa returns dict with 'results' key
    if isinstance(data, dict):
        items = data.get("results", data.get("beatmapsets", data.get("data", [])))
    elif isinstance(data, list):
        items = data
    else:
        logger.warning("Unexpected response format from %s: %s", source, type(data))
        return []

    if not isinstance(items, list):
        logger.warning("Expected list from %s search, got %s", source, type(items))
        return []

    results: List[dict] = []
    for item in items:
        normalized = _normalize_beatmap_entry(item)
        if normalized is not None:
            results.append(normalized)

    return results


def download_osz(
    source: str,
    beatmapset_id: int,
    api_key: Optional[str] = None,
) -> Optional[bytes]:
    """Download .osz file bytes from the source mirror.

    Implements exponential backoff on 429 responses per D-15:
    start 2s, double each retry, max 5 retries.

    Args:
        source: Source name ('nerinyan' or 'hinamizawa').
        beatmapset_id: Beatmapset ID to download.
        api_key: Optional API key for sources that require one.

    Returns:
        Raw .osz bytes on success, None on failure.
    """
    source_config = SOURCES.get(source)
    if source_config is None:
        logger.warning("Unknown source: %s", source)
        return None

    download_url = f"{source_config['download']}/{beatmapset_id}"
    headers = {"User-Agent": USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    last_error: Optional[str] = None

    for retry in range(config.BACKOFF_MAX_RETRIES + 1):
        try:
            response = requests.get(
                download_url, headers=headers, timeout=120
            )

            if response.status_code == 200:
                content = response.content
                # Validate: must have zip-like content-type or reasonable size
                content_type = response.headers.get("content-type", "")
                if "zip" in content_type or len(content) > 1000:
                    return content
                else:
                    last_error = (
                        f"Non-zip content-type={content_type}, "
                        f"size={len(content)}"
                    )
                    logger.warning(
                        "Invalid download for %d: %s",
                        beatmapset_id,
                        last_error,
                    )
                    return None

            elif response.status_code == 429:
                if retry < config.BACKOFF_MAX_RETRIES:
                    delay = config.BACKOFF_START * (
                        config.BACKOFF_MULTIPLIER ** retry
                    )
                    logger.info(
                        "429 on %d, retry %d/%d, sleeping %.1fs",
                        beatmapset_id,
                        retry + 1,
                        config.BACKOFF_MAX_RETRIES,
                        delay,
                    )
                    time.sleep(delay)
                else:
                    last_error = (
                        f"429 after {config.BACKOFF_MAX_RETRIES} retries"
                    )
                    logger.warning(
                        "Exhausted retries for %d: %s",
                        beatmapset_id,
                        last_error,
                    )

            else:
                last_error = f"HTTP {response.status_code}"
                logger.warning(
                    "Download failed for %d: %s", beatmapset_id, last_error
                )
                return None

        except requests.RequestException as e:
            last_error = str(e)
            logger.warning(
                "Request error for %d (retry %d): %s",
                beatmapset_id,
                retry,
                e,
            )
            if retry < config.BACKOFF_MAX_RETRIES:
                delay = config.BACKOFF_START * (
                    config.BACKOFF_MULTIPLIER ** retry
                )
                time.sleep(delay)
            else:
                return None

    # All retries exhausted
    logger.warning(
        "Download failed for %d after %d retries: %s",
        beatmapset_id,
        config.BACKOFF_MAX_RETRIES,
        last_error or "unknown",
    )
    return None


class Scraper:
    """Orchestrates .osz download, parsing, and preprocessing.

    Serial-only scraper that downloads beatmaps from a verified source,
    extracts mania .osu files, preprocesses audio to mel-spectrogram
    chunks, and saves labeled training data.

    Per D-14: Serial requests with 1-2s random delay between downloads.
    """

    def __init__(
        self,
        source: str,
        output_dir: str,
        api_key: Optional[str] = None,
    ):
        """Initialize scraper.

        Args:
            source: Source name ('nerinyan' or 'hinamizawa').
            output_dir: Directory to save preprocessed output.
            api_key: Optional API key for sources that require one.
        """
        self.source = source
        self.output_dir = output_dir
        self.api_key = api_key
        self.downloaded = 0
        self.failed = 0
        self.skipped = 0

    def scrape_one(self, beatmapset_id: int) -> bool:
        """Download, parse, and preprocess a single beatmap.

        Args:
            beatmapset_id: Beatmapset ID to scrape.

        Returns:
            True on success, False on failure.
        """
        from airhythm.audio_preproc import preprocess_osz
        from airhythm.osu_parser import parse_osz

        # Phase 1: Download .osz
        osz_bytes = download_osz(self.source, beatmapset_id, self.api_key)
        if osz_bytes is None:
            logger.info("Failed to download %d", beatmapset_id)
            self.failed += 1
            return False

        # Phase 2: Quick check — parse .osz to see if there are mania .osu files
        parsed = parse_osz(osz_bytes)
        if not parsed:
            logger.info(
                "No mania beatmaps in %d, skipping", beatmapset_id
            )
            self.skipped += 1
            return False

        # Phase 3: Full preprocessing
        try:
            saved_files = preprocess_osz(osz_bytes, beatmapset_id, self.output_dir)
            if saved_files:
                logger.info(
                    "Preprocessed %d -> %d files",
                    beatmapset_id,
                    len(saved_files),
                )
            else:
                logger.warning(
                    "Preprocessing produced no output for %d", beatmapset_id
                )
                self.failed += 1
                return False
        except Exception as e:
            logger.error(
                "Preprocessing failed for %d: %s", beatmapset_id, e
            )
            self.failed += 1
            return False
        finally:
            # Phase 4: Delete .osz bytes from memory immediately
            del osz_bytes

        # Phase 5: Per D-14, sleep between downloads
        delay = random.uniform(
            config.SERIAL_DELAY_MIN, config.SERIAL_DELAY_MAX
        )
        time.sleep(delay)

        self.downloaded += 1
        return True

    def scrape_batch(self, ids: List[int]) -> Dict[str, Any]:
        """Scrape a list of beatmap IDs serially.

        Args:
            ids: List of beatmapset IDs to scrape.

        Returns:
            Dict with keys: downloaded, failed, skipped, total,
            ids_downloaded, ids_failed.
        """
        ids_downloaded: List[int] = []
        ids_failed: List[int] = []

        for beatmapset_id in ids:
            success = self.scrape_one(beatmapset_id)
            if success:
                ids_downloaded.append(beatmapset_id)
            else:
                ids_failed.append(beatmapset_id)

        return {
            "downloaded": self.downloaded,
            "failed": self.failed,
            "skipped": self.skipped,
            "total": len(ids),
            "ids_downloaded": ids_downloaded,
            "ids_failed": ids_failed,
        }

    def scrape_all(
        self,
        ids: List[int],
        batch_size: int = 50,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> Dict[str, Any]:
        """Scrape IDs in batches with progress reporting.

        Args:
            ids: Full list of beatmapset IDs to scrape.
            batch_size: Number of IDs per progress batch.
            progress_callback: Optional function(batch_index, total_batches).

        Returns:
            Aggregated summary dict with keys: downloaded, failed,
            skipped, total, ids_downloaded, ids_failed.
        """
        ids_downloaded: List[int] = []
        ids_failed: List[int] = []
        total = len(ids)

        for i in range(0, total, batch_size):
            batch = ids[i : i + batch_size]
            batch_num = i // batch_size + 1
            total_batches = (total + batch_size - 1) // batch_size

            logger.info(
                "Batch %d/%d: processing %d IDs",
                batch_num,
                total_batches,
                len(batch),
            )

            for beatmapset_id in batch:
                success = self.scrape_one(beatmapset_id)
                if success:
                    ids_downloaded.append(beatmapset_id)
                else:
                    ids_failed.append(beatmapset_id)

            if progress_callback is not None:
                progress_callback(batch_num, total_batches)

        return {
            "downloaded": self.downloaded,
            "failed": self.failed,
            "skipped": self.skipped,
            "total": total,
            "ids_downloaded": ids_downloaded,
            "ids_failed": ids_failed,
        }


def batch_scrape(
    source: str,
    output_dir: str,
    target_count: int = 300,
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Full batch scrape: test batch first, then scale.

    Phase 1 — Test batch: Search for maps, scrape TEST_BATCH_SIZE (5).
      If all 5 fail, return early without scaling.
    Phase 2 — Scale: Scrape remaining IDs up to target_count.
    Phase 3 — Return summary.

    Args:
        source: Source name ('nerinyan' or 'hinamizawa').
        output_dir: Directory to save preprocessed output.
        target_count: Target number of beatmaps to download.
        api_key: Optional API key for sources that require one.

    Returns:
        Summary dict with keys: phase, total_candidates, test_results,
        scale_results, all_downloaded, all_failed.
    """
    # Phase 1: Search for candidate maps
    candidates = search_maps(source, api_key)
    if not candidates:
        logger.warning("No candidates found from %s", source)
        return {
            "phase": "search_failed",
            "total_candidates": 0,
            "test_results": None,
            "scale_results": None,
            "all_downloaded": [],
            "all_failed": [],
        }

    candidate_ids = [c["beatmapset_id"] for c in candidates]
    logger.info(
        "Found %d candidate maps from %s", len(candidate_ids), source
    )

    scraper = Scraper(source, output_dir, api_key)

    # Phase 2: Test batch — scrape first TEST_BATCH_SIZE
    test_ids = candidate_ids[: config.TEST_BATCH_SIZE]
    logger.info(
        "Phase 1: Testing with %d maps (first %d candidates)",
        len(test_ids),
        config.TEST_BATCH_SIZE,
    )

    test_results = scraper.scrape_batch(test_ids)

    if test_results["downloaded"] == 0:
        logger.warning(
            "Test batch: all %d failed. Stopping.",
            config.TEST_BATCH_SIZE,
        )
        return {
            "phase": "test_batch_failed",
            "total_candidates": len(candidate_ids),
            "test_results": test_results,
            "scale_results": None,
            "all_downloaded": test_results["ids_downloaded"],
            "all_failed": test_results["ids_failed"],
        }

    logger.info(
        "Test batch: %d downloaded, %d failed, %d skipped",
        test_results["downloaded"],
        test_results["failed"],
        test_results["skipped"],
    )

    # Phase 3: Scale to target
    remaining_ids = candidate_ids[config.TEST_BATCH_SIZE:]
    scale_count = target_count - test_results["downloaded"]
    scale_ids = remaining_ids[: scale_count * 2]  # 2x buffer for failures

    if not scale_ids:
        logger.info("No remaining IDs to scrape after test batch")
        return {
            "phase": "test_only",
            "total_candidates": len(candidate_ids),
            "test_results": test_results,
            "scale_results": None,
            "all_downloaded": test_results["ids_downloaded"],
            "all_failed": test_results["ids_failed"],
        }

    logger.info(
        "Phase 2: Scaling to %d downloads from %d candidates",
        target_count,
        len(scale_ids),
    )

    scale_results = scraper.scrape_all(scale_ids)

    all_downloaded = (
        test_results["ids_downloaded"] + scale_results["ids_downloaded"]
    )
    all_failed = (
        test_results["ids_failed"] + scale_results["ids_failed"]
    )

    return {
        "phase": "complete",
        "total_candidates": len(candidate_ids),
        "test_results": test_results,
        "scale_results": scale_results,
        "all_downloaded": all_downloaded,
        "all_failed": all_failed,
    }


def pick_eval_songs(
    downloaded_ids: List[int],
    song_metadata: Dict[int, dict],
    n: int = 5,
) -> List[int]:
    """Pick n songs from downloaded set for permanent eval.

    Prefers variety in BPM range and artist diversity.
    Falls back to simple random selection if metadata is sparse.

    Results are recorded in metadata/eval_song_ids.json per D-16.

    Args:
        downloaded_ids: List of downloaded beatmapset IDs.
        song_metadata: Dict mapping beatmapset_id -> metadata dict
            with at least 'artist' and 'bpm' keys.
        n: Number of songs to pick.

    Returns:
        List of n beatmapset_ids.
    """
    if len(downloaded_ids) <= n:
        return sorted(downloaded_ids)

    # Group by artist for diversity
    artist_groups: Dict[str, List[int]] = {}
    for bid in downloaded_ids:
        meta = song_metadata.get(bid, {})
        artist = meta.get("artist", "unknown")
        if artist not in artist_groups:
            artist_groups[artist] = []
        artist_groups[artist].append(bid)

    selected: List[int] = []
    remaining: List[int] = []

    # Pick one from each artist group first
    for artist, ids in artist_groups.items():
        if len(selected) < n:
            # Pick the one with most moderate BPM from this artist
            if len(ids) > 1:
                ids_with_bpm = [
                    (bid, abs(song_metadata.get(bid, {}).get("bpm", 0) - 150))
                    for bid in ids
                ]
                ids_with_bpm.sort(key=lambda x: x[1])
                selected.append(ids_with_bpm[0][0])
                remaining.extend(bid for bid, _ in ids_with_bpm[1:])
            else:
                selected.append(ids[0])
        else:
            remaining.extend(ids)

    # If still need more, pick from remaining
    if len(selected) < n:
        random.shuffle(remaining)
        selected.extend(remaining[: n - len(selected)])

    return sorted(selected[:n])
