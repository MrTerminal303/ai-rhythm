from __future__ import annotations

import pytest
import torch
import torch.nn as nn

from airhythm import config
from airhythm.train import (
    compute_pos_weight_candidate,
    rate_breach,
    run_training_slice,
    stability_probe,
)


class TestPosWeight:
    def test_candidate_25_of_1000(self):
        labels = torch.zeros(1000)
        labels[:25] = 1.0
        assert compute_pos_weight_candidate(labels) == pytest.approx(39.0)

    def test_candidate_8_of_400(self):
        labels = torch.zeros(400)
        labels[:8] = 1.0
        assert compute_pos_weight_candidate(labels) == pytest.approx(49.0)

    def test_candidate_all_zeros_raises(self):
        with pytest.raises(ValueError):
            compute_pos_weight_candidate(torch.zeros(400))


class TestStability:
    def test_halves_to_oracle_boundary(self):
        w, halvings = stability_probe(lambda w: w <= 64.0, 1024.0)
        assert w == pytest.approx(64.0)
        assert halvings == 4

    def test_stable_candidate_no_halving(self):
        w, halvings = stability_probe(lambda w: True, 39.0)
        assert w == pytest.approx(39.0)
        assert halvings == 0

    def test_always_false_terminates_at_floor(self):
        w, _ = stability_probe(lambda w: False, 39.0, floor=1.0)
        assert w <= 1.0

    def test_run_training_slice_bool_no_crash(self):
        class FakeModel(nn.Module):
            def __init__(self):
                super().__init__()
                self.dummy = nn.Parameter(torch.zeros(1))

            def forward(self, x):
                return torch.zeros(x.size(0), 400, 1) + self.dummy

        device = torch.device("cpu")
        data = [
            (torch.randn(1, 1, 128, 400), torch.zeros(400))
            for _ in range(2)
        ]
        assert isinstance(
            run_training_slice(FakeModel(), data, 39.0, device=device), bool
        )
        assert isinstance(
            run_training_slice(FakeModel(), data, 1e6, device=device), bool
        )


class TestDegeneracy:
    def test_low_tail(self):
        assert rate_breach(0.001, 0.03) == "low"

    def test_high_tail(self):
        assert rate_breach(0.5, 0.03) == "high"

    def test_in_band(self):
        assert rate_breach(0.03, 0.03) is None

    def test_exact_bounds_not_breach(self):
        assert rate_breach(0.3 * 0.03, 0.03) is None
        assert rate_breach(3.0 * 0.03, 0.03) is None
