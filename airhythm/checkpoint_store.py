"""Portable checkpoint locations (review #9 B5/B10).

Training writes checkpoints locally every epoch (unchanged — B7: do not
rewrite training for portability). This store resolves READS across platforms
(local → Google Drive → attached Kaggle Dataset) and syncs to Drive so a
Colab runtime death never loses more than one publish interval. Kaggle CLI
publish stays in the notebook's push_now(): prune + metadata + status belong
there, not here.
"""

from __future__ import annotations

import shutil
from pathlib import Path

__all__ = ["CheckpointStore"]


class CheckpointStore:
    """Resolve latest/best checkpoints on Kaggle or Colab.

    Copy-in semantics (review #5): a hit found outside local_dir is COPIED into
    it first, so anything that publishes local_dir (push_now) always contains
    the checkpoint local selection picked — an attached/Drive best_*.pt can
    never vanish from the published dataset when this session never improves
    past it.
    """

    def __init__(self, local_dir, *, attached_dir=None, drive_dir=None):
        self.local_dir = Path(local_dir)
        self.attached_dir = Path(attached_dir) if attached_dir else None
        self.drive_dir = Path(drive_dir) if drive_dir else None

    def glob(self, pat: str) -> list[Path]:
        """Local first; else Drive then attached dataset, copy-in then return."""
        hits = sorted(self.local_dir.glob(pat))
        if hits:
            return hits
        for src_dir in (self.drive_dir, self.attached_dir):
            if src_dir is None or not src_dir.is_dir():
                continue
            for src in sorted(src_dir.glob(pat)):
                shutil.copy2(src, self.local_dir / src.name)
            hits = sorted(self.local_dir.glob(pat))
            if hits:
                return hits
        return []

    def sync_to_drive(self, patterns: tuple[str, ...] = ("latest_*.pt", "best_*.pt")) -> int:
        """Colab safety net (review #9 B4): copy publishable ckpts to Drive.

        No-op (0) off Colab. Drive fuse is slow — called on publish cadence
        (~30min), never per-epoch.
        """
        if self.drive_dir is None:
            return 0
        self.drive_dir.mkdir(parents=True, exist_ok=True)
        n = 0
        for pat in patterns:
            for f in sorted(self.local_dir.glob(pat)):
                shutil.copy2(f, self.drive_dir / f.name)
                n += 1
        return n
