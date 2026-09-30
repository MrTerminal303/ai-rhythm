"""CRNN backbone + onset head (PLAN.md STAGE 1 M1 spec, Phase 6 / D-01).

Input:  (batch, 1, 128, 400) mel spectrogram chunk
Output: (batch, 400, 1) per-frame onset LOGITS (no sigmoid; BCEWithLogitsLoss in Phase 7)
"""
from __future__ import annotations

import torch
import torch.nn as nn

__all__ = ["AIRhythmCRNN", "alignment_delta"]


class AIRhythmCRNN(nn.Module):
    """CRNN backbone + onset head. In (B,1,128,400) -> out (B,400,1) logits."""

    def __init__(self):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(1, 16, 3, padding=1), nn.BatchNorm2d(16), nn.ReLU(), nn.MaxPool2d((2, 1)),
            nn.Conv2d(16, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(), nn.MaxPool2d((2, 1)),
            nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(), nn.MaxPool2d((2, 1)),
        )  # freq 128->64->32->16, time stays 400 (stride defaults to kernel)
        self.proj = nn.Linear(1024, 128)
        self.gru = nn.GRU(128, 128, num_layers=1, batch_first=True, bidirectional=True)
        self.head = nn.Linear(256, 1)  # logits, no sigmoid (BCEWithLogitsLoss later)

    def forward(self, x):
        f = self.conv(x)                        # (B,64,16,400)
        f = f.permute(0, 3, 1, 2)               # (B,400,64,16) — assign FIRST
        f = f.reshape(f.size(0), f.size(1), -1) # (B,400,1024) — size from permuted f, NOT pre-permute x
        f = self.proj(f)                        # (B,400,128)
        g, _ = self.gru(f)                      # (B,400,256)
        return self.head(g)                     # (B,400,1)


def alignment_delta(model: nn.Module, t0: int, *, impulse: bool = True) -> int:
    """Gradient-alignment offset: argmax|dL/d(conv1_out)| over time minus t0.

    MOD-02 / PLAN.md Verification 2 (D-05): dummy loss = out[0, t0, 0] ** 2,
    gradient measured at the FIRST CONV LAYER output (nn.Sequential index 0)
    via forward hook + retain_grad() — literal D-05 wording.

    impulse=True (default): full freq column at t0 (D-01 spec / PLAN.md 123).
    impulse=False: all-zero input — the crisp variant (verified seeds 0-4:
    deltas [0,0,0,0,0] vs impulse [1,0,1,2,1]; impulse adds ±2 ReLU-gating
    jitter, which is why the impulse tolerance is 2 and zeros tolerance is 1).

    Weights are pinned by the caller's seed-BEFORE-construction — a seed
    inside this function does nothing (model already built; eval forward uses
    no RNG). Eval mode for measurement, caller's mode restored. CPU-only:
    cuDNN GRU backward raises in eval mode on CUDA.
    """
    assert next(model.parameters()).device.type == "cpu", \
        "alignment_delta must run on CPU (cuDNN GRU eval-backward raises on CUDA)"
    was_training = model.training
    model.eval()                       # freeze BN running stats
    model.zero_grad(set_to_none=True)
    captured: dict = {}

    def grab(_m, _inp, out):           # CRITICAL (review fix): must return None, or the
        out.retain_grad()              # layer's output is REPLACED by this tuple
        captured["o"] = out            # and the next layer receives (None, None)

    h = model.conv[0].register_forward_hook(grab)
    try:
        x = torch.zeros(1, 1, 128, 400)
        if impulse:
            x[0, 0, :, t0] = 10.0      # impulse: full freq column at frame t0
        out = model(x)                 # grad-enabled context — NEVER torch.no_grad (Pitfall: x/conv grad stays None)
        (out[0, t0, 0] ** 2).backward()  # dummy loss on frame-t0 logit only
        g = captured["o"].grad.abs().sum(dim=(0, 1, 2))  # conv[0] out (1,16,128,400) -> (400,)
    finally:
        h.remove()
        model.train(was_training)      # restore caller's mode (review fix)
        model.zero_grad(set_to_none=True)  # leave no .grad on params (review nit)
    return int(g.argmax()) - t0
