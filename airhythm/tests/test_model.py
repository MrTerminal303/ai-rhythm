from __future__ import annotations

import pytest
import torch
import torch.nn as nn

from airhythm import config
from airhythm.model import AIRhythmCRNN


@pytest.fixture
def model():
    torch.manual_seed(0)        # seed BEFORE construction — this is what pins the weights
    return AIRhythmCRNN()


class TestShape:
    """MOD-01: out.shape == (2,400,1) on (2,1,128,400); T=800 also held."""

    def test_output_shape(self, model):
        out = model(torch.randn(2, 1, 128, 400))
        assert out.shape == (2, 400, 1), f"Wrong shape: {tuple(out.shape)}"

    def test_output_shape_t800(self, model):
        out = model(torch.randn(1, 1, 128, 800))   # Phase 9 ONNX dynamic axes + full-song inference
        assert out.shape == (1, 800, 1), f"Wrong shape at T=800: {tuple(out.shape)}"

    def test_maxpool_freq_only_time_stays_400(self, model):
        pools = [m for m in model.modules() if isinstance(m, nn.MaxPool2d)]
        assert len(pools) == 3, f"Expected 3 MaxPool2d, got {len(pools)}"
        assert all(m.kernel_size == (2, 1) for m in pools), \
            f"MaxPool must be freq-only (2,1): {[m.kernel_size for m in pools]}"
        out_t, out_f = [], []

        def _record(_m, _i, o):   # CRITICAL (review fix): must return None —
            out_t.append(o.shape[3])  # a tuple return REPLACES the layer output
            out_f.append(o.shape[2])  # and the next layer receives (None, None)

        handles = [p.register_forward_hook(_record) for p in pools]
        model.eval()
        model(torch.zeros(1, 1, 128, 400))
        for h in handles:
            h.remove()
        assert out_t == [400, 400, 400], f"Time axis changed at a pool: {out_t}"
        assert out_f == [64, 32, 16], f"Freq downsampling wrong: {out_f}"


class TestParamCeiling:
    """D-01 layers locked => exactly 353,121 params; D-03 ceiling 400,000
    enforced here too (round-3 review: the separate test_ceiling was dead,
    but the assert itself is the ONLY automated enforcement of PARAM_CEILING
    — CELL 10 is just the record)."""

    def test_exact_m1_param_count(self, model):
        n = sum(p.numel() for p in model.parameters())
        assert n == 353_121, f"M1 spec must be exactly 353_121 params, got {n}"
        assert n <= config.PARAM_CEILING, f"{n} > PARAM_CEILING {config.PARAM_CEILING}"
