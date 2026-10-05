"""Batch beatmap downloader: search all mirrors, download + preprocess at scale.

Complements ``download_minimal.py`` (small ad-hoc pulls, untracked): this one
is tracked, resumable, and survives per-song failures across large batches.

Guarantees:
  - Resume: complete song dirs (metadata .json present) are skipped; partial
    dirs from crashed runs are deleted so they get retried.
  - One bad beatmap never kills the batch: preprocess errors are caught,
    logged, and the partial output is cleaned up.
  - D-14 serial delay between songs; disk-free guard stops before Kaggle
    kills the kernel.

Usage:
    from airhythm.download_batch import main
    saved = main(output="data/dataset", n_songs=500)

Script: ``python -m airhythm.download_batch``
"""
from __future__ import annotations

import contextlib
import logging
import os
import random
import shutil
import time

from airhythm import config

__all__ = ["main", "is_complete_song_dir"]

logger = logging.getLogger(__name__)

# Stop before the disk fills — a full disk mid-run loses everything unsaved.
MIN_FREE_BYTES = 500 * 2**20


def is_complete_song_dir(path) -> bool:
    """True only when the dir holds every artifact preprocess_osz writes:
    metadata json (written last), original.audio, first chunk + labels.
    One shared definition for _prune_incomplete and Notebook A's pinned-skip
    check — any-json alone can accept a half-processed dir (review #5)."""
    try:
        names = {f.name for f in os.scandir(path)}
    except (FileNotFoundError, NotADirectoryError):
        return False
    return (
        any(n.endswith(".json") for n in names)
        and "original.audio" in names
        and "0000.npy" in names
        and "0000_labels.npy" in names
    )


def _prune_incomplete(output_dir: str) -> set[int]:
    """Return beatmapset IDs whose preprocessing finished, pruning the rest.

    Completeness = is_complete_song_dir (metadata json + audio + first chunk
    + labels). Partial dirs — crashed or failed runs — are deleted so the
    song gets re-downloaded on this run.
    """
    complete: set[int] = set()
    try:
        entries = list(os.scandir(output_dir))
    except FileNotFoundError:
        return complete
    for entry in entries:
        if not (entry.is_dir() and entry.name.isdigit()):
            continue
        if is_complete_song_dir(entry.path):
            complete.add(int(entry.name))
        else:
            shutil.rmtree(entry.path, ignore_errors=True)
    return complete


def main(
    output: str = "data/dataset",
    n_songs: int = 500,
    status=None,
    max_pages: int | None = None,
) -> int:
    """Search all mirrors and download + preprocess until ``n_songs`` total.

    Args:
        output: Directory for preprocessed song dirs (one per beatmapset).
        n_songs: Target TOTAL songs in output (already-complete count toward
            it) — rerunning an interrupted 500-run resumes to 500, not 1000.
        status: Beatmap status filter. None = source defaults (ranked).
        max_pages: Search pages per source. None = scaled to n_songs.

    Returns:
        Number of NEW songs saved this run.
    """
    from airhythm.scraper import SOURCES, download_osz, search_all_sources
    from airhythm.audio_preproc import preprocess_osz

    if max_pages is None:
        # Page sizes are 50-100; the 4K filter drops most entries, so budget
        # ~10 candidates/page of raw results.
        max_pages = max(20, n_songs // 10)

    print(f"=== Step 1: Searching all sources (max {max_pages} pages/source) ===")
    candidates = search_all_sources(status=status, max_pages=max_pages)
    if not candidates:
        print("FAIL: no 4K candidates found from any source")
        return 0

    os.makedirs(output, exist_ok=True)
    complete = _prune_incomplete(output)
    already = len(complete)
    if already >= n_songs:
        print(f"Already {already} complete songs (target {n_songs}) — done.")
        return 0
    available = [c for c in candidates if c["beatmapset_id"] not in complete]
    print(
        f"{len(candidates)} unique 4K candidates, "
        f"{already} already complete, {len(available)} to try"
    )
    if not available:
        print("Nothing to download.")
        return 0
    random.shuffle(available)

    download_sources = [s for s in SOURCES if SOURCES[s].get("download")]
    saved = 0

    print(f"\n=== Step 2: Downloading (target {n_songs} total songs) ===")
    with open(os.devnull, "w") as devnull:
        for i, t in enumerate(available):
            if already + saved >= n_songs:
                break
            bid = t["beatmapset_id"]

            if shutil.disk_usage(output).free < MIN_FREE_BYTES:
                print(f"Low disk (<{MIN_FREE_BYTES // 2**20} MB free) — stopping.")
                break
            if i:  # D-14: 1-2s between mirror requests
                time.sleep(
                    random.uniform(config.SERIAL_DELAY_MIN, config.SERIAL_DELAY_MAX)
                )

            print(f"  [{bid}] {t['title']}...", end=" ", flush=True)
            osz = None
            for src in download_sources:
                osz = download_osz(src, bid)
                if osz is not None:
                    break
            if osz is None:
                print("FAIL download")
                continue
            print(f"{len(osz)}B", end=" → ", flush=True)

            song_dir = os.path.join(output, str(bid))
            os.makedirs(song_dir, exist_ok=True)
            files = None
            try:
                with contextlib.redirect_stderr(devnull):
                    files = preprocess_osz(osz, bid, song_dir)
            except Exception as e:  # one bad beatmap must not kill the batch
                print(f"preprocess ERROR: {e}")
                logger.warning("Preprocessing failed for %d: %s", bid, e)
            if files:
                print(f"{len(files)} files")
                saved += 1
            else:
                print("FAIL preprocess")
                shutil.rmtree(song_dir, ignore_errors=True)
            del osz

    print(
        f"\n=== Done — {already + saved}/{n_songs} songs total "
        f"({saved} new this run) ==="
    )
    return saved


if __name__ == "__main__":
    main()
