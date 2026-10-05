from __future__ import annotations

import random
from pathlib import Path

import pytest
import torch
import torch.nn as nn

from airhythm import config
from airhythm.train import (
    build_metronome_data,
    build_real_loaders,
    compute_pos_weight_candidate,
    epoch_cap,
    evaluate_gate,
    load_checkpoint,
    median_epoch_time,
    predicted_positive_rate,
    rate_breach,
    resume_smoke_test,
    run_real_training,
    run_toy_overfit_gate,
    run_training_slice,
    save_checkpoint,
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


class TestCheckpointRoundtrip:
    @staticmethod
    def _opt_sched(model):
        opt = torch.optim.AdamW(model.parameters(), lr=config.TRAIN_LR)
        sch = torch.optim.lr_scheduler.ReduceLROnPlateau(
            opt, mode="min",
            patience=config.SCHED_PATIENCE, factor=config.SCHED_FACTOR,
        )
        return opt, sch

    def test_key_set(self, tmp_path):
        from airhythm.model import AIRhythmCRNN

        model = AIRhythmCRNN()
        opt, sch = self._opt_sched(model)
        p = tmp_path / "latest_test.pt"
        state = save_checkpoint(
            str(p), model=model, optimizer=opt, scheduler=sch,
            epoch=7, global_step=123, val_metric=0.42,
            stage="phase8_real", pos_weight=36.4,
        )
        keys = set(state.keys())
        expected = {
            "model", "optimizer", "scheduler", "epoch", "global_step",
            "val_metric", "stage", "torch_rng", "random_rng", "pos_weight",
        }
        if torch.cuda.is_available():
            assert keys == expected | {"cuda_rng"}
        else:
            assert keys == expected

    def test_scheduler_countdown(self, tmp_path):
        from airhythm.model import AIRhythmCRNN

        model = AIRhythmCRNN()
        opt, sch = self._opt_sched(model)
        for v in (0.5, 0.6, 0.7):
            sch.step(v)
        assert sch.state_dict()["num_bad_epochs"] == 2
        best = sch.state_dict()["best"]
        p = tmp_path / "latest_sched.pt"
        save_checkpoint(
            str(p), model=model, optimizer=opt, scheduler=sch,
            epoch=7, global_step=123, val_metric=0.5,
            stage="phase8_real", pos_weight=36.4,
        )
        model2 = AIRhythmCRNN()
        opt2, sch2 = self._opt_sched(model2)
        load_checkpoint(str(p), model=model2, optimizer=opt2,
                        scheduler=sch2)
        assert sch2.state_dict()["num_bad_epochs"] == 2
        assert sch2.state_dict()["best"] == best

    def test_rng_restore(self, tmp_path):
        from airhythm.model import AIRhythmCRNN

        model = AIRhythmCRNN()
        opt, sch = self._opt_sched(model)
        p = tmp_path / "latest_rng.pt"
        save_checkpoint(
            str(p), model=model, optimizer=opt, scheduler=sch,
            epoch=7, global_step=123, val_metric=0.42,
            stage="phase8_real", pos_weight=36.4,
        )
        recorded = (random.random(), torch.rand(1).tolist())
        random.seed(1)
        torch.manual_seed(1)
        load_checkpoint(str(p), model=model, optimizer=opt, scheduler=sch)
        assert (random.random(), torch.rand(1).tolist()) == recorded

    def test_value_restore_and_stdout(self, tmp_path, capsys):
        from airhythm.model import AIRhythmCRNN

        model = AIRhythmCRNN()
        opt, sch = self._opt_sched(model)
        src = dict(model.state_dict())
        p = tmp_path / "latest_val.pt"
        save_checkpoint(
            str(p), model=model, optimizer=opt, scheduler=sch,
            epoch=7, global_step=123, val_metric=0.42,
            stage="phase8_real", pos_weight=36.4,
        )
        model2 = AIRhythmCRNN()
        opt2, sch2 = self._opt_sched(model2)
        ckpt = load_checkpoint(str(p), model=model2, optimizer=opt2,
                               scheduler=sch2)
        assert ckpt["epoch"] == 7
        assert ckpt["global_step"] == 123
        assert ckpt["pos_weight"] == 36.4
        name = next(iter(src))
        assert torch.equal(model2.state_dict()[name], src[name])
        assert "resume: epoch=7" in capsys.readouterr().out


class TestResumeSmoke:
    def test_pass_matches_within_tolerance(self):
        out = resume_smoke_test()
        assert out["pass"] is True
        assert abs(out["loss_4_resumed"] - out["loss_4_fresh"]) < 1e-6

    def test_mutant_skipped_rng_restore_fails(self):
        """Teeth: skipping the RNG restore (the bug this plan guards) must
        flip pass to False or push loss diff >= tolerance."""
        from airhythm.train import _smoke_impl

        out = _smoke_impl(_skip_rng_restore=True)
        assert out["pass"] is False or abs(
            out["loss_4_resumed"] - out["loss_4_fresh"]
        ) >= 1e-6

    def test_fast(self):
        import time

        t0 = time.monotonic()
        resume_smoke_test()
        assert time.monotonic() - t0 < 30.0


class TestEarlyStop:
    """D-08: early stop after `patience` consecutive non-improving val losses."""

    @staticmethod
    def _run(tmp_path, monkeypatch, losses, *, max_epochs, patience):
        monkeypatch.setattr("airhythm.train.train_epoch", lambda *a, **k: 0.5)
        seq = iter(losses)
        device = torch.device("cpu")
        data, _ = build_metronome_data(2, device=device)
        return run_real_training(
            data, data[:1], pos_weight=39.0, device=device,
            ckpt_dir=str(tmp_path), max_epochs=max_epochs, patience=patience,
            _val_fn=lambda: next(seq),
        )

    def test_halts_after_patience_non_improving(self, tmp_path, monkeypatch):
        out = self._run(tmp_path, monkeypatch,
                        [1.0, 0.9, 0.9, 0.9, 0.9],
                        max_epochs=10, patience=3)
        assert out["stopped_reason"] == "early_stop"
        assert len(out["history"]) == 5
        assert out["best_epoch"] == 2

    def test_improving_never_early_stops(self, tmp_path, monkeypatch):
        out = self._run(tmp_path, monkeypatch,
                        [1.0, 0.9, 0.8, 0.7, 0.6],
                        max_epochs=5, patience=3)
        assert out["stopped_reason"] == "max_epochs"
        assert len(out["history"]) == 5
        assert out["best_epoch"] == 5


class TestBestValLoss:
    """D-08 teeth: lowest val loss selects best; improving frame-F ignored (D-04)."""

    def test_loss_selects_frame_f_ignored(self, tmp_path, monkeypatch):
        from airhythm.model import AIRhythmCRNN

        monkeypatch.setattr("airhythm.train.train_epoch", lambda *a, **k: 0.5)
        fseq = iter([0.30, 0.90])
        monkeypatch.setattr(
            "airhythm.train.evaluate_gate",
            lambda *a, **k: (0.5, next(fseq), True),
        )
        seq = iter([0.50, 0.55])
        device = torch.device("cpu")
        data, _ = build_metronome_data(1, device=device)
        out = run_real_training(
            data, data, pos_weight=39.0, device=device,
            ckpt_dir=str(tmp_path), max_epochs=2, patience=100,
            _val_fn=lambda: next(seq),
        )
        # frame-F improves 0.30 -> 0.90 while val loss worsens 0.50 -> 0.55;
        # loss rules: best stays at epoch 1.
        assert out["history"][0]["val_frame_f"] == pytest.approx(0.30)
        assert out["history"][1]["val_frame_f"] == pytest.approx(0.90)
        assert out["best_epoch"] == 1
        assert out["best_val_loss"] == pytest.approx(0.50)
        model = AIRhythmCRNN()
        opt = torch.optim.AdamW(model.parameters(), lr=config.TRAIN_LR)
        sch = torch.optim.lr_scheduler.ReduceLROnPlateau(
            opt, mode="min", patience=config.SCHED_PATIENCE,
            factor=config.SCHED_FACTOR,
        )
        ckpt = load_checkpoint(str(tmp_path / "best_phase8_real.pt"),
                               model=model, optimizer=opt, scheduler=sch)
        assert ckpt["epoch"] == 1


class TestEpochCap:
    def test_floor_budget_and_median(self):
        assert config.EARLY_STOP_PATIENCE == 10
        assert config.EPOCH_CAP_HOURS == 45.0
        assert config.EPOCH_CAP_FLOOR == 10
        assert epoch_cap(1.0, 45.0) == 45
        assert epoch_cap(6.0, 90.0) == 15  # floor does not bind
        assert epoch_cap(6.0) == config.EPOCH_CAP_FLOOR  # 45/6=7 < floor 10
        assert epoch_cap(100.0) == config.EPOCH_CAP_FLOOR

    def test_median_discards_warmup(self):
        assert median_epoch_time([99.0, 10.0, 12.0, 11.0]) == 11.0
        assert median_epoch_time([5.0]) == 5.0
        with pytest.raises(ValueError):
            median_epoch_time([])


class TestRealTrainingSmoke:
    def test_two_epochs_writes_checkpoints(self, tmp_path):
        from torch.utils.data import DataLoader

        from airhythm.model import AIRhythmCRNN

        device = torch.device("cpu")
        data, _ = build_metronome_data(2, device=device)
        # real (non-injected) val branch expects DataLoader batches shaped like
        # build_real_loaders output: mel (B,1,128,400), label (B,400).
        # Metronome items carry an extra leading dim — squeeze to dataset shape.
        val_items = [(m.squeeze(0), y) for m, y in data]
        val_loader = DataLoader(val_items, batch_size=1, shuffle=False)
        out = run_real_training(
            data, val_loader, pos_weight=39.0, device=device,
            ckpt_dir=str(tmp_path), max_epochs=2, patience=5,
        )
        assert out["stopped_reason"] == "max_epochs"
        assert len(out["history"]) == 2
        assert all("val_frame_f" in h for h in out["history"])
        assert all(torch.isfinite(torch.tensor(h["val_loss"]))
                   for h in out["history"])
        latest = tmp_path / "latest_phase8_real.pt"
        best = tmp_path / "best_phase8_real.pt"
        assert latest.exists()
        assert best.exists()
        model = AIRhythmCRNN()
        opt = torch.optim.AdamW(model.parameters(), lr=config.TRAIN_LR)
        sch = torch.optim.lr_scheduler.ReduceLROnPlateau(
            opt, mode="min", patience=config.SCHED_PATIENCE,
            factor=config.SCHED_FACTOR,
        )
        ckpt = load_checkpoint(str(latest), model=model, optimizer=opt,
                               scheduler=sch)
        assert ckpt["epoch"] == 2


class TestCorpusExclusion:
    """D-06: all 5 eval + 1 search IDs excluded from train/val; audit line printed."""

    EVAL_IDS = [2255671, 2256944, 2516285, 2527391, 2589624]
    SEARCH_ID = 2561773

    def test_real_dirs_split_and_print(self, capsys):
        dirs = sorted(p for p in Path("data/minimal_dataset").iterdir()
                      if p.is_dir())
        assert len(dirs) == 12
        _train_loader, _val_loader, info = build_real_loaders(
            dirs, eval_ids=self.EVAL_IDS, search_id=self.SEARCH_ID,
            batch_size=4,
        )
        frozen = set(self.EVAL_IDS) | {self.SEARCH_ID}
        assert set(info["excluded"]) == frozen
        used = set(info["train_ids"]) | set(info["val_ids"])
        assert not (used & frozen)
        assert not (set(info["train_ids"]) & set(info["val_ids"]))
        assert len(info["train_ids"]) >= 4
        assert len(info["val_ids"]) >= 1
        assert "corpus: train=" in capsys.readouterr().out


class TestTripwireWiring:
    """D-06: tripwire halts first — before early-stop could ever fire."""

    def test_tripwire_halts_before_early_stop(self, tmp_path, monkeypatch):
        monkeypatch.setattr("airhythm.train.train_epoch", lambda *a, **k: 0.5)
        monkeypatch.setattr("airhythm.train.predicted_positive_rate",
                            lambda *a, **k: 0.9)
        device = torch.device("cpu")
        data, _ = build_metronome_data(1, device=device)
        out = run_real_training(
            data, data, pos_weight=39.0, device=device,
            ckpt_dir=str(tmp_path), max_epochs=20, patience=100,
            _val_fn=lambda: 1.0,
        )
        # grace 10 + 3 consecutive post-grace breaches -> halt at epoch 13
        assert out["stopped_reason"] == "tripwire: 3 consecutive breaches"
        assert len(out["history"]) == 13
        assert out["best_epoch"] == 1


class TestDeterminism:
    def test_same_seed_same_first_batch(self):
        dirs = sorted(p for p in Path("data/minimal_dataset").iterdir()
                      if p.is_dir())
        eval_ids = [2255671, 2256944, 2516285, 2527391, 2589624]
        la, _, _ = build_real_loaders(dirs, eval_ids=eval_ids,
                                      search_id=2561773, batch_size=4, seed=0)
        lb, _, _ = build_real_loaders(dirs, eval_ids=eval_ids,
                                      search_id=2561773, batch_size=4, seed=0)
        torch.manual_seed(0)
        m1, y1 = next(iter(la))
        torch.manual_seed(0)
        m2, y2 = next(iter(lb))
        assert torch.equal(m1, m2)
        assert torch.equal(y1, y2)


class TestRealLoaderLoop:
    """Production wiring: build_real_loaders output feeds run_real_training
    end-to-end (onset-row collate + cat-label contract, one real epoch)."""

    def test_one_real_epoch(self, tmp_path):
        device = torch.device("cpu")
        dirs = sorted(p for p in Path("data/minimal_dataset").iterdir()
                      if p.is_dir())
        train_loader, val_loader, _info = build_real_loaders(
            dirs, eval_ids=[2255671, 2256944, 2516285, 2527391, 2589624],
            search_id=2561773, batch_size=4)
        out = run_real_training(
            train_loader, val_loader, pos_weight=39.0, device=device,
            ckpt_dir=str(tmp_path), max_epochs=1, patience=5)
        assert out["stopped_reason"] == "max_epochs"
        assert torch.isfinite(torch.tensor(out["history"][0]["train_loss"]))
        assert torch.isfinite(torch.tensor(out["history"][0]["val_loss"]))
        assert (tmp_path / "latest_phase8_real.pt").exists()

class TestResumeContinuation:
    """08-06 (D-11): run_real_training resume extension — start_epoch/global_step seed,
    caller-supplied model/optimizer/scheduler, best_val from ckpt, on_epoch_end hook."""

    def test_continued_run_advances_global_step(self, tmp_path):
        from airhythm.model import AIRhythmCRNN

        device = torch.device("cpu")
        dirs = sorted(p for p in Path("data/minimal_dataset").iterdir() if p.is_dir())
        train_loader, val_loader, _ = build_real_loaders(
            dirs, eval_ids=[2255671, 2256944, 2516285, 2527391, 2589624],
            search_id=2561773, batch_size=4)
        out1 = run_real_training(
            train_loader, val_loader, pos_weight=39.0, device=device,
            ckpt_dir=str(tmp_path), max_epochs=1, patience=5)
        assert out1["stopped_reason"] == "max_epochs"

        # resume: load local ckpt (D-11) into fresh objects, continue numbering
        model = AIRhythmCRNN()
        optimizer = torch.optim.AdamW(model.parameters(), lr=config.TRAIN_LR,
                                      weight_decay=config.TRAIN_WD)
        scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
            optimizer, mode="min", patience=config.SCHED_PATIENCE,
            factor=config.SCHED_FACTOR)
        ckpt = load_checkpoint(str(tmp_path / "latest_phase8_real.pt"),
                               model=model, optimizer=optimizer,
                               scheduler=scheduler, device=device)
        seen_epochs = []
        out2 = run_real_training(
            train_loader, val_loader, pos_weight=39.0, device=device,
            ckpt_dir=str(tmp_path), max_epochs=2, patience=5,
            start_epoch=ckpt["epoch"], global_step=ckpt["global_step"],
            model=model, optimizer=optimizer, scheduler=scheduler,
            best_val=ckpt["val_metric"],
            on_epoch_end=lambda e, times: seen_epochs.append(e))
        assert out2["history"][0]["epoch"] == ckpt["epoch"] + 1
        assert out2["global_step"] > ckpt["global_step"]
        assert out2["stopped_reason"] == "max_epochs"
        assert seen_epochs == [ckpt["epoch"] + 1]


class TestPerBatchSteps:
    """Review P0 regression gates: ONE optimizer.step per batch (old code cat'ed
    the whole loader -> one step/epoch, one pass for mels + second pass for labels
    misaligned under shuffle=True)."""

    @staticmethod
    def _items(n=5):
        torch.manual_seed(0)
        return [(torch.randn(1, 1, 128, 400), torch.zeros(400)) for _ in range(n)]

    def test_one_step_per_item(self):
        from airhythm.model import AIRhythmCRNN

        model = AIRhythmCRNN()
        opt = torch.optim.AdamW(model.parameters(), lr=config.TRAIN_LR)
        steps = {"n": 0}
        orig_step = opt.step

        def counting_step(*a, **k):
            steps["n"] += 1
            return orig_step(*a, **k)

        opt.step = counting_step
        crit = torch.nn.BCEWithLogitsLoss(pos_weight=torch.tensor([36.4]))
        loss = train_epoch(model, self._items(5), crit, opt, device="cpu")
        assert steps["n"] == 5
        assert torch.isfinite(torch.tensor(loss))

    def test_empty_data_raises(self):
        from airhythm.model import AIRhythmCRNN

        model = AIRhythmCRNN()
        opt = torch.optim.AdamW(model.parameters(), lr=config.TRAIN_LR)
        crit = torch.nn.BCEWithLogitsLoss(pos_weight=torch.tensor([36.4]))
        with pytest.raises(ValueError, match="no data"):
            train_epoch(model, [], crit, opt, device="cpu")
