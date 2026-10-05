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
    "search_all_pages",
    "search_all_sources",
    "download_osz",
    "Scraper",
    "batch_scrape",
    "pick_eval_songs",
]

logger = logging.getLogger(__name__)

# User-Agent for all requests per mirror requirements
USER_AGENT = "airhythm/1.0 (+github.com/MrTerminal/airhythm)"

# Source API base URLs. 'status' is the ranked-status param each API expects.
SOURCES = {
    "hinamizawa": {
        "search": "https://mirror.hinamizawa.ai/v3/osu/beatmaps/search/v2",
        "download": "https://mirror.hinamizawa.ai/d",
        "status": "ranked",       # string status for v2 endpoint
        "page_param": "page",     # 0-indexed
        "size_param": "limit",    # max 100
        "page_size": 100,
        "use_cascade": True,      # /d/ returns JSON with download_url
        "id_key": "id",           # top-level id in beatmapset
    },
    "osu.direct": {
        "search": "https://osu.direct/api/search",  # CheeseGull endpoint
        "download": "https://osu.direct/d",
        "status": 1,              # numeric: 1=ranked for CheeseGull
        "page_param": "offset",   # offset-based
        "size_param": "amount",   # items per page
        "page_size": 50,
        "id_key": "SetID",        # CheeseGull uses SetID
    },
    "catboy": {
        "search": "https://catboy.best/api/v2/search",
        "download": "https://catboy.best/d",
        "status": None,           # no status filter
        "page_param": "page",     # 1-indexed
        "size_param": "limit",
        "page_size": 100,
        "browser_ua": True,
        "id_key": "id",
    },
    "nerinyan": {
        "search": "https://api.nerinyan.moe/v2/search",
        "download": "https://api.nerinyan.moe/d",
        "status": 2,              # numeric: 2=ranked
        "page_param": None,       # no pagination
        "id_key": "id",
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
        "setid",
    ],
    "title": ["title", "Title", "song_name"],
    "artist": ["artist", "Artist", "song_artist"],
    "bpm": ["bpm", "BPM", "bpm_min"],
    "cs": ["cs", "CS", "difficultyrating", "diff"],
}


def _extract_field(item: dict, name: str) -> Any:
    """First non-None alias value for a field, or None."""
    for alias in _FIELD_ALIASES.get(name, [name]):
        value = item.get(alias)
        if value is not None:
            return value
    return None


def _headers(api_key: Optional[str] = None, browser_ua: bool = False) -> Dict[str, str]:
    headers = {"User-Agent": USER_AGENT}
    if browser_ua:
        headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _backoff_delay(retry: int) -> float:
    return config.BACKOFF_START * (config.BACKOFF_MULTIPLIER ** retry)


def _normalize_beatmap_entry(item: dict, id_key: str = "beatmapset_id") -> Optional[dict]:
    """Normalize a single API response entry to a standard format.

    Returns None for entries missing beatmapset_id or that don't have
    a 4K (cs=4) difficulty. Checks top-level cs, ChildrenBeatmaps[], and beatmaps[].

    Args:
        item: Raw API response item.
        id_key: Key to extract beatmapset_id from (SetID, id, beatmapset_id).

    Returns:
        Dict with keys: beatmapset_id, title, artist, bpm, cs.
    """
    beatmapset_id = item.get(id_key) or _extract_field(item, "beatmapset_id")
    if beatmapset_id is None:
        return None

    # Check for 4K: top-level cs, then ChildrenBeatmaps[], then beatmaps[]
    has_4k = False
    cs_val = None

    # Top-level cs
    cs = _extract_field(item, "cs")
    if cs is not None:
        try:
            if int(float(cs)) == 4:
                has_4k = True
                cs_val = cs
        except (ValueError, TypeError):
            pass

    # ChildrenBeatmaps[] (hinamizawa CheeseGull shape)
    if not has_4k and isinstance(item.get("ChildrenBeatmaps"), list):
        for cb in item["ChildrenBeatmaps"]:
            cb_cs = cb.get("CS") or cb.get("cs")
            if cb_cs is not None:
                try:
                    if int(float(cb_cs)) == 4:
                        has_4k = True
                        cs_val = cb_cs
                        break
                except (ValueError, TypeError):
                    pass

    # beatmaps[] (hinamizawa v2 / osu v2 shape)
    if not has_4k and isinstance(item.get("beatmaps"), list):
        for b in item["beatmaps"]:
            b_cs = b.get("cs")
            b_mode = b.get("mode")
            if b_cs is not None:
                try:
                    if int(float(b_cs)) == 4:
                        has_4k = True
                        cs_val = b_cs
                        break
                except (ValueError, TypeError):
                    pass
            elif b_mode == "mania" or b_mode == 3:
                has_4k = True
                cs_val = 4
                break

    if not has_4k:
        return None

    return {
        "beatmapset_id": int(beatmapset_id),
        "title": str(_extract_field(item, "title") or ""),
        "artist": str(_extract_field(item, "artist") or ""),
        "bpm": float(_extract_field(item, "bpm") or 0.0),
        "cs": cs,
    }


def search_maps(source: str, api_key: Optional[str] = None, status: Optional[int] = None) -> List[dict]:
    """Search the source API for mania 4K beatmaps.

    Args:
        source: Source name ('nerinyan' or 'hinamizawa').
        api_key: Optional API key for sources that require one.
        status: Beatmap status filter. None = all statuses.
            1 = ranked, 2 = approved, 4 = all. If None, uses source default.

    Returns:
        List of dicts with keys: beatmapset_id, title, artist, bpm, cs.
        Empty list on error (logs warning, doesn't crash).
    """
    source_config = SOURCES.get(source)
    if source_config is None:
        logger.warning("Unknown source: %s", source)
        return []

    if status is None:
        status = source_config["status"]
    params = {"mode": 3, "cs": 4}
    if status is not None:
        params["status"] = status
    browser_ua = source_config.get("browser_ua", False)

    try:
        response = requests.get(
            source_config["search"],
            params=params,
            headers=_headers(api_key, browser_ua=browser_ua),
            timeout=30,
        )
        if response.status_code == 530:
            logger.warning("Search to %s returned 530 (Cloudflare block) — skipping", source)
            return []
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as e:
        logger.warning("Search request to %s failed: %s", source, e)
        return []
    except ValueError as e:
        logger.warning("Invalid JSON from %s search: %s", source, e)
        return []

    # Nerinyan returns a flat array; hinamizawa v2 returns dict with 'beatmapsets'.
    if isinstance(data, dict):
        items = data.get("beatmapsets", data.get("results", data.get("data", [])))
    elif isinstance(data, list):
        items = data
    else:
        logger.warning("Unexpected response format from %s: %s", source, type(data))
        return []

    if not isinstance(items, list):
        logger.warning("Expected list from %s search, got %s", source, type(items))
        return []

    results: List[dict] = []
    id_key = source_config.get("id_key", "beatmapset_id")
    for item in items:
        normalized = _normalize_beatmap_entry(item, id_key=id_key)
        if normalized is not None:
            results.append(normalized)
    return results


def search_all_pages(
    source: str,
    api_key: Optional[str] = None,
    status=None,
    max_pages: int = 20,
) -> List[dict]:
    """Paginate through all available results for a source.

    Uses source's page_param/size_param and page_size from SOURCES config.
    Stops when: empty page, max_pages reached, or duplicate IDs seen.

    Args:
        source: Source name from SOURCES dict.
        api_key: Optional API key.
        status: Beatmap status filter. None = source default.
        max_pages: Safety limit on pagination depth.

    Returns:
        Deduplicated list of beatmap dicts.
    """
    source_config = SOURCES.get(source)
    if source_config is None:
        return []

    page_param = source_config.get("page_param")
    size_param = source_config.get("size_param", "limit")
    page_size = source_config.get("page_size", 50)
    id_key = source_config.get("id_key", "beatmapset_id")

    if page_param is None:
        return search_maps(source, api_key=api_key, status=status)

    seen_ids: set[int] = set()
    all_results: List[dict] = []

    for page_idx in range(max_pages):
        status_val = status if status is not None else source_config.get("status")
        params: Dict[str, Any] = {"mode": 3}
        if status_val is not None:
            params["status"] = status_val
        params[size_param] = page_size
        # offset-based sources need page_idx * page_size; page-based need page_idx
        if page_param == "offset":
            params[page_param] = page_idx * page_size
        else:
            params[page_param] = page_idx
        browser_ua = source_config.get("browser_ua", False)

        try:
            response = requests.get(
                source_config["search"],
                params=params,
                headers=_headers(api_key, browser_ua=browser_ua),
                timeout=30,
            )
            if response.status_code == 530:
                logger.warning("%s search returned 530 on page %d — stopping", source, page_idx)
                break
            response.raise_for_status()
            data = response.json()
        except (requests.RequestException, ValueError):
            break

        if isinstance(data, dict):
            items = data.get("beatmapsets", data.get("results", data.get("data", [])))
        elif isinstance(data, list):
            items = data
        else:
            break

        if not isinstance(items, list) or len(items) == 0:
            break

        new_count = 0
        for item in items:
            normalized = _normalize_beatmap_entry(item, id_key=id_key)
            if normalized is not None and normalized["beatmapset_id"] not in seen_ids:
                seen_ids.add(normalized["beatmapset_id"])
                all_results.append(normalized)
                new_count += 1

        logger.info("%s page %d: %d new (total %d)", source, page_idx, new_count, len(all_results))

        # Stop if no new items (all duplicates or empty)
        if new_count == 0:
            break

        time.sleep(0.5)

    return all_results


def search_all_sources(
    api_key: Optional[str] = None,
    status=None,
    max_pages: int = 100,
) -> List[dict]:
    """Search all sources, dedup by beatmapset_id across sources.

    Tries sources in order of reliability. Deduplicates globally.

    Args:
        api_key: Optional API key (currently unused, reserved).
        status: Beatmap status filter. None = source defaults.
        max_pages: Max pages per source.

    Returns:
        Deduplicated list of beatmap dicts from all working sources.
    """
    seen_ids: set[int] = set()
    all_results: List[dict] = []

    for source in SOURCES:
        results = search_all_pages(source, api_key=api_key, status=status, max_pages=max_pages)
        new = 0
        for r in results:
            if r["beatmapset_id"] not in seen_ids:
                seen_ids.add(r["beatmapset_id"])
                all_results.append(r)
                new += 1
        logger.info("search_all_sources: %s contributed %d new (total %d)", source, new, len(all_results))

    return all_results


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
    browser_ua = source_config.get("browser_ua", False)
    use_cascade = source_config.get("use_cascade", False)
    headers = _headers(api_key, browser_ua=browser_ua)

    # For cascade sources, also try proxy endpoint as fallback
    proxy_url = None
    if use_cascade:
        # Hinamizawa proxy: /api/v1/hinai/d/{id}
        proxy_url = f"https://mirror.hinamizawa.ai/api/v1/hinai/d/{beatmapset_id}"

    for retry in range(config.BACKOFF_MAX_RETRIES + 1):
        try:
            # Try direct download first
            response = requests.get(download_url, headers=headers, timeout=120, allow_redirects=True)

            if response.status_code == 200:
                content = response.content
                content_type = response.headers.get("content-type", "")

                # Cascade endpoint returns JSON with download_url
                if use_cascade and "json" in content_type:
                    import json as _json
                    try:
                        cascade = _json.loads(content)
                        if cascade.get("success") and cascade.get("download_url"):
                            file_resp = requests.get(cascade["download_url"], timeout=120, allow_redirects=True)
                            if file_resp.status_code == 200 and len(file_resp.content) > 1000:
                                return file_resp.content
                            # Redirect failed — try proxy fallback
                            if proxy_url:
                                proxy_resp = requests.get(proxy_url, headers=headers, timeout=120)
                                if proxy_resp.status_code == 200 and len(proxy_resp.content) > 1000:
                                    return proxy_resp.content
                    except (_json.JSONDecodeError, KeyError):
                        pass
                    # Cascade returned JSON but no usable bytes — try proxy
                    if proxy_url:
                        proxy_resp = requests.get(proxy_url, headers=headers, timeout=120)
                        if proxy_resp.status_code == 200 and len(proxy_resp.content) > 1000:
                            return proxy_resp.content
                    return None

                # Direct download: must have zip-like content-type or reasonable size.
                if "zip" in content_type or len(content) > 1000:
                    return content
                logger.warning(
                    "Invalid download for %d: non-zip content-type=%s, size=%d",
                    beatmapset_id,
                    content_type,
                    len(content),
                )
                return None

            elif response.status_code == 429 and retry < config.BACKOFF_MAX_RETRIES:
                delay = _backoff_delay(retry)
                logger.info(
                    "429 on %d, retry %d/%d, sleeping %.1fs",
                    beatmapset_id,
                    retry + 1,
                    config.BACKOFF_MAX_RETRIES,
                    delay,
                )
                time.sleep(delay)

            else:
                logger.warning(
                    "Download failed for %d: HTTP %s",
                    beatmapset_id,
                    response.status_code,
                )
                return None

        except requests.RequestException as e:
            logger.warning(
                "Request error for %d (retry %d): %s", beatmapset_id, retry, e
            )
            if retry < config.BACKOFF_MAX_RETRIES:
                time.sleep(_backoff_delay(retry))
            else:
                return None

    # All retries exhausted (429 on every attempt).
    logger.warning(
        "Download failed for %d after %d retries", beatmapset_id, config.BACKOFF_MAX_RETRIES
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
            logger.info("No mania beatmaps in %d, skipping", beatmapset_id)
            self.skipped += 1
            return False

        # Phase 3: Full preprocessing
        try:
            saved_files = preprocess_osz(osz_bytes, beatmapset_id, self.output_dir)
        except Exception as e:
            logger.error("Preprocessing failed for %d: %s", beatmapset_id, e)
            self.failed += 1
            return False

        if not saved_files:
            logger.warning("Preprocessing produced no output for %d", beatmapset_id)
            self.failed += 1
            return False

        logger.info("Preprocessed %d -> %d files", beatmapset_id, len(saved_files))

        # Phase 4: Per D-14, delay between downloads
        time.sleep(
            random.uniform(config.SERIAL_DELAY_MIN, config.SERIAL_DELAY_MAX)
        )

        self.downloaded += 1
        return True

    def scrape_all(
        self,
        ids: List[int],
        batch_size: int = 50,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> Dict[str, Any]:
        """Scrape IDs serially, optionally in batches with progress reporting.

        Args:
            ids: List of beatmapset IDs to scrape.
            batch_size: Number of IDs per progress batch.
            progress_callback: Optional function(batch_index, total_batches).

        Returns:
            Dict with keys: downloaded, failed, skipped, total,
            ids_downloaded, ids_failed.
        """
        ids_downloaded: List[int] = []
        ids_failed: List[int] = []
        total_batches = (len(ids) + batch_size - 1) // batch_size

        for i in range(0, len(ids), batch_size):
            batch = ids[i : i + batch_size]
            batch_num = i // batch_size + 1

            logger.info(
                "Batch %d/%d: processing %d IDs",
                batch_num,
                total_batches,
                len(batch),
            )

            for beatmapset_id in batch:
                if self.scrape_one(beatmapset_id):
                    ids_downloaded.append(beatmapset_id)
                else:
                    ids_failed.append(beatmapset_id)

            if progress_callback is not None:
                progress_callback(batch_num, total_batches)

        return {
            "downloaded": self.downloaded,
            "failed": self.failed,
            "skipped": self.skipped,
            "total": len(ids),
            "ids_downloaded": ids_downloaded,
            "ids_failed": ids_failed,
        }


def batch_scrape(
    source: str,
    output_dir: str,
    target_count: int = 300,
    api_key: Optional[str] = None,
    status: Optional[int] = None,
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
    candidates = search_maps(source, api_key, status=status)
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
    logger.info("Found %d candidate maps from %s", len(candidate_ids), source)

    scraper = Scraper(source, output_dir, api_key)

    # Phase 1: Test batch — scrape first TEST_BATCH_SIZE, stop if all fail.
    test_ids = candidate_ids[: config.TEST_BATCH_SIZE]
    logger.info(
        "Phase 1: Testing with %d maps (first %d candidates)",
        len(test_ids),
        config.TEST_BATCH_SIZE,
    )

    test_results = scraper.scrape_all(test_ids, batch_size=len(test_ids))

    if test_results["downloaded"] == 0:
        logger.warning("Test batch: all %d failed. Stopping.", config.TEST_BATCH_SIZE)
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

    # Phase 2: Scale to target — 2x buffer for failures.
    remaining_ids = candidate_ids[config.TEST_BATCH_SIZE:]
    scale_ids = remaining_ids[: (target_count - test_results["downloaded"]) * 2]

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

    return {
        "phase": "complete",
        "total_candidates": len(candidate_ids),
        "test_results": test_results,
        "scale_results": scale_results,
        "all_downloaded": (
            test_results["ids_downloaded"] + scale_results["ids_downloaded"]
        ),
        "all_failed": (
            test_results["ids_failed"] + scale_results["ids_failed"]
        ),
    }


def pick_eval_songs(
    downloaded_ids: List[int],
    song_metadata: Dict[int, dict],
    n: int = 5,
) -> List[int]:
    """Pick n songs from downloaded set for permanent eval.

    Prefers artist diversity: one per artist, then random fill.
    Results are recorded in metadata/eval_song_ids.json per D-16.

    Args:
        downloaded_ids: List of downloaded beatmapset IDs.
        song_metadata: Dict mapping beatmapset_id -> metadata dict
            with at least 'artist' key.
        n: Number of songs to pick.

    Returns:
        List of n beatmapset_ids.
    """
    if len(downloaded_ids) <= n:
        return sorted(downloaded_ids)

    # Group by artist for diversity.
    artist_groups: Dict[str, List[int]] = {}
    for bid in downloaded_ids:
        artist = song_metadata.get(bid, {}).get("artist", "unknown")
        artist_groups.setdefault(artist, []).append(bid)

    # One per artist first, then random fill.
    selected = [ids[0] for ids in artist_groups.values()][:n]
    if len(selected) < n:
        rest = [bid for ids in artist_groups.values() for bid in ids[1:]]
        random.shuffle(rest)
        selected.extend(rest[: n - len(selected)])

    return sorted(selected[:n])
