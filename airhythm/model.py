"""CRNN backbone + onset head (PLAN.md STAGE 1 M1 spec, Phase 6 / D-01).

Input:  (batch, 1, 128, 400) mel spectrogram chunk
Output: (batch, 400, 1) per-frame onset LOGITS (no sigmoid; BCEWithLogitsLoss in Phase 7)
"""
from __future__ import annotations

import torch
import torch.nn as nn

__all__ = ["AIRhythmCRNN"]


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
