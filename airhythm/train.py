"""Training probes + hand-written loop + toy overfit gate (Phase 7, TRN-01/02/03).

Notebook cells import these; no Trainer abstraction (TRN-02).
"""

from __future__ import annotations

from typing import Callable

import torch
import torch.nn as nn

from airhythm import config

__all__ = [
    "compute_pos_weight_candidate",
    "stability_probe",
    "run_training_slice",
    "rate_breach",
]


def compute_pos_weight_candidate(labels: torch.Tensor) -> float:
    """PLAN.md candidate: (1 - pos_frac) / pos_frac over ALL frames."""
    pos_frac = labels.float().mean().item()
    if pos_frac <= 0.0:
        raise ValueError("no positive frames — cannot derive pos_weight")
    return (1.0 - pos_frac) / pos_frac


def stability_probe(
    run_slice: Callable[[float], bool],
    raw_candidate: float,
    *,
    floor: float = 1.0,
    max_halvings: int = 32,
) -> tuple[float, int]:
    """D-01 halve-on-NaN decision loop. run_slice(w) -> True means the large slice
    finished with ALL losses finite. Returns (final_w, halvings)."""
    w, halvings = float(raw_candidate), 0
    while not run_slice(w) and w > floor and halvings < max_halvings:
        w /= 2.0
        halvings += 1
    return w, halvings


def run_training_slice(
    model: nn.Module,
    data: list,
    pos_weight: float,
    *,
    device,
    lr: float = config.TRAIN_LR,
    weight_decay: float = config.TRAIN_WD,
) -> bool:
    """D-01 large-slice trial: ONE FULL PASS over `data` (not 200 steps of one batch),
    fresh AdamW per call. True iff every step's loss is finite. On nonfinite loss:
    return False immediately (do NOT raise — probe semantics)."""
    model.train()
    criterion = nn.BCEWithLogitsLoss(
        pos_weight=torch.tensor([pos_weight], dtype=torch.float32, device=device)
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=lr, weight_decay=weight_decay
    )
    for mel, label in data:
        mel = mel.to(device)
        target = label.to(device).float().unsqueeze(0).unsqueeze(-1)
        out = model(mel)
        loss = criterion(out, target)
        if not torch.isfinite(loss):
            return False
        optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), config.GRAD_CLIP)
        optimizer.step()
    return True


def rate_breach(
    pred_rate: float,
    true_rate: float,
    *,
    low: float = config.RATE_LOW_MULT,
    high: float = config.RATE_HIGH_MULT,
) -> str | None:
    """TRN-01 degeneracy, BOTH tails (D-06). Strict inequalities at bounds."""
    if pred_rate < low * true_rate:
        return "low"
    if pred_rate > high * true_rate:
        return "high"
    return None
