"""Training probes + hand-written loop + toy overfit gate (Phase 7, TRN-01/02/03).

Notebook cells import these; hand-written optimizer steps only (TRN-02).
"""

from __future__ import annotations

import os
import random
import time
from typing import Callable

import torch
import torch.nn as nn

from airhythm import config

__all__ = [
    "compute_pos_weight_candidate",
    "stability_probe",
    "run_training_slice",
    "rate_breach",
    "build_metronome_data",
    "train_epoch",
    "predicted_positive_rate",
    "evaluate_gate",
    "tripwire_breached",
    "run_toy_overfit_gate",
    "save_checkpoint",
    "load_checkpoint",
    "resume_smoke_test",
    "_smoke_impl",  # test hook for mutant (pre_epoch4_hook injection)
    "median_epoch_time",
    "epoch_cap",
    "build_real_loaders",
    "run_real_training",
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


def build_metronome_data(n_toy: int = config.N_TOY, *, device) -> tuple[list, float]:
    """D-04: n_toy MetronomeClickGenerator songs ONLY. bpm = 120.0 + i*10.
    Mel path = torchaudio-from-audio. BINARIZE labels: generate() returns
    sparse frame indices, so bin them into a (400,) float32 vector."""
    import numpy as np
    import torchaudio
    import torch.nn.functional as F

    from airhythm.toygen import MetronomeClickGenerator

    audio_len = int(config.SAMPLE_RATE * 4.0)
    mel_fn = torchaudio.transforms.MelSpectrogram(
        sample_rate=config.SAMPLE_RATE, n_fft=config.N_FFT,
        hop_length=config.HOP_LENGTH, n_mels=config.N_MELS, power=config.POWER,
    )
    data = []
    total_pos, total_frames = 0, 0
    for i in range(n_toy):
        gen = MetronomeClickGenerator(sample_rate=config.SAMPLE_RATE)
        audio, frames = gen.generate(bpm=120.0 + i * 10)
        if len(audio) < audio_len:
            audio = np.pad(audio, (0, audio_len - len(audio)))
        else:
            audio = audio[:audio_len]
        y = np.zeros(config.N_FRAMES, np.float32)
        frames = np.asarray(frames)
        frames = frames[frames < config.N_FRAMES]
        y[frames] = 1.0
        audio_t = torch.tensor(audio).unsqueeze(0).float()
        mel = mel_fn(audio_t).unsqueeze(0)
        t = mel.size(-1)
        if t < config.N_FRAMES:
            mel = F.pad(mel, (0, config.N_FRAMES - t))
        else:
            mel = mel[:, :, :, : config.N_FRAMES]
        label = torch.tensor(y, dtype=torch.float32)
        data.append((mel.float().to(device), label.to(device)))
        total_pos += int(y.sum())
        total_frames += config.N_FRAMES
    return data, total_pos / total_frames


def train_epoch(model, data, criterion, optimizer, *, device) -> float:
    """TRN-02 hand-written step (D-05), PER-BATCH. Order per step: forward ->
    loss -> finite check -> zero_grad -> backward -> clip -> step.
    Returns sample-weighted mean loss over batches.

    Single pass over `data` (one DataLoader iteration only — the old two-pass
    cat/ys form misaligned mels vs labels under shuffle=True). Items are either
    single samples mel (1,1,128,400) y (400,) or batches (B,1,128,400) y (B,400);
    each yields targets (B,400,1) matching out (B,400,1)."""
    model.train()
    total, n = 0.0, 0
    for mels, ys in data:
        mels = mels.to(device, non_blocking=True)
        if ys.dim() == 1:  # single sample -> fake batch of 1
            ys = ys.unsqueeze(0)
        targets = ys.float().unsqueeze(-1).to(device, non_blocking=True)
        assert targets.dtype == torch.float32
        out = model(mels)
        loss = criterion(out, targets)
        if not torch.isfinite(loss):
            raise FloatingPointError(f"nonfinite loss: {loss}")
        optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), config.GRAD_CLIP)
        optimizer.step()
        total += float(loss.detach()) * mels.size(0)
        n += mels.size(0)
    if n == 0:
        raise ValueError(
            "train_epoch saw no data — empty train loader? "
            "batch_size must be <= floor(n_train_crops) (drop_last=True)")
    return total / n


def predicted_positive_rate(model, data, *, device) -> float:
    """mean(sigmoid(logits) > config.SIGMOID_THRESHOLD) over ALL frames."""
    was_training = model.training
    model.eval()
    try:
        with torch.no_grad():
            total_pos, total = 0, 0
            for mel, _ in data:
                out = model(mel.to(device))
                pred = (torch.sigmoid(out) > config.SIGMOID_THRESHOLD).float()
                total_pos += int(pred.sum())
                total += pred.numel()
        return total_pos / total
    finally:
        model.train(was_training)


def evaluate_gate(preds: torch.Tensor, targets: torch.Tensor) -> tuple[float, float, bool]:
    """D-02 gate metric over already-thresholded binary tensors (any equal shape)."""
    p_bin = (preds > 0.5).float()
    t_bin = (targets > 0.5).float()
    tp = int(((p_bin == 1) & (t_bin == 1)).sum())
    fp = int(((p_bin == 1) & (t_bin == 0)).sum())
    fn = int(((p_bin == 0) & (t_bin == 1)).sum())
    p = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    r = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    return p, r, bool(p >= config.GATE_P and r >= config.GATE_R)


def tripwire_breached(
    history,
    *,
    grace: int = config.TRIPWIRE_GRACE_EPOCHS,
    consecutive: int = config.TRIPWIRE_BREACH_N,
) -> tuple[bool, int]:
    """D-06. history = sequence of (pred_rate, true_rate); index i = epoch i+1.
    Epochs 1..grace NEVER counted. Halt iff >= `consecutive` CONSECUTIVE breaches."""
    run = 0
    for i, (pred_rate, true_rate) in enumerate(history):
        if i + 1 <= grace:
            continue
        if rate_breach(pred_rate, true_rate) is not None:
            run += 1
        else:
            run = 0
    return run >= consecutive, run


def run_toy_overfit_gate(model, data, *, device, pos_weight,
                         max_epochs: int = config.MAX_EPOCHS) -> dict:
    """Full loop (D-05). Stop at first of: passed gate, tripwire halt, max_epochs."""
    criterion = nn.BCEWithLogitsLoss(
        pos_weight=torch.tensor([pos_weight], dtype=torch.float32, device=device)
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config.TRAIN_LR, weight_decay=config.TRAIN_WD
    )
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="min",
        patience=config.SCHED_PATIENCE, factor=config.SCHED_FACTOR,
    )
    true_rate = float(
        torch.stack([y for _, y in data], 0).float().mean().item()
    )
    history: list = []
    precision = recall = 0.0
    epoch_loss, halted, halt_reason, passed = 0.0, False, None, False
    for epoch in range(1, max_epochs + 1):
        epoch_loss = train_epoch(model, data, criterion, optimizer, device=device)
        with torch.no_grad():
            model.eval()
            all_preds, all_targets = [], []
            for mel, y in data:
                p = (torch.sigmoid(model(mel.to(device))) > config.SIGMOID_THRESHOLD).float()
                all_preds.append(p.reshape(-1))
                all_targets.append(y.to(device).reshape(-1))
            model.train()
        precision, recall, passed = evaluate_gate(
            torch.cat(all_preds), torch.cat(all_targets)
        )
        pred_rate = predicted_positive_rate(model, data, device=device)
        history.append((pred_rate, true_rate))
        halt, _ = tripwire_breached(history)
        scheduler.step(epoch_loss)
        if passed:
            break
        if halt:
            halted, halt_reason = True, "tripwire: 3 consecutive rate breaches"
            break
    return {
        "passed": passed,
        "precision": precision,
        "recall": recall,
        "epoch": epoch,
        "pred_rate": history[-1][0] if history else 0.0,
        "true_rate": true_rate,
        "final_loss": epoch_loss,
        "halted": halted,
        "halt_reason": halt_reason,
        "optimizer": optimizer,
        "scheduler": scheduler,
    }


def save_checkpoint(path, *, model, optimizer, scheduler, epoch: int, global_step: int,
                    val_metric: float, stage: str, pos_weight: float) -> dict:
    """EXP-02 D-09: full-state dict, saved EVERY epoch locally. Keys EXACTLY:
    model, optimizer, scheduler, epoch, global_step, val_metric, stage, torch_rng, random_rng, pos_weight
    plus "cuda_rng": torch.cuda.get_rng_state_all() ONLY when torch.cuda.is_available().
    torch.save(state, path); return state."""
    state = {
        "model": model.state_dict(),
        "optimizer": optimizer.state_dict(),
        "scheduler": scheduler.state_dict(),
        "epoch": epoch,
        "global_step": global_step,
        "val_metric": val_metric,
        "stage": stage,
        "torch_rng": torch.get_rng_state(),
        "random_rng": random.getstate(),
        "pos_weight": pos_weight,
    }
    if torch.cuda.is_available():
        state["cuda_rng"] = torch.cuda.get_rng_state_all()
    parent = os.path.dirname(os.path.abspath(str(path)))
    if parent:
        os.makedirs(parent, exist_ok=True)
    torch.save(state, path)
    return state


def load_checkpoint(path, *, model, optimizer, scheduler, device="cpu") -> dict:
    """EXP-02 D-11: ordered restore — model -> optimizer -> scheduler (AFTER optimizer:
    restores best/num_bad_epochs/cooldown_counter) -> torch.set_rng_state(torch_rng)
    -> random.setstate(random_rng) -> cuda rng if present and cuda available.
    Prints `resume: epoch={epoch} global_step={global_step}` and ASSERTS
    ckpt["epoch"] >= 0 and ckpt["global_step"] >= 0.
    Returns the full ckpt dict. torch.load(path, map_location=device, weights_only=False) —
    only own-run files from CHECKPOINTS_DIR/working dir, never an untrusted path (T-8-03)."""
    ckpt = torch.load(path, map_location=device, weights_only=False)
    model.load_state_dict(ckpt["model"])
    optimizer.load_state_dict(ckpt["optimizer"])
    scheduler.load_state_dict(ckpt["scheduler"])
    torch.set_rng_state(ckpt["torch_rng"])
    random.setstate(ckpt["random_rng"])
    if "cuda_rng" in ckpt and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(ckpt["cuda_rng"])
    print(f"resume: epoch={ckpt['epoch']} global_step={ckpt['global_step']}")
    assert ckpt["epoch"] >= 0 and ckpt["global_step"] >= 0
    return ckpt


def _smoke_impl(pre_epoch4_hook=None, *, device="cpu", tolerance: float = 1e-6,
                _skip_rng_restore: bool = False) -> dict:
    """Shared impl so the mutant test can inject RNG drift before epoch 4.

    Dropout probe: _skip_rng_restore=True simulates the resume bug the smoke
    test guards — RNG state NOT restored before the dropout-masked epoch 4.
    BatchNorm mode: train() everywhere (matches run_toy_overfit_gate, which is
    train-mode throughout). Detection channel: epoch-4 LOSS diff (dropout mask
    differs when RNG mis-restored) AND RNG sequence parity (next draw after
    load equals the saved sequence)."""
    from airhythm.model import AIRhythmCRNN

    def fresh_opt_sched(model):
        opt = torch.optim.AdamW(model.parameters(), lr=config.TRAIN_LR,
                                weight_decay=config.TRAIN_WD)
        sch = torch.optim.lr_scheduler.ReduceLROnPlateau(
            opt, mode="min", patience=3, factor=0.5)
        return opt, sch

    def build_fresh(seed):
        torch.manual_seed(seed)
        random.seed(seed)
        model = AIRhythmCRNN()
        model.train()  # train-mode init so BN uses batch stats deterministically
        g = torch.Generator().manual_seed(seed)
        mels, ys = [], []
        for _ in range(4):
            mels.append(torch.randn(1, 1, 128, 400, generator=g))
            ys.append((torch.rand(400, generator=g) < 0.03).float())
        # one (4,...) batch item: train_epoch is per-batch now — keeps smoke at
        # 1 step/epoch (old shape: BN over batch-4, single dropout draw) and <30s.
        data = [(torch.cat(mels, 0), torch.stack(ys, 0))]
        return model, data

    def epoch_with_dropout(model, data, criterion, opt):
        """train_epoch + one torch+python RNG draw per step under dropout.

        Dropout consumes RNG inside forward; skipping the RNG restore before
        epoch 4 therefore changes the mask AND the post-epoch RNG sequence.
        ponytail: no dropout in prod arch — probe-only, remove if arch gains
        real stochastic layers (then the loss diff detects drift directly)."""
        loss = train_epoch(model, data, criterion, opt, device=device)
        torch.nn.functional.dropout(torch.ones(8), p=0.5, training=True)
        random.random()
        return loss

    crit_kwargs = dict(pos_weight=torch.tensor([36.4], dtype=torch.float32))
    # FRESH RUN: seed, build, train 4 epochs
    fresh_model, fresh_data = build_fresh(0)
    fresh_opt, fresh_sch = fresh_opt_sched(fresh_model)
    fresh_crit = nn.BCEWithLogitsLoss(**crit_kwargs)
    for i in range(4):
        loss_4_fresh = epoch_with_dropout(fresh_model, fresh_data, fresh_crit,
                                          fresh_opt)
        fresh_sch.step(loss_4_fresh)
        if i == 2:
            # RNG sequence at the save point: resumed run must replay this.
            ref_draws = (random.random(), torch.rand(1).tolist())

    # RESUMED RUN: re-seed identically, train 1-3, save, load into fresh objs, epoch 4
    r_model, r_data = build_fresh(0)
    r_opt, r_sch = fresh_opt_sched(r_model)
    r_crit = nn.BCEWithLogitsLoss(**crit_kwargs)
    for _ in range(3):
        loss = epoch_with_dropout(r_model, r_data, r_crit, r_opt)
        r_sch.step(loss)
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "latest_smoke.pt")
        save_checkpoint(p, model=r_model, optimizer=r_opt, scheduler=r_sch,
                        epoch=3, global_step=3, val_metric=loss,
                        stage="smoke", pos_weight=36.4)
        torch.manual_seed(999)
        random.seed(999)
        m2, m2_data = build_fresh(0)
        assert len(m2_data) == len(r_data)
        o2, s2 = fresh_opt_sched(m2)
        ckpt = torch.load(p, map_location=device, weights_only=False)
        m2.load_state_dict(ckpt["model"])
        o2.load_state_dict(ckpt["optimizer"])
        s2.load_state_dict(ckpt["scheduler"])
        if not _skip_rng_restore:
            torch.set_rng_state(ckpt["torch_rng"])
            random.setstate(ckpt["random_rng"])
        else:
            # Mutant: keep the post-build RNG state — simulates a resume that
            # restored weights/optimizer/scheduler but forgot the RNG keys.
            pass
        if "cuda_rng" in ckpt and torch.cuda.is_available():
            torch.cuda.set_rng_state_all(ckpt["cuda_rng"])
        print(f"resume: epoch={ckpt['epoch']} global_step={ckpt['global_step']}")
        if pre_epoch4_hook is not None:
            pre_epoch4_hook()
        c2 = nn.BCEWithLogitsLoss(**crit_kwargs)
        post_draws = (random.random(), torch.rand(1).tolist())
        rng_ok = (post_draws == ref_draws)
        loss_4_resumed = epoch_with_dropout(m2, m2_data, c2, o2)
        s2.step(loss_4_resumed)
        lr_next = o2.param_groups[0]["lr"]
    fresh_lr = fresh_opt.param_groups[0]["lr"]
    sched_ok = (
        s2.state_dict()["num_bad_epochs"] == fresh_sch.state_dict()["num_bad_epochs"]
        and s2.state_dict()["best"] == fresh_sch.state_dict()["best"]
        and lr_next == fresh_lr
    )
    passed = bool(abs(loss_4_resumed - loss_4_fresh) < tolerance
                  and sched_ok and rng_ok)
    return {"pass": passed, "loss_4_fresh": loss_4_fresh,
            "loss_4_resumed": loss_4_resumed, "lr_next": lr_next}


def resume_smoke_test(*, device="cpu", tolerance: float = 1e-6) -> dict:
    """EXP-02 success criterion 4, CPU-runnable in seconds.
    Protocol (research §Resume smoke test):
      (1) build tiny fixture: 4 chunks of random mel (1,1,128,400) + sparse binary labels
          (seeded torch.Generator), AIRhythmCRNN(), AdamW(1e-3), ReduceLROnPlateau(patience=3),
          BCEWithLogitsLoss(pos_weight=tensor([36.4]));
      (2) FRESH RUN: seed all RNGs (torch.manual_seed(0), random.seed(0)); train 4 epochs via
          train_epoch (+ one dropout/RNG probe draw per epoch) on the SAME fixture;
          record loss_4_fresh = epoch-4 loss;
      (3) RESUMED RUN: re-seed identically; train epochs 1-3; save_checkpoint(tmp) after epoch 3;
          then MUTATE state (torch.manual_seed(999), random.seed(999)); load_checkpoint into
          FRESH model/optimizer/scheduler instances (constructor-fresh, same seed 0 as (2) start);
          train epoch 4; record loss_4_resumed;
      (4) PASS iff abs(loss_4_resumed - loss_4_fresh) < tolerance AND scheduler state dict
          (num_bad_epochs, best) equal AND next LR equal AND post-load RNG sequence
          replays the saved sequence (dropout probe makes skipped restores detectable).
    Delegates to _smoke_impl (which calls save_checkpoint + load_checkpoint).
    Returns {"pass": bool, "loss_4_fresh": ..., "loss_4_resumed": ..., "lr_next": ...}.
    Raises nothing — caller prints PASS/FAIL (notebook greps 'resume smoke')."""
    return _smoke_impl(device=device, tolerance=tolerance)


def median_epoch_time(epoch_times: list[float]) -> float:
    """D-10: median wall-clock of epochs 2..4 (discard epoch 1 warm-up).
    If len<2, return last element or raise ValueError on empty.
    Used to size the epoch cap and the ~30min push interval."""
    if len(epoch_times) == 0:
        raise ValueError("empty epoch_times list")
    if len(epoch_times) == 1:
        return epoch_times[0]
    # Discard epoch 1 (warm-up), take median of remaining
    return sorted(epoch_times[1:])[len(epoch_times[1:]) // 2]


def epoch_cap(measured_epoch_h: float, budget_h: float = config.EPOCH_CAP_HOURS) -> int:
    """D-08/RESEARCH Open Q1: cap = max(EPOCH_CAP_FLOOR, floor(budget_h / measured_epoch_h))."""
    return max(config.EPOCH_CAP_FLOOR, int(budget_h / measured_epoch_h))


def build_real_loaders(all_song_dirs, *, eval_ids, search_id, device=None,
                       batch_size: int = 8, crops_per_song: int = 1, seed: int = 0,
                       num_workers: int = 0, pin_memory: bool = False,
                       cache_root=None) -> tuple:
    """D-05/D-06/D-07 wiring: ids = [int(dir.name) for dir in all_song_dirs]
    train_ids, val_ids, excluded = split_song_ids(ids, eval_ids, search_id)
    train_ds = RandomCropDataset([dirs[s] for s in train_ids], rng=random.Random(seed))
    val_ds   = FixedChunkDataset([dirs[s] for s in val_ids])
    Returns (train DataLoader (shuffle=True, drop_last=True), val DataLoader
    (no shuffle), info dict with train_ids/val_ids/excluded).
    MUST print `corpus: train={n} val={n} excluded={excluded}` — excluded line is
    the audit trail that the 5 eval + 1 search IDs are OUT (Pitfall 6)."""
    from torch.utils.data import DataLoader

    from airhythm.datasets import RandomCropDataset, FixedChunkDataset, split_song_ids

    ids = [int(d.name) for d in all_song_dirs]
    dir_by_id = {int(d.name): d for d in all_song_dirs}
    train_ids, val_ids, excluded = split_song_ids(ids, eval_ids, search_id)
    train_ds = RandomCropDataset([dir_by_id[s] for s in train_ids],
                                 crops_per_song=crops_per_song, rng=random.Random(seed),
                                 cache_root=cache_root)
    val_ds = FixedChunkDataset([dir_by_id[s] for s in val_ids])

    def _onset_collate(batch):
        # D-05 items carry labels (3,400) = active/onset/count; the onset head
        # consumes row 1 only — same rule as boundary_fraction/reconstruct_ref_times.
        return (torch.stack([m for m, _ in batch]),
                torch.stack([y[1] for _, y in batch]))

    # num_workers/pin_memory: GPU throughput (Kaggle = 4 cores, pass num_workers=2);
    # persistent_workers only valid when workers > 0.
    _kw = dict(num_workers=num_workers, pin_memory=pin_memory)
    if num_workers:
        _kw["persistent_workers"] = True
    train_loader = DataLoader(train_ds, batch_size, shuffle=True, drop_last=True,
                              collate_fn=_onset_collate, **_kw)
    val_loader = DataLoader(val_ds, batch_size, shuffle=False,
                            collate_fn=_onset_collate, **_kw)
    print(f"corpus: train={len(train_ids)} val={len(val_ids)} excluded={excluded}")
    return train_loader, val_loader, {"train_ids": train_ids, "val_ids": val_ids, "excluded": excluded}


def run_real_training(train_data, val_data, *, pos_weight: float, device,
                      ckpt_dir, stage: str = "phase8_real", max_epochs: int | None = None,
                      patience: int = config.EARLY_STOP_PATIENCE,
                      save_every_epoch: bool = True,
                      start_epoch: int = 0, global_step: int = 0,
                      model=None, optimizer=None, scheduler=None,
                      best_val: float | None = None,
                      on_epoch_end=None,
                      _val_fn=None) -> dict:
    """Phase 8 loop (package owns loop - notebook only chains it).

    Per epoch:
      1. train_loss = train_epoch(model, train_data, criterion, optimizer, device)
         # BCEWithLogitsLoss(pos_weight tensor on device)
      2. val_loss, val_frame_f = eval loop on val_data
         # no_grad; sigmoid > SIGMOID_THRESHOLD -> evaluate_gate
      3. history append (pred_rate, true_rate) from predicted_positive_rate on val_data;
         halted, run = tripwire_breached(history) — if halted: stop, reason="tripwire"
      4. scheduler.step(val_loss)
      5. save_checkpoint(f"{ckpt_dir}/latest_{stage}.pt", ...,
         epoch, global_step, val_metric=val_loss, stage, pos_weight)
         AND if val_loss < best_val: save_checkpoint(f"{ckpt_dir}/best_{stage}.pt", ...)
            (prune patterns!)
      6. early stop: if val_loss failed to improve for `patience` epochs: stop, reason="early_stop"
      7. if max_epochs reached: stop, reason="max_epochs"

    val frame-F is COMPUTED and included in the returned history (D-04 print-only)
    but NEVER selects best, NEVER stops training, NEVER gates (Pitfall 5).

    The optional `_val_fn` parameter allows test injection of val_loss sequence.
    When provided, it should return a float val_loss for each call.
    When None (default), computes val_loss from the val_data.

    Returns {"history": [{"epoch", "train_loss", "val_loss", "val_frame_f", "pred_rate"}...],
             "best_epoch", "best_val_loss", "stopped_reason", "epoch_times", "global_step"}.
    max_epochs=None means run until early stop/tripwire (caller passes epoch_cap(...) on Kaggle).

    Resume extension (08-06, D-11): start_epoch/global_step seed numbering from a loaded
    ckpt (history starts empty); model/optimizer/scheduler accept the caller's loaded
    objects (None = build fresh, zero behavior change); best_val seeds from the ckpt's
    val_metric; on_epoch_end(epoch, epoch_times) fires after each epoch (push cadence,
    D-10) when provided."""
    import os

    from airhythm.train import train_epoch, save_checkpoint

    criterion = nn.BCEWithLogitsLoss(
        pos_weight=torch.tensor([pos_weight], dtype=torch.float32, device=device)
    )

    from airhythm.model import AIRhythmCRNN
    if model is None:
        model = AIRhythmCRNN()

    if optimizer is None:
        optimizer = torch.optim.AdamW(
            model.parameters(), lr=config.TRAIN_LR, weight_decay=config.TRAIN_WD
        )
    if scheduler is None:
        scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
            optimizer, mode="min",
            patience=config.SCHED_PATIENCE, factor=config.SCHED_FACTOR,
        )

    best_val = float("inf") if best_val is None else float(best_val)
    best_epoch = start_epoch if best_val != float("inf") else 0
    history = []
    epoch_times = []
    halted = False
    halt_reason = None
    no_improve_count = 0

    # while (not for): max_epochs=None means run until early stop/tripwire (D-08);
    # epoch numbering continues from start_epoch on resume (08-06).
    epoch = start_epoch
    while max_epochs is None or epoch < max_epochs:
        epoch += 1
        epoch_start = time.time()

        # 1. train
        train_loss = train_epoch(model, train_data, criterion, optimizer, device=device)

        # 2. val eval
        # Use injected val_fn if provided, otherwise compute from data
        if _val_fn is not None:
            val_loss = float(_val_fn())
            # Still need val_frame_f for history
            model.eval()
            with torch.no_grad():
                all_preds, all_targets = [], []
                for mel, label in val_data[:1] if val_data else []:
                    out = model(mel.to(device))
                    pred = (torch.sigmoid(out) > config.SIGMOID_THRESHOLD).float()
                    all_preds.append(pred.reshape(-1))
                    all_targets.append(label.to(device).reshape(-1))
                model.train()
            if all_preds and all_targets:
                cat_preds = torch.cat(all_preds)
                cat_targets = torch.cat(all_targets)
                _, val_frame_f, _ = evaluate_gate(cat_preds, cat_targets)
            else:
                val_frame_f = 0.0
        else:
            # Compute val from actual data
            model.eval()
            with torch.no_grad():
                all_preds, all_targets = [], []
                val_loss_accum = 0.0
                for mel, label in val_data:
                    out = model(mel.to(device))
                    loss = criterion(out, label.to(device).float().unsqueeze(-1))
                    val_loss_accum += loss.item()
                    pred = (torch.sigmoid(out) > config.SIGMOID_THRESHOLD).float()
                    all_preds.append(pred.reshape(-1))
                    all_targets.append(label.to(device).reshape(-1))
                model.train()

            n_val = len(val_data)
            val_loss = val_loss_accum / n_val if n_val > 0 else 0.0

            if all_preds and all_targets:
                cat_preds = torch.cat(all_preds)
                cat_targets = torch.cat(all_targets)
                _, val_frame_f, _ = evaluate_gate(cat_preds, cat_targets)
            else:
                val_frame_f = 0.0

        # 3. pred_rate and tripwire
        pred_rate = predicted_positive_rate(model, val_data, device=device)
        history.append({
            "epoch": epoch,
            "train_loss": train_loss,
            "val_loss": val_loss,
            "val_frame_f": val_frame_f,
            "pred_rate": pred_rate,
            "true_rate": float(torch.cat(all_targets).mean()) if all_targets else 0.0,
        })

        # tripwire check
        if len(history) >= config.TRIPWIRE_GRACE_EPOCHS + 1:
            tripwire_history = [
                (h["pred_rate"], h["true_rate"]) for h in history
            ]
            halted, run = tripwire_breached(
                tripwire_history,
                grace=config.TRIPWIRE_GRACE_EPOCHS,
                consecutive=config.TRIPWIRE_BREACH_N,
            )
            if halted:
                halted = True
                halt_reason = f"tripwire: {run} consecutive breaches"
                break

        # 4. scheduler step
        scheduler.step(val_loss)

        # count THIS epoch's batches before saving (review #4 P2: checkpoint
        # used to store the step count from before this epoch)
        global_step += len(train_data)

        # 5. save checkpoints
        latest_path = os.path.join(ckpt_dir, f"latest_{stage}.pt")
        state = save_checkpoint(
            latest_path, model=model, optimizer=optimizer, scheduler=scheduler,
            epoch=epoch, global_step=global_step, val_metric=val_loss, stage=stage, pos_weight=pos_weight,
        )

        if val_loss < best_val:
            best_val = val_loss
            best_epoch = epoch
            best_path = os.path.join(ckpt_dir, f"best_{stage}.pt")
            save_checkpoint(
                best_path, model=model, optimizer=optimizer, scheduler=scheduler,
                epoch=epoch, global_step=global_step, val_metric=val_loss, stage=stage, pos_weight=pos_weight,
            )
            no_improve_count = 0
        else:
            no_improve_count += 1

        # 6. early stop check
        if no_improve_count >= patience:
            halted = True
            halt_reason = "early_stop"
            break

        epoch_end = time.time()
        epoch_dur = epoch_end - epoch_start
        epoch_times.append(epoch_dur)
        if on_epoch_end is not None:
            on_epoch_end(epoch, epoch_times)

    return {
        "history": history,
        "best_epoch": best_epoch,
        "best_val_loss": best_val,
        "stopped_reason": halt_reason or (
            "max_epochs" if (max_epochs is not None and epoch >= max_epochs)
            else "early_stop"
        ),
        "epoch_times": epoch_times,
        "global_step": global_step,
    }
