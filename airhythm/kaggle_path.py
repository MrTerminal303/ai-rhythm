"""Kaggle environment detection and path resolution.

When the project is imported as a Kaggle Dataset, this module locates the
mounted dataset root and resolves paths relative to it.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = ["detect_kaggle_env", "resolve_kaggle_input_dir"]


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
