"""Portable checkpoint locations (review #9 B5/B10, review #10).

Training writes checkpoints locally every epoch (unchanged — B7: do not
rewrite training for portability). This store resolves READS across platforms
(local → Google Drive → attached Kaggle Dataset) and syncs to Drive so a
Colab runtime death never loses more than one publish interval. Kaggle CLI
publish stays in the notebook's push_now(): prune + metadata + status belong
there, not here.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

__all__ = ["CheckpointStore"]

# review #10 P1: partial copies must never be discovered or returned
_PARTIAL = (".tmp", ".part", ".partial")


def _atomic_copy(src: Path, dst: Path) -> None:
    """review #10 P1: copy to <name>.tmp, then os.replace — a runtime death
    mid-copy never leaves a truncated file at the destination path (local or
    Drive), and discovery never sees the .tmp (patterns end in .pt + guard)."""
    tmp = dst.with_name(dst.name + ".tmp")
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


class CheckpointStore:
    """Resolve latest/best checkpoints on Kaggle or Colab.

    Selection (review #10 P0): ALL candidates across local/Drive/attached are
    collected, metadata is read (global_step, epoch), unreadable/partial
    files are discarded, and the winner is the highest (global_step, epoch,
    name) with a deterministic location tie-break (local > Drive > attached).
    Location never decides — a stale local copy cannot shadow a newer Drive
    checkpoint. The winner is copy-in'd atomically into local_dir so
    anything that publishes local_dir (push_now) contains the checkpoint
    selection picked.
    """

    def __init__(self, local_dir, *, attached_dir=None, drive_dir=None):
        self.local_dir = Path(local_dir)
        self.attached_dir = Path(attached_dir) if attached_dir else None
        self.drive_dir = Path(drive_dir) if drive_dir else None

    def glob(self, pat: str) -> list[Path]:
        """Candidates ordered ascending by metadata — result[-1] is the
        winner: highest (global_step, epoch, name, location rank). Returns []
        when nothing readable matches. Winner found outside local_dir is
        copied in (atomic), so callers see it at [-1] under local_dir."""
        import torch

        scored = []
        for rank, d in enumerate((self.local_dir, self.drive_dir, self.attached_dir)):
            if d is None or not d.is_dir():
                continue
            for p in sorted(d.glob(pat)):
                if p.name.endswith(_PARTIAL):
                    continue
                try:
                    ck = torch.load(p, map_location="cpu", weights_only=False)
                    key = (int(ck.get("global_step", 0)), int(ck.get("epoch", -1)),
                           p.name, rank)
                except Exception as e:  # corrupt/unreadable — discard, not crash
                    print(f"checkpoint_store: skipping unreadable {p}: {e}")
                    continue
                scored.append((key, p))
        if not scored:
            return []
        scored.sort(key=lambda t: t[0])
        ordered = [p for _, p in scored]
        winner = ordered[-1]
        if winner.parent != self.local_dir:
            self.local_dir.mkdir(parents=True, exist_ok=True)
            dst = self.local_dir / winner.name
            _atomic_copy(winner, dst)
            ordered[-1] = dst
        return ordered

    def sync_to_drive(self, patterns: tuple[str, ...] = ("latest_*.pt", "best_*.pt")) -> int:
        """Colab safety net (review #9 B4): copy publishable ckpts to Drive.

        No-op (0) off Colab. Drive fuse is slow — called on publish cadence
        (~30min), never per-epoch. Atomic (review #10 P1).
        """
        if self.drive_dir is None:
            return 0
        self.drive_dir.mkdir(parents=True, exist_ok=True)
        n = 0
        for pat in patterns:
            for f in sorted(self.local_dir.glob(pat)):
                _atomic_copy(f, self.drive_dir / f.name)
                n += 1
        return n
