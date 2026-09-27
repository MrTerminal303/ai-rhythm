#!/usr/bin/env python3
"""AIRhythm — Full Kaggle workflow: setup → download → preprocess → baseline → train.

Copy each cell section into a Kaggle notebook.
Requires: add the airhythm dataset via sidebar → Data → Add data.
GPU: Enable in notebook settings for Phase 6+ (Model Build / Training).
"""
# %% ============================================================
# CELL 0: Install missing deps (run once per session)
# =============================================================
# On Kaggle, datasets are read-only — pip doesn't auto-install from requirements.txt.
# numpy 2.4+ breaks mir_eval/librosa on Kaggle, so pin < 2.0 first.

import sys
from pathlib import Path

# Pin numpy first to avoid _center import error
!pip install "numpy<2.0" -q

# Find and install from bundled requirements.txt (skip numpy line)
for _d in Path("/kaggle/input").rglob("requirements.txt"):
    if "airhythm" in str(_d):
        !grep -v "^numpy" {_d} | pip install -r /dev/stdin -q
        break
else:
    !pip install mir_eval==0.8.2 librosa==0.11.0 -q

import numpy as np
print(f"numpy={np.__version__}")

# Verify critical imports
import torch, torchaudio, mir_eval, librosa
print(f"torch={torch.__version__} torchaudio={torchaudio.__version__} "
      f"librosa={librosa.__version__} mir_eval={mir_eval.__version__}")
# =============================================================
import sys, os
from pathlib import Path

# Auto-find mounted dataset (3 levels deep)
kaggle_input = Path("/kaggle/input")
airhythm_root = None
if kaggle_input.is_dir():
    for d1 in kaggle_input.iterdir():
        if not d1.is_dir(): continue
        for d2 in [d1] + list(d1.iterdir()):
            if not d2.is_dir(): continue
            for d3 in [d2] + list(d2.iterdir()):
                if d3.is_dir() and (d3 / "airhythm" / "__init__.py").exists():
                    airhythm_root = d3; break
            if airhythm_root: break
        if airhythm_root: break

if airhythm_root is None:
    airhythm_root = Path.cwd()

sys.path.insert(0, str(airhythm_root))
WORKING = Path("/kaggle/working")

from airhythm import config
print(f"airhythm loaded from: {airhythm_root}")

# --- Version check (Kaggle compatibility) ---
import torch, torchaudio, librosa, numpy as np
print(f"torch={torch.__version__}  torchaudio={torchaudio.__version__}  "
      f"librosa={librosa.__version__}  numpy={np.__version__}  cuda={torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")

# Ignore torchvision conflict — we don't use it
# Other Kaggle conflicts (bigframes, ydata-profiling, google-colab) don't affect us


# %% ============================================================
# CELL 2: Check storage
# =============================================================
from airhythm.kaggle_push import estimate_storage_size, prune_old_checkpoints

def show_storage(label: str, path: str):
    info = estimate_storage_size(path)
    gb = info["total_mb"] / 1024.0
    pct = gb / config.MAX_DATASET_GB * 100
    status = "OK" if pct < 80 else "WARNING" if pct < 100 else "OVER LIMIT"
    print(f"[{label}] {gb:.2f} / {config.MAX_DATASET_GB:.0f} GB ({pct:.1f}%) - {status}")

show_storage("Dataset (read-only)", str(airhythm_root))
show_storage("Working disk", str(WORKING))


# %% ============================================================
# CELL 3: Download songs
# =============================================================
from download_minimal import main as download_main

DATA_DIR = str(WORKING / "data" / "minimal_dataset")
saved = download_main(output=DATA_DIR, n_songs=3)
print(f"\nDownloaded {saved} songs to {DATA_DIR}")


# %% ============================================================
# CELL 4: List available songs
# =============================================================
from airhythm.pin_baseline import load_song_audio_sr, reconstruct_ref_times

DATA_DIR = str(WORKING / "data" / "minimal_dataset")
data_path = Path(DATA_DIR)
songs = []
for d in sorted(data_path.iterdir()):
    if d.is_dir() and d.name.isdigit() and (d / "original.audio").exists():
        songs.append(d)

print(f"Found {len(songs)} songs:")
for s in songs:
    audio, sr = load_song_audio_sr(s)
    print(f"  {s.name}/  - {len(audio)/sr:.1f}s")


# %% ============================================================
# CELL 5: Run baseline onset detection on one song
# =============================================================
import librosa
import numpy as np
from airhythm.baseline import (
    run_librosa_onset_detection,
    evaluate_onset_fscore,
)
from airhythm.pin_baseline import bucket_refs_by_salience

if songs:
    song_dir = songs[0]
    sid = song_dir.name
    audio, sr = load_song_audio_sr(song_dir)
    ref_times = reconstruct_ref_times(song_dir)

    est_times = run_librosa_onset_detection(audio, sr)
    scores = evaluate_onset_fscore(ref_times, est_times)
    print(f"Song {sid}: F={scores['f_measure']:.3f}  P={scores['precision']:.3f}  R={scores['recall']:.3f}")
    print(f"  n_ref={scores['n_ref']}  n_est={scores['n_est']}")

    oenv = librosa.onset.onset_strength(y=audio, sr=sr, hop_length=config.HOP_LENGTH, fmax=config.FMAX)
    important, filler, cut = bucket_refs_by_salience(ref_times, oenv)
    fi = evaluate_onset_fscore(important, est_times)
    ff = evaluate_onset_fscore(filler, est_times)
    print(f"  Important bucket: F={fi['f_measure']:.3f} (n={fi['n_ref']})")
    print(f"  Filler bucket:    F={ff['f_measure']:.3f} (n={ff['n_ref']})")
else:
    print("No songs - run Cell 3 first")


# %% ============================================================
# CELL 6: Generate toy dataset (for overfit gate)
# =============================================================
from airhythm.toygen import generate_toy_set, validate_toy_sample

toy_output = str(WORKING / "toy_dataset")
result = generate_toy_set(output_dir=toy_output, n_per_class=5)

print(f"Generated {len(result.samples)} toy samples")
for sample in result.samples:
    errors = validate_toy_sample(sample)
    tag = "OK" if not errors else f"FAIL: {errors}"
    print(f"  {sample.metadata.get('generator_type', '?'):20s} {tag}")


# %% ============================================================
# CELL 7: Evaluate baseline on toy set
# =============================================================
from airhythm.baseline import evaluate_on_toy

toy_result = evaluate_on_toy(result.samples, sr=config.SAMPLE_RATE)
print(f"Toy set baseline: F={toy_result['mean_f']:.3f}  P={toy_result['mean_p']:.3f}  R={toy_result['mean_r']:.3f}")
for s in toy_result["per_sample"]:
    print(f"  {s['song_id']:12s}  F={s['f_measure']:.3f}  n_ref={s['n_ref']}  n_est={s['n_est']}")
gate = "PASS" if toy_result["mean_f"] < 0.95 else "FAIL (toy too clean)"
print(f"\nGate: F < 0.95 required - {gate}")


# %% ============================================================
# CELL 8: Preprocess a song
# =============================================================
if songs:
    song_dir = songs[0]
    print(f"Contents of {song_dir.name}/:")
    for f in sorted(song_dir.iterdir()):
        print(f"  {f.name:30s}  {f.stat().st_size:>10,} bytes")


# %% ============================================================
# CELL 9: Inspect config constants (for model build)
# =============================================================
print("=== Model input/output shapes ===")
print(f"Input shape:  {config.INPUT_SHAPE}   # (batch, n_mels, time)")
print(f"Label shape:  {config.LABEL_SHAPE}   # (active, onset, count)")
print(f"N_FRAMES:     {config.N_FRAMES}       # frames per chunk (~4s)")
print(f"HOP_FRAMES:   {config.HOP_FRAMES}     # sliding window hop")
print(f"N_MELS:       {config.N_MELS}")
print(f"HOP_LENGTH:   {config.HOP_LENGTH}     # 10ms stride")
print(f"SAMPLE_RATE:  {config.SAMPLE_RATE}")
print(f"\nPeak-pick params: {config.PEAK_PICK_PARAMS}")


# %% ============================================================
# CELL 10: Build CRNN model (Phase 6 - shape + alignment check)
# =============================================================
import torch
import torch.nn as nn

class AIRhythmCRNN(nn.Module):
    """CRNN backbone + onset detection head.
    Input:  (batch, 1, 128, 400)  - mel spectrogram chunk
    Output: (batch, 400, 1)       - per-frame onset logits
    """
    def __init__(self):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=(3, 3), padding=(1, 1)),
            nn.BatchNorm2d(32), nn.ReLU(),
            nn.MaxPool2d(kernel_size=(2, 1)),   # 128->64, time=400
            nn.Conv2d(32, 64, kernel_size=(3, 3), padding=(1, 1)),
            nn.BatchNorm2d(64), nn.ReLU(),
            nn.MaxPool2d(kernel_size=(2, 1)),   # 64->32, time=400
            nn.Conv2d(64, 128, kernel_size=(3, 3), padding=(1, 1)),
            nn.BatchNorm2d(128), nn.ReLU(),
            nn.MaxPool2d(kernel_size=(2, 1)),   # 32->16, time=400
        )
        self.gru = nn.GRU(input_size=128*16, hidden_size=128,
                          num_layers=2, batch_first=True, bidirectional=True)
        self.head = nn.Linear(128*2, 1)

    def forward(self, x):
        x = self.conv(x)
        x = x.permute(0, 3, 1, 2).reshape(x.size(0), x.size(1), -1)
        x, _ = self.gru(x)
        return self.head(x)


model = AIRhythmCRNN()
dummy = torch.randn(2, 1, 128, 400)
out = model(dummy)
assert out.shape == (2, 400, 1), f"Wrong shape: {out.shape}"
print(f"Shape assert passed: {out.shape}")

impulse = torch.zeros(1, 1, 128, 400)
impulse[0, 0, :, 200] = 10.0
with torch.no_grad():
    probs = torch.sigmoid(model(impulse).squeeze())
    argmax_frame = int(probs.argmax())
    assert abs(argmax_frame - 200) <= 2, f"Alignment fail: argmax={argmax_frame}"
    print(f"Alignment assert passed: argmax={argmax_frame} (target=200)")


# %% ============================================================
# CELL 11: Toy overfit gate (Phase 7)
# =============================================================
import torch.nn.functional as F
from torch.optim import AdamW
import torchaudio

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = AIRhythmCRNN().to(DEVICE)

# Build 10 metronome toy samples as tensors
from airhythm.toygen import MetronomeClickGenerator

metronome_data = []
for i in range(10):
    gen = MetronomeClickGenerator(sample_rate=config.SAMPLE_RATE)
    audio, labels = gen.generate(bpm=120.0 + i * 10)
    exp_samples = int(config.SAMPLE_RATE * 4.0)
    if len(audio) < exp_samples:
        audio = np.pad(audio, (0, exp_samples - len(audio)))
    else:
        audio = audio[:exp_samples]
    if len(labels) < config.N_FRAMES:
        labels = np.pad(labels, (0, config.N_FRAMES - len(labels)))
    else:
        labels = labels[:config.N_FRAMES]
    audio_t = torch.tensor(audio).unsqueeze(0).float()
    mel = torchaudio.transforms.MelSpectrogram(
        sample_rate=config.SAMPLE_RATE, n_fft=config.N_FFT,
        hop_length=config.HOP_LENGTH, n_mels=config.N_MELS, power=config.POWER,
    )(audio_t).unsqueeze(0)
    T = mel.size(-1)
    if T < 400:
        mel = F.pad(mel, (0, 400 - T))
    else:
        mel = mel[:, :, :, :400]
    metronome_data.append((mel.to(DEVICE), torch.tensor(labels[:400]).float().to(DEVICE)))

optimizer = AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
model.train()
for epoch in range(200):
    total_loss = 0
    for mel, label in metronome_data:
        out = model(mel).squeeze(-1)
        loss = F.binary_cross_entropy_with_logits(out, label)
        optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        total_loss += loss.item()
    if (epoch + 1) % 50 == 0:
        model.eval()
        with torch.no_grad():
            pred_rate = np.mean([
                (torch.sigmoid(model(m.to(DEVICE)).squeeze(-1)) > 0.5).float().mean().item()
                for m, _ in metronome_data
            ])
        model.train()
        print(f"Epoch {epoch+1:3d}  loss={total_loss/len(metronome_data):.4f}  pred_rate={pred_rate:.3f}")

model.eval()
correct = total = 0
with torch.no_grad():
    for mel, label in metronome_data:
        pred = (torch.sigmoid(model(mel).squeeze(-1)) > 0.5).long()
        correct += (pred == label.long()).sum().item()
        total += len(label)
print(f"\nToy overfit gate: accuracy={correct/total:.4f} (target ~1.0)")


# %% ============================================================
# CELL 12: Save checkpoint
# =============================================================
ckpt_dir = str(WORKING / "checkpoints")
os.makedirs(ckpt_dir, exist_ok=True)
torch.save({"model_state_dict": model.state_dict(), "epoch": 0},
           f"{ckpt_dir}/latest_epoch_0.pt")
show_storage("Working disk after checkpoint", str(WORKING))
print("Checkpoint saved")


# %% ============================================================
# CELL 13: Full training loop skeleton (Phase 8 - real songs)
# =============================================================
# This is the skeleton for full training. Fill in with real data
# after toy gate passes.
#
# from torch.utils.data import DataLoader, Dataset
#
# class SongChunks(Dataset):
#     """Load preprocessed .npy spectrogram chunks + labels."""
#     def __init__(self, data_dir):
#         self.chunks = []  # list of (spec_path, label_path)
#         # Scan data_dir for *.npy files...
#
#     def __len__(self):
#         return len(self.chunks)
#
#     def __getitem__(self, idx):
#         spec = np.load(self.chunks[idx][0])
#         label = np.load(self.chunks[idx][1])
#         return torch.tensor(spec).float(), torch.tensor(label).float()
#
# train_loader = DataLoader(SongChunks(DATA_DIR), batch_size=16, shuffle=True)
#
# # Compute pos_weight from dataset (onset rate ~2-5%)
# # pos_weight = n_neg / n_pos  (expect ~20-50x)
#
# # Training loop with:
# #   - BCEWithLogitsLoss(pos_weight=...)
# #   - AdamW(lr=1e-3, wd=1e-4)
# #   - ReduceLROnPlateau(patience=3, factor=0.5)
# #   - Grad clip 1.0
# #   - Time-based checkpoint every 30min
#
print("Phase 8 training skeleton - implement after toy gate passes")


# %% ============================================================
# CELL 14: Push to Kaggle Dataset (end of session)
# =============================================================
# Only run at END of training session to persist data.
# Requires kagglehub: pip install kagglehub
#
# from airhythm.kaggle_push import push_dataset, build_manifest
# build_manifest(f"{DATA_DIR}/../metadata", base_dir=str(WORKING / "data"))
# ok = push_dataset(local_dir=str(WORKING / "data"),
#                    version_notes="Phase 7 - toy overfit gate passed")
# print(f"Push {'succeeded' if ok else 'failed'}")

print("\n=== Workflow complete ===")
print("Phase 6 (shape+alignment) - Cell 10")
print("Phase 7 (toy overfit gate) - Cell 11")
print("Phase 8 (full training)    - Cell 11 → Cell 13")
print("Phase 9 (ONNX export)      - after Phase 8")
print("Phase 10 (JSON charts)     - after Phase 9")
