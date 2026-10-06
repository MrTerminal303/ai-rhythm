"""Run identity + resume compatibility (review #9 B6/B8/B9).

RUN_META is stored inside checkpoints (train.save_checkpoint meta=...) using
LOGICAL identifiers only — no absolute paths, so a ckpt produced on Kaggle
resumes on Colab and vice versa. Resume validation FAILs loudly on corpus or
schema mismatch (B9); code_commit drift only warns (deviation: commit drift
is normal across dev cycles — a hard fail would block every iteration).
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path

from airhythm import config

__all__ = ["CHECKPOINT_SCHEMA", "build_run_meta", "verify_resume_compat"]

CHECKPOINT_SCHEMA = 1


def _short_commit() -> str:
    """Repo HEAD short sha, or "unknown" (mounted dataset has no .git)."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, check=True,
            cwd=Path(__file__).resolve().parent.parent,
        )
        return out.stdout.strip() or "unknown"
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return "unknown"


def build_run_meta(runtime_name: str, corpus_manifest: dict | None = None) -> dict:
    """Identity dict embedded in every checkpoint — logical ids only (B6)."""
    import torch
    import torchaudio

    user = os.environ.get("KAGGLE_USERNAME")
    corpus_version = None
    if corpus_manifest:
        corpus_version = corpus_manifest.get("corpus_version")
    return {
        "runtime": runtime_name,
        "code_commit": _short_commit(),
        "corpus_dataset": f"{user}/{config.CORPUS_HANDLE}" if user else config.CORPUS_HANDLE,
        "corpus_version": corpus_version,
        "checkpoint_schema": CHECKPOINT_SCHEMA,
        "torch": torch.__version__,
        "torchaudio": torchaudio.__version__,
        "cuda": torch.version.cuda,
        "python": platform.python_version() or sys.version.split()[0],
    }


def verify_resume_compat(
    ckpt_meta: dict | None,
    corpus_manifest: dict | None,
    *,
    where: str = "resume",
    current_commit: str | None = None,
) -> None:
    """Validate ckpt vs current state before training/eval continues (B9).

    Missing manifest/meta → loud print + skip (pre-portability ckpts).
    corpus_version or checkpoint_schema mismatch → AssertionError.
    code_commit drift → print notice only.
    """
    if corpus_manifest is None:
        print(f"[compat:{where}] no corpus manifest found — corpus check SKIPPED")
        return
    if not ckpt_meta:
        print(f"[compat:{where}] checkpoint has no meta (pre-review-#9) — compat checks SKIPPED")
        return

    ckpt_cv = ckpt_meta.get("corpus_version")
    cur_cv = corpus_manifest.get("corpus_version")
    if ckpt_cv is not None and cur_cv is not None:
        assert ckpt_cv == cur_cv, (
            f"[compat:{where}] corpus mismatch: ckpt={ckpt_cv} current={cur_cv} — "
            "refusing to continue from wrong state"
        )
    elif ckpt_cv is None or cur_cv is None:
        print(f"[compat:{where}] corpus_version unavailable (ckpt={ckpt_cv} current={cur_cv}) — corpus check SKIPPED")

    ckpt_schema = ckpt_meta.get("checkpoint_schema")
    if ckpt_schema is not None:
        assert ckpt_schema == CHECKPOINT_SCHEMA, (
            f"[compat:{where}] checkpoint_schema {ckpt_schema} != current {CHECKPOINT_SCHEMA}"
        )

    if current_commit is None:
        current_commit = _short_commit()
    ckpt_commit = ckpt_meta.get("code_commit")
    if ckpt_commit and current_commit and ckpt_commit != current_commit:
        print(f"[compat:{where}] code drift: ckpt={ckpt_commit} current={current_commit} (notice only)")
