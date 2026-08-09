"""Mirror connectivity verification for osu! beatmap sources.

Gate check before any scraper code runs. Tests all 3 active sources:
Nerinyan (free, no-auth), Beatconnect (free API token), Hinamizawa.ai (free, no-auth).

Per D-01: All 3 sources must be tested.
Per D-02: Fastest responding source is selected as primary.
           Beatconnect token setup is skipped unless it wins speed test.
Per D-03: All 3 fail -> manual browser-download fallback.
Per D-14: Serial requests only, 0.5s delay between.
Per D-15: Exponential backoff on 429 (not implemented here — done in scraper).
"""

from __future__ import annotations

import sys
import time
from typing import Any

import requests

from airhythm.config import SERIAL_DELAY_MIN

USER_AGENT = "airhythm/1.0 (+github.com/MrTerminal/airhythm)"
TIMEOUT = 30

# Beatmapset ID used for connectivity test (known to exist on all 3 sources)
TEST_BEATMAPSET_ID = 4169716

ResultDict = dict[str, Any]


def _test_source(
    url: str,
    source_name: str,
    headers: dict[str, str] | None = None,
) -> ResultDict:
    """Test a single mirror source and return a result dict.

    Parameters
    ----------
    url : str
        Full download URL for the beatmapset.
    source_name : str
        Human-readable source name (e.g. "nerinyan").
    headers : dict or None
        Optional HTTP headers to include.

    Returns
    -------
    dict
        Keys: source, ok, status, latency_ms, content_type, size_bytes, error
    """
    result: ResultDict = {
        "source": source_name,
        "ok": False,
        "status": 0,
        "latency_ms": 0.0,
        "content_type": "",
        "size_bytes": 0,
        "error": None,
    }
    req_headers = {"User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)

    try:
        start = time.perf_counter()
        response = requests.get(url, headers=req_headers, timeout=TIMEOUT, stream=False)
        elapsed = (time.perf_counter() - start) * 1000  # ms

        result["status"] = response.status_code
        result["latency_ms"] = round(elapsed, 1)
        result["content_type"] = response.headers.get("Content-Type", "")
        result["size_bytes"] = len(response.content)

        if response.status_code == 200:
            result["ok"] = True
        elif response.status_code == 401:
            # Beatconnect returns 401 without auth token — expected (D-02)
            result["error"] = "NO (no token)"
        else:
            result["error"] = f"HTTP {response.status_code}"

    except requests.exceptions.Timeout:
        result["error"] = "timeout"
    except requests.exceptions.ConnectionError as exc:
        result["error"] = f"connection error: {exc}"
    except requests.exceptions.RequestException as exc:
        result["error"] = f"request error: {exc}"

    return result


def test_nerinyan(beatmapset_id: int = TEST_BEATMAPSET_ID) -> ResultDict:
    """Test Nerinyan mirror (free, no-auth).

    GET https://api.nerinyan.moe/d/{beatmapset_id}
    """
    url = f"https://api.nerinyan.moe/d/{beatmapset_id}"
    return _test_source(url, "nerinyan")


def test_beatconnect(beatmapset_id: int = TEST_BEATMAPSET_ID) -> ResultDict:
    """Test Beatconnect mirror (free API token, but we skip token setup unless it wins).

    GET https://beatconnect.io/api/download/{beatmapset_id}

    NOTE: Returns 401 without auth token — this is EXPECTED per D-02.
    """
    url = f"https://beatconnect.io/api/download/{beatmapset_id}"
    return _test_source(url, "beatconnect")


def test_hinamizawa(beatmapset_id: int = TEST_BEATMAPSET_ID) -> ResultDict:
    """Test Hinamizawa.ai mirror (free, no-auth).

    GET https://mirror.hinamizawa.ai/api/v1/hinai/d/{beatmapset_id}
    User-Agent header is REQUIRED per Hinamizawa docs (RESEARCH.md Section 1).
    """
    url = f"https://mirror.hinamizawa.ai/api/v1/hinai/d/{beatmapset_id}"
    return _test_source(url, "hinamizawa")


def test_all_sources(beatmapset_id: int = TEST_BEATMAPSET_ID) -> list[ResultDict]:
    """Run all 3 source tests sequentially (serial per D-14), 0.5s delay between.

    Parameters
    ----------
    beatmapset_id : int
        Beatmapset ID to test download on.

    Returns
    -------
    list[dict]
        List of result dicts from each source test.
    """
    results: list[ResultDict] = []

    results.append(test_nerinyan(beatmapset_id))
    time.sleep(0.5)

    results.append(test_beatconnect(beatmapset_id))
    time.sleep(0.5)

    results.append(test_hinamizawa(beatmapset_id))

    return results


def pick_fastest_source(results: list[ResultDict]) -> str | None:
    """Return source name of the fastest working source.

    A source is "working" if:
    - ``ok`` is True AND
    - Content-Type contains "zip" OR size_bytes > 1000 (real .osz response)

    If Beatconnect returned 401 but another source worked, skip Beatconnect.
    If no source meets criteria, return None.

    Parameters
    ----------
    results : list[dict]
        List of result dicts from test_all_sources.

    Returns
    -------
    str or None
        Source name of fastest working source, or None if all fail.
    """
    working: list[ResultDict] = []
    for r in results:
        if not r["ok"]:
            continue
        # Must have a real .osz response
        ct = r.get("content_type", "")
        size = r.get("size_bytes", 0)
        if "zip" not in ct and size <= 1000:
            continue
        working.append(r)

    if not working:
        return None

    # Pick the one with lowest latency
    best = min(working, key=lambda r: r["latency_ms"])
    return best["source"]


def print_source_report(results: list[ResultDict]) -> None:
    """Pretty-print a source comparison table.

    Parameters
    ----------
    results : list[dict]
        List of result dicts from test_all_sources.
    """
    print(f"{'Source':<14} | {'Status':<7} | {'Latency(ms)':<11} | {'Size(KB)':<8} | Working")
    print("-" * 60)
    for r in results:
        status = r["status"]
        latency = r["latency_ms"]
        size_kb = round(r["size_bytes"] / 1024, 1) if r["size_bytes"] > 0 else 0
        working = "YES" if r["ok"] else (r["error"] or "NO")
        print(
            f"{r['source']:<14} | {status:<7} | {latency:<11} | {size_kb:<8} | {working}"
        )

    fastest = pick_fastest_source(results)
    if fastest:
        print(f"\nRecommended primary: {fastest}")
    else:
        print("\nNo working source found. Use manual .osz fallback (D-03).")


def main() -> int:
    """Run all source tests, print report, pick fastest.

    Returns
    -------
    int
        0 if at least one source works, 1 if all fail.
    """
    print(f"Testing mirror sources (beatmapset_id={TEST_BEATMAPSET_ID})...\n")
    results = test_all_sources()
    print_source_report(results)

    fastest = pick_fastest_source(results)
    if fastest:
        print(f"\nExit: 0 (primary: {fastest})")
        return 0
    else:
        print("\nExit: 1 (all sources failed)")
        return 1


if __name__ == "__main__":
    sys.exit(main())
