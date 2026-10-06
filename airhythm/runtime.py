"""Runtime detection: Kaggle vs Colab vs local (review #9).

Single source of truth for where scratch/checkpoint/output dirs live, so
notebooks B/C run unmodified on either platform (notebook A stays Kaggle-only).
Storage model (review #9 §3): source = corpus Dataset, working = scratch
(temp), checkpoints/outputs = published from scratch — never mixed.
"""

from __future__ import annotations

import os
from pathlib import Path

from airhythm import config
from airhythm.kaggle_path import detect_kaggle_env

__all__ = ["Runtime", "runtime"]


class Runtime:
    """Where are we running, and which directories does that imply?

    Flags are injectable for tests; production code uses the `runtime` singleton.
    """

    def __init__(self, *, is_kaggle: bool | None = None, is_colab: bool | None = None):
        if is_kaggle is None:
            is_kaggle = detect_kaggle_env() or Path("/kaggle/input").exists()
        if is_colab is None:
            # ponytail: /content heuristic — correct on real Colab; a local
            # machine with a top-level /content dir would misdetect
            is_colab = not is_kaggle and Path("/content").exists()
        self.is_kaggle = bool(is_kaggle)
        self.is_colab = bool(is_colab)
        self.name = "kaggle" if self.is_kaggle else "colab" if self.is_colab else "local"

    @property
    def scratch(self) -> Path:
        """Writable working dir — temporary on Kaggle/Colab; publish to persist."""
        if self.is_kaggle:
            # KAGGLE_WORKING_DIR override preserved from pre-portability notebooks
            return Path(os.environ.get("KAGGLE_WORKING_DIR", config.EPHEMERAL_DIR))
        if self.is_colab:
            return Path("/content/airhythm")
        return Path(".airhythm")

    @property
    def checkpoints(self) -> Path:
        return self.scratch / config.CHECKPOINTS_DIR

    @property
    def output(self) -> Path:
        return self.scratch / "outputs"

    @property
    def drive_root(self) -> Path | None:
        """Google Drive persistence (Colab only) — checkpoints/logs, NOT the
        ~20GB corpus (review #9 B4)."""
        return Path("/content/drive/MyDrive/airhythm") if self.is_colab else None

    @property
    def drive_checkpoints(self) -> Path | None:
        root = self.drive_root
        return root / "checkpoints" if root else None


runtime = Runtime()
