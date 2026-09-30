from __future__ import annotations

import pytest
import torch
import torch.nn as nn

from airhythm import config
from airhythm.model import AIRhythmCRNN, alignment_delta


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


class _Shifted(AIRhythmCRNN):   # mutant: deliberate 10-frame shift (round-2 blocker)
    """Gate-teeth check: a model that shifts frames MUST fail the delta assert.
    Shift is 10, not 3 — at the conv[0] hook the gradient argmax has ±2 RF
    spread under impulse input, so a 3-frame shift can yield |delta| <= 2 and flake."""
    def forward(self, x):
        f = torch.roll(self.conv(x).permute(0, 3, 1, 2), 10, dims=1)
        f = f.reshape(f.size(0), f.size(1), -1)
        g, _ = self.gru(self.proj(f))
        return self.head(g)


class _Shifted3(AIRhythmCRNN):  # mutant for the ZEROS variant (round-4)
    """Zeros input has crisp argmax (no ReLU-gating jitter), so roll 3 is
    detectable at tol 1 — verified: zeros+roll3 delta = -3 on seeds 0-4."""
    def forward(self, x):
        f = torch.roll(self.conv(x).permute(0, 3, 1, 2), 3, dims=1)
        f = f.reshape(f.size(0), f.size(1), -1)
        g, _ = self.gru(self.proj(f))
        return self.head(g)


class TestGradientAlignment:
    """MOD-02 core: impulse at 200 -> abs(argmax-200) <= 2, literal bool (D-05).
    Tolerance 2 == RF half-width at conv[0]; seeds 0-4 SAMPLE initializations —
    a single seed is fragile because pass/fail depends on seed plus torch
    version (local 2.13 vs Kaggle). The mutant test is what gives this gate meaning."""

    @pytest.mark.parametrize("seed", range(5))
    def test_real_model_aligned(self, seed):
        torch.manual_seed(seed)
        delta = alignment_delta(AIRhythmCRNN(), 200)
        print(f"seed={seed} delta@200={delta}")    # print actual deltas (review fix)
        assert abs(delta) <= 2, f"Alignment fail: seed={seed} delta={delta} (target=200, tol=2)"

    @pytest.mark.parametrize("seed", range(5))
    def test_gate_detects_shift(self, seed):
        """Mutant (roll 10) must FAIL for every seed — gate has teeth."""
        torch.manual_seed(seed)
        delta = alignment_delta(_Shifted(), 200)
        print(f"seed={seed} mutant delta={delta}")
        assert abs(delta) > 2, f"Gate has no teeth: seed={seed} mutant delta={delta} passed tol<=2"


class TestGradientAlignmentZeros:
    """Zeros-input variant (round-4): no ReLU-gating jitter → tol ≤ 1
    (not == 0 — BiGRU asymmetric in time). Evidence: zeros deltas [0,0,0,0,0]
    and zeros+roll3 [-3]*5 on seeds 0-4 (verified at plan time)."""

    @pytest.mark.parametrize("seed", range(5))
    def test_real_model_aligned_zeros(self, seed):
        torch.manual_seed(seed)
        delta = alignment_delta(AIRhythmCRNN(), 200, impulse=False)
        print(f"seed={seed} zeros delta@200={delta}")
        assert abs(delta) <= 1, f"Zeros alignment fail: seed={seed} delta={delta} (tol=1)"

    @pytest.mark.parametrize("seed", range(5))
    def test_zeros_gate_detects_shift3(self, seed):
        """roll-3 mutant must fail the ≤1 zeros gate (crisp argmax makes 3 detectable)."""
        torch.manual_seed(seed)
        delta = alignment_delta(_Shifted3(), 200, impulse=False)
        print(f"seed={seed} zeros roll3 delta={delta}")
        assert abs(delta) > 1, f"Zeros gate has no teeth: seed={seed} roll3 delta={delta}"


class TestTranslationAlignment:
    """MOD-02 companion: constant delta across positions (D-06), seeds 0-4
    (round-3: seed-0-only spread check was weak).

    Cheap regression guard, NOT independent evidence: pools are (2,1) stride 1,
    so Zhang-style time aliasing cannot occur and the MaxPool assert already
    guards that regression. Kept because it's cheap. BiGRU starts from zero
    state at chunk edges; 50/200/350 never probe that — keep overlapping-window
    inference in Phase 7+ (review note).
    """

    @pytest.mark.parametrize("seed", range(5))
    def test_delta_constant_across_positions(self, seed):
        torch.manual_seed(seed)
        model = AIRhythmCRNN()
        deltas = [alignment_delta(model, t0) for t0 in (50, 200, 350)]
        print(f"seed={seed} deltas={deltas}")   # print actual deltas (visible with -s)
        assert all(abs(d) <= 2 for d in deltas), f"Deltas out of tolerance: seed={seed} {deltas}"
        # spread check, NOT len(set)==1 — argmax near-ties flip on numerics (review fix)
        assert max(deltas) - min(deltas) <= 1, f"Delta not constant: seed={seed} {deltas}"
