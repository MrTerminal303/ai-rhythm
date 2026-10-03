"""Training probes + hand-written loop + toy overfit gate (Phase 7, TRN-01/02/03).

Notebook cells import these; hand-written optimizer steps only (TRN-02).
"""

from __future__ import annotations

import os
import random
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
    """TRN-02 hand-written step (D-05), BATCHED. Order: forward -> loss ->
    finite check -> zero_grad -> backward -> clip -> step."""
    mels = torch.cat([m for m, _ in data], 0).to(device)
    targets = torch.stack([y for _, y in data], 0).unsqueeze(-1).to(device)
    assert targets.dtype == torch.float32
    model.train()
    out = model(mels)
    loss = criterion(out, targets)
    if not torch.isfinite(loss):
        raise FloatingPointError(f"nonfinite loss: {loss}")
    optimizer.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), config.GRAD_CLIP)
    optimizer.step()
    return float(loss.detach())


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
