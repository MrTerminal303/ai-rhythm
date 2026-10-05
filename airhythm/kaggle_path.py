"""Kaggle environment detection and path resolution.

When the project is imported as a Kaggle Dataset, this module locates the
mounted dataset root and resolves paths relative to it.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = ["detect_kaggle_env", "resolve_kaggle_input_dir", "attach_corpus"]


def detect_kaggle_env() -> bool:
    """Return True if running inside a Kaggle kernel."""
    return "KAGGLE_KERNEL_RUN_TYPE" in os.environ


def resolve_kaggle_input_dir() -> Path | None:
    """Find the airhythm dataset root under /kaggle/input/.

    Returns Path to the mounted dataset directory, or None if not on Kaggle.
    """
    if not detect_kaggle_env():
        return None
    input_root = Path("/kaggle/input")
    if not input_root.is_dir():
        return None
    for child in input_root.iterdir():
        if child.is_dir() and (child / "airhythm" / "__init__.py").exists():
            return child
    return None


def attach_corpus(flat_root, dest_root) -> Path:
    """Rebuild song dirs from a FLAT corpus upload (review #7 P0).

    Kaggle CLI's default --dir-mode skip uploads no folders, so Notebook A
    publishes files named song_<sid>__<file> at the dataset root. This
    reconstructs <dest>/<sid>/<file> as SYMLINKS to the mounted files —
    zero-copy, /kaggle/input stays read-only and is the only data copy.
    A nested minimal_dataset/ layout (local or AIRHYTHM_DATA-style trees)
    passes through unchanged.
    """
    flat_root = Path(flat_root)
    nested = flat_root / "minimal_dataset"
    if nested.is_dir():
        return nested
    dest_root = Path(dest_root)
    n = 0
    for f in sorted(flat_root.glob("song_*__*")):
        sid, sep, name = f.name[5:].partition("__")
        if not sep or not sid.isdigit():
            continue
        song_dir = dest_root / sid
        song_dir.mkdir(parents=True, exist_ok=True)
        link = song_dir / name
        if not (link.is_symlink() or link.exists()):
            link.symlink_to(f.resolve())
        n += 1
    if not n:
        raise FileNotFoundError(
            f"no flat corpus files (song_<sid>__<file>) under {flat_root} "
            "and no minimal_dataset/ subdir — is the corpus dataset attached?"
        )
    return dest_root
