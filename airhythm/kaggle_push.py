"""Kaggle Dataset push and management module for AIRhythm.

Manages a single Kaggle Dataset as the single source of truth for all
preprocessed data, synthetic data, checkpoints, and baseline metrics.

Per D-04: Single Dataset with structured directories:
    - spectrograms/    — preprocessed mel-spectrogram chunks
    - baseline/        — baseline evaluation CSVs and metrics
    - checkpoints/     — model checkpoints (pruned to protect 20GB limit)
    - metadata/        — per-song metadata, manifest, eval song IDs

Per D-05: Naming convention:
    - {beatmapset_id}.npy for spectrograms
    - {beatmapset_id}.json for metadata

Per D-06: manifest.json at root maps beatmapset IDs to song metadata.

Uses kagglehub for Dataset upload:
    kagglehub.dataset_upload(handle, local_dir, version_notes, ignore_patterns)
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Dict, List, Optional

from airhythm import config

__all__ = [
    "create_dataset_structure",
    "build_manifest",
    "save_eval_song_ids",
    "push_dataset",
    "estimate_storage_size",
    "prune_old_checkpoints",
    "check_storage",
]

logger = logging.getLogger(__name__)


def create_dataset_structure(base_dir: str) -> Dict[str, str]:
    """Create the Kaggle Dataset directory structure.

    Creates subdirectories under base_dir as defined in D-04.

    Args:
        base_dir: Root directory for the Kaggle Dataset.

    Returns:
        Dict mapping directory names to full paths:
        {"spectrograms": "/path/to/spectrograms", ...}
    """
    subdirs = [
        config.SPECTROGRAMS_DIR,
        config.BASELINE_DIR,
        config.CHECKPOINTS_DIR,
        config.METADATA_DIR,
    ]
    paths: Dict[str, str] = {}
    for name in subdirs:
        path = os.path.join(base_dir, name)
        os.makedirs(path, exist_ok=True)
        paths[name] = path
    return paths


def build_manifest(metadata_dir: str, base_dir: Optional[str] = None) -> Dict:
    """Build a manifest.json for the Kaggle Dataset.

    Walks metadata_dir for all {beatmapset_id}.json files, reads metadata,
    and builds a manifest.json per D-06 spec.

    Args:
        metadata_dir: Directory containing metadata JSON files.
        base_dir: Root dataset directory for constructing relative file
            paths. If None, uses metadata_dir's parent.

    Returns:
        Dict matching D-06 manifest structure with keys:
        beatmapsets, dataset_version, created_at.
    """
    if base_dir is None:
        base_dir = os.path.dirname(metadata_dir)

    beatmapsets: Dict = {}

    if os.path.isdir(metadata_dir):
        for filename in sorted(os.listdir(metadata_dir)):
            if not filename.endswith(config.METADATA_EXT):
                continue
            # Extract beatmapset_id from filename (e.g. "12345.json")
            beatmapset_id_str = filename[: -len(config.METADATA_EXT)]
            if not beatmapset_id_str.isdigit():
                continue

            filepath = os.path.join(metadata_dir, filename)
            try:
                with open(filepath) as f:
                    meta = json.load(f)
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("Failed to read metadata %s: %s", filename, e)
                continue

            beatmapset_id = int(beatmapset_id_str)

            # Build file list
            files = []
            spec_filename = f"{beatmapset_id}{config.SPECTROGRAM_EXT}"
            spec_path = os.path.join(config.SPECTROGRAMS_DIR, spec_filename)
            files.append(spec_path)

            meta_path = os.path.join(config.METADATA_DIR, filename)
            files.append(meta_path)

            beatmapsets[beatmapset_id_str] = {
                "title": meta.get("title", ""),
                "artist": meta.get("artist", ""),
                "bpm": meta.get("bpm", 0.0),
                "difficulty": meta.get("difficulty_name", ""),
                "files": files,
            }

    manifest = {
        "beatmapsets": beatmapsets,
        "dataset_version": "1",
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    manifest_path = os.path.join(base_dir, config.MANIFEST_FILENAME)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    logger.info("Manifest written to %s with %d beatmapsets", manifest_path, len(beatmapsets))
    return manifest


def save_eval_song_ids(song_ids: List[int], metadata_dir: str) -> str:
    """Save evaluation song IDs to metadata directory per D-16/D-17.

    These 5 IDs are FIXED forever — never change without re-decision.

    Args:
        song_ids: List of beatmapset IDs for permanent evaluation set.
        metadata_dir: Metadata directory for saving the file.

    Returns:
        Path to the saved file.
    """
    data = {
        "eval_song_ids": sorted(song_ids),
        "selected_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "phase": "00-foundation",
    }

    os.makedirs(metadata_dir, exist_ok=True)
    filepath = os.path.join(metadata_dir, config.EVAL_SONGS_FILENAME)
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)

    logger.info("Eval song IDs saved to %s: %s", filepath, sorted(song_ids))
    return filepath


def push_dataset(
    local_dir: str,
    version_notes: str,
    handle: Optional[str] = None,
) -> bool:
    """Push a local directory to Kaggle Dataset via kagglehub.

    Checks directory size before upload and warns at 80% of the 20GB limit.

    Args:
        local_dir: Local directory containing the dataset files.
        version_notes: Version notes for this upload.
        handle: Kaggle Dataset handle (e.g. "username/dataset-name").
            If None, uses config.DATASET_HANDLE with default owner.

    Returns:
        True on success, False on failure (errors are logged).
    """
    if handle is None:
        handle = config.DATASET_HANDLE

    # Check size before upload
    size_info = estimate_storage_size(local_dir)
    size_gb = size_info["total_mb"] / 1024.0
    threshold_gb = config.MAX_DATASET_GB * 0.8

    logger.info(
        "Dataset size: %.2f GB (%.2f MB total)",
        size_gb,
        size_info["total_mb"],
    )

    if size_gb > config.MAX_DATASET_GB:
        logger.error(
            "Dataset size %.2f GB exceeds hard limit of %.1f GB. "
            "Prune old data before pushing.",
            size_gb,
            config.MAX_DATASET_GB,
        )
        return False

    if size_gb > threshold_gb:
        logger.warning(
            "Dataset size %.2f GB exceeds %.0f%% threshold (%.1f GB). "
            "Consider pruning checkpoints.",
            size_gb,
            80,
            threshold_gb,
        )

    # Push via kagglehub
    try:
        import kagglehub

        kagglehub.dataset_upload(
            handle,
            local_dir,
            version_notes=version_notes,
            ignore_patterns=["*.tmp", "__pycache__", "*.pyc"],
        )
        logger.info("Dataset uploaded successfully to %s", handle)
        return True
    except Exception as e:
        logger.error("Dataset upload failed: %s", e)
        return False


def estimate_storage_size(directory: str) -> Dict:
    """Estimate storage usage in a directory, broken down by file extension.

    Args:
        directory: Path to the directory to analyze.

    Returns:
        Dict with keys: total_bytes (int), total_mb (float),
        by_extension (dict mapping extension -> total_bytes).
    """
    by_extension: Dict[str, int] = {}
    total_bytes = 0

    if not os.path.isdir(directory):
        return {"total_bytes": 0, "total_mb": 0.0, "by_extension": {}}

    for root, _dirs, files in os.walk(directory):
        for filename in files:
            filepath = os.path.join(root, filename)
            try:
                size = os.path.getsize(filepath)
            except OSError:
                continue

            total_bytes += size
            _ext = os.path.splitext(filename)[1] or "(no ext)"
            by_extension[_ext] = by_extension.get(_ext, 0) + size

    total_mb = total_bytes / (1024.0 * 1024.0)

    return {
        "total_bytes": total_bytes,
        "total_mb": round(total_mb, 2),
        "by_extension": by_extension,
    }


def prune_old_checkpoints(
    checkpoint_dir: str,
    keep_latest: int = 1,
    keep_best: int = 1,
) -> int:
    """Prune old checkpoints, keeping only the latest N and best-val N.

    Identifies checkpoints by filename patterns:
        - "latest_*.pt" or "*_latest.pt" for latest checkpoints
        - "best_*.pt", "best_val_*.pt", or "*_best.pt" for best checkpoints
        - All other .pt files are deleted

    Args:
        checkpoint_dir: Directory containing checkpoint files.
        keep_latest: Number of latest checkpoints to keep (default 1).
        keep_best: Number of best-val checkpoints to keep (default 1).

    Returns:
        Number of checkpoint files deleted.
    """
    if not os.path.isdir(checkpoint_dir):
        logger.warning("Checkpoint directory does not exist: %s", checkpoint_dir)
        return 0

    import glob

    # Collect all .pt files
    pt_files = glob.glob(os.path.join(checkpoint_dir, "*.pt"))

    # Separate into categories
    latest_patterns = ["latest_*.pt", "*_latest.pt"]
    best_patterns = ["best_*.pt", "best_val_*.pt", "*_best.pt"]

    latest_files: List[str] = []
    best_files: List[str] = []
    other_files: List[str] = []

    for f in pt_files:
        basename = os.path.basename(f)
        is_latest = any(
            glob.fnmatch.fnmatch(basename, pat) for pat in latest_patterns
        )
        is_best = any(
            glob.fnmatch.fnmatch(basename, pat) for pat in best_patterns
        )

        if is_latest:
            latest_files.append(f)
        elif is_best:
            best_files.append(f)
        else:
            other_files.append(f)

    def _sort_by_mtime(file_list: List[str]) -> List[str]:
        return sorted(file_list, key=lambda f: os.path.getmtime(f), reverse=True)

    # Keep only keep_latest latest checkpoints
    latest_sorted = _sort_by_mtime(latest_files)
    latest_to_delete = latest_sorted[keep_latest:]

    # Keep only keep_best best checkpoints
    best_sorted = _sort_by_mtime(best_files)
    best_to_delete = best_sorted[keep_best:]

    # Delete non-latest/non-best checkpoints if they exceed keep counts
    # Also delete other .pt files that don't match any pattern
    deleted_count = 0
    for f in latest_to_delete + best_to_delete + other_files:
        try:
            os.remove(f)
            logger.debug("Deleted checkpoint: %s", f)
            deleted_count += 1
        except OSError as e:
            logger.warning("Failed to delete %s: %s", f, e)

    logger.info(
        "Pruned %d checkpoints from %s (kept %d latest, %d best)",
        deleted_count,
        checkpoint_dir,
        min(len(latest_files), keep_latest),
        min(len(best_files), keep_best),
    )
    return deleted_count


def check_storage(dataset_dir: str | None = None) -> Dict:
    """Check storage usage and report against the 20 GB Kaggle limit.

    Call from a notebook cell to see where data lives and how much room
    is left::

        from airhythm.kaggle_push import check_storage
        check_storage()
    """
    if dataset_dir is None:
        # On Kaggle: /kaggle/input/{slug}   Local: cwd
        for candidate in [
            config.EPHEMERAL_DIR,
            os.getcwd(),
        ]:
            if os.path.isdir(candidate):
                dataset_dir = candidate
                break
    if dataset_dir is None:
        return {"error": "no dataset directory found", "total_mb": 0}

    info = estimate_storage_size(dataset_dir)
    total_gb = info["total_mb"] / 1024.0
    limit_gb = config.MAX_DATASET_GB
    pct = (total_gb / limit_gb) * 100 if limit_gb > 0 else 0

    status = "OK"
    if pct >= 100:
        status = "OVER LIMIT"
    elif pct >= 80:
        status = "WARNING"

    return {
        "dataset_dir": dataset_dir,
        "total_mb": info["total_mb"],
        "total_gb": round(total_gb, 3),
        "limit_gb": limit_gb,
        "pct_used": round(pct, 1),
        "status": status,
        "by_extension": info["by_extension"],
    }
