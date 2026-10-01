from __future__ import annotations

import pytest
import torch
import torch.nn as nn

from airhythm import config
from airhythm.train import (
    build_metronome_data,
    compute_pos_weight_candidate,
    evaluate_gate,
    predicted_positive_rate,
    rate_breach,
    run_toy_overfit_gate,
    run_training_slice,
    stability_probe,
    train_epoch,
    tripwire_breached,
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


class TestLoopSmoke:
    def test_scheduler_patience_and_factor(self):
        p = torch.nn.Parameter(torch.zeros(1))
        opt = torch.optim.Adam([p], lr=config.TRAIN_LR)
        sch = torch.optim.lr_scheduler.ReduceLROnPlateau(
            opt, mode="min",
            patience=config.SCHED_PATIENCE, factor=config.SCHED_FACTOR,
        )
        assert sch.patience == 3
        assert sch.factor == 0.5
        sch.step(1.0)
        assert opt.param_groups[0]["lr"] == pytest.approx(1e-3)
        for _ in range(3):
            sch.step(1.0)
        assert opt.param_groups[0]["lr"] == pytest.approx(1e-3)
        sch.step(1.0)
        assert opt.param_groups[0]["lr"] == pytest.approx(5e-4)

    def test_smoke_2_toys_3_epochs_loss_finite_decreasing(self):
        from airhythm.model import AIRhythmCRNN

        torch.manual_seed(0)
        device = torch.device("cpu")
        data, rate = build_metronome_data(2, device=device)
        assert len(data) == 2
        for mel, y in data:
            assert mel.shape == (1, 1, 128, 400)
            assert y.dtype == torch.float32
        assert 0 < rate < 0.1
        model = AIRhythmCRNN()
        criterion = torch.nn.BCEWithLogitsLoss(
            pos_weight=torch.tensor([39.0], dtype=torch.float32)
        )
        optimizer = torch.optim.AdamW(
            model.parameters(), lr=config.TRAIN_LR, weight_decay=config.TRAIN_WD
        )
        losses = [train_epoch(model, data, criterion, optimizer, device=device)
                  for _ in range(3)]
        assert all(torch.isfinite(torch.tensor(v)) for v in losses)
        assert losses[2] < losses[0]


class TestGate:
    @staticmethod
    def _vec(idxs, n=400):
        t = torch.zeros(n)
        t[list(idxs)] = 1.0
        return t

    def test_perfect_preds_pass(self):
        targets = self._vec(range(0, 400, 50))
        p, r, passed = evaluate_gate(targets, targets)
        assert p == pytest.approx(1.0)
        assert r == pytest.approx(1.0)
        assert passed is True

    def test_all_zeros_fail(self):
        targets = self._vec(range(0, 400, 50))
        p, r, passed = evaluate_gate(torch.zeros(400), targets)
        assert r == 0.0
        assert passed is False

    def test_shifted_preds_fail(self):
        targets = self._vec(range(0, 400, 50))
        preds = torch.roll(targets, 5)
        assert evaluate_gate(preds, targets)[2] is False

    def test_all_ones_fail_low_precision(self):
        targets = self._vec(range(0, 400, 50))
        p, r, passed = evaluate_gate(torch.ones(400), targets)
        assert p == pytest.approx(8 / 400)
        assert passed is False


class TestTripwire:
    def test_cold_start_never_halts(self):
        assert tripwire_breached([(0.5, 0.03)] * 10) == (False, 0)

    def test_sustained_breach_halts(self):
        assert tripwire_breached([(0.5, 0.03)] * 13) == (True, 3)

    def test_single_breach_resets(self):
        hist = [(0.03, 0.03)] * 10 + [(0.001, 0.03), (0.03, 0.03), (0.03, 0.03)]
        assert tripwire_breached(hist) == (False, 0)

    def test_low_tail_breach_halts(self):
        hist = [(0.03, 0.03)] * 10 + [(0.001, 0.03)] * 3
        assert tripwire_breached(hist) == (True, 3)

    def test_gate_smoke_one_epoch(self):
        from airhythm.model import AIRhythmCRNN

        torch.manual_seed(0)
        device = torch.device("cpu")
        data, _ = build_metronome_data(2, device=device)
        out = run_toy_overfit_gate(
            AIRhythmCRNN(), data, device=device, pos_weight=39.0, max_epochs=1
        )
        for key in ("passed", "precision", "recall", "epoch", "pred_rate",
                    "true_rate", "final_loss", "halted", "halt_reason",
                    "optimizer", "scheduler"):
            assert key in out
