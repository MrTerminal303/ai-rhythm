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
# numpy: do NOT pin <2.0 — downgrading over the image's numpy corrupts dist-packages
# (ModuleNotFoundError: numpy.char, observed 2026-10-01). Only repair if already broken.

import sys, subprocess
from pathlib import Path

# Sanity-check numpy in a clean interpreter; force-reinstall only if broken
# (a prior session's <2.0 pin leaves mixed files that fail numpy's sanity check).
if subprocess.run([sys.executable, "-c", "import numpy.char"], capture_output=True).returncode != 0:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "--force-reinstall", "--no-deps", "numpy"])

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
import logging
# Show search page progress (default logger output is invisible in notebooks —
# the old silent search looked frozen for minutes)
logging.basicConfig(level=logging.INFO, format="%(message)s")

from airhythm.download_batch import main as download_main

DATA_DIR = str(WORKING / "data" / "minimal_dataset")
# n_songs = TOTAL target: resumes to 100 across reruns, prunes partial dirs
saved = download_main(output=DATA_DIR, n_songs=100)
print(f"\nDownloaded {saved} new songs to {DATA_DIR}")


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

from airhythm import config
from airhythm.model import AIRhythmCRNN, alignment_delta   # package = single source of truth (D-08/D-09)

torch.manual_seed(0)   # seed BEFORE construction — this is what pins the weights (review fix)
model = AIRhythmCRNN()

# MOD-02: gradient alignment FIRST on the fresh model — review fix: running the
# shape check first would let a train-mode forward push a randn batch through BN,
# corrupting running stats before alignment_delta switches to eval (breaks the
# identical-code claim vs pytest, where every test gets a fresh fixture model)
delta = alignment_delta(model, 200)
align_ok = abs(delta) <= 2
print(f"Alignment: {'PASS' if align_ok else 'FAIL'} delta={delta} (target=200, tol=2)")

# MOD-01: shape assert — literal bool
out = model(torch.randn(2, 1, 128, 400))
shape_ok = out.shape == (2, 400, 1)
print(f"Shape assert: {'PASS' if shape_ok else 'FAIL'} {tuple(out.shape)}")

# MOD-01: param ceiling — D-03 corrected to 400,000 (M1 measures 353,121)
n_params = sum(p.numel() for p in model.parameters())
ceil_ok = n_params <= config.PARAM_CEILING
print(f"Param ceiling: {'PASS' if ceil_ok else 'FAIL'} {n_params} <= {config.PARAM_CEILING}")

assert shape_ok and ceil_ok and align_ok, "Phase 6 gate FAILED — do not proceed to Phase 7"
print("Phase 6 gate: PASS (shape + params + alignment)")


# %% ============================================================
# CELL 11: Toy overfit gate (Phase 7) — probes -> loop -> gate -> PASS (D-07 single session)
# =============================================================
# standalone-safe: works even if CELL 10 not pasted (A1 pattern)
from airhythm import config
from airhythm.model import AIRhythmCRNN
from airhythm.train import (
    build_metronome_data, compute_pos_weight_candidate, stability_probe,
    run_training_slice, rate_breach, run_toy_overfit_gate,
)
import torch

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
torch.manual_seed(0)

# D-04: 10 metronome_click songs ONLY (build_metronome_data never touches generate_toy_set)
data, true_rate = build_metronome_data(config.N_TOY, device=DEVICE)
print(f"toy songs={len(data)} true_pos_rate={true_rate:.4f}")

# TRN-01 stability probe (D-01: large slice = FULL pass over data, halve on NaN)
labels_all = torch.cat([y for _, y in data]).float()
raw_w = compute_pos_weight_candidate(labels_all)

def _slice_ok(w: float) -> bool:
    return run_training_slice(AIRhythmCRNN().to(DEVICE), data, w, device=DEVICE)

final_w, halvings = stability_probe(_slice_ok, raw_w)
print(f"pos_weight raw={raw_w:.1f} final={final_w:.1f} halvings={halvings}")  # BOTH logged (TRN-01)

# TRN-02 loop + TRN-03 gate (D-05: package owns the loop; cell only chains it)
model = AIRhythmCRNN().to(DEVICE)
result = run_toy_overfit_gate(model, data, device=DEVICE, pos_weight=final_w,
                              max_epochs=config.MAX_EPOCHS)

# D-03 diagnostics + degeneracy verdict + D-02 literal bool
print(f"P={result['precision']:.4f} R={result['recall']:.4f} "
      f"pred_rate={result['pred_rate']:.4f} final_loss={result['final_loss']:.4f} "
      f"epoch={result['epoch']} halted={result['halted']} reason={result['halt_reason']}")
print(f"degeneracy healthy={rate_breach(result['pred_rate'], result['true_rate']) is None}")
gate_pass = bool(result["passed"] and not result["halted"])
print(f"TOY OVERFIT GATE: {'PASS' if gate_pass else 'FAIL'} (need P>={config.GATE_P} AND R>={config.GATE_R}, epoch<={config.MAX_EPOCHS})")
assert gate_pass, "Phase 7 toy gate FAILED — PLAN.md debug order: (1) alignment test (2) pos_weight logs (3) capacity"
print("Phase 7 TRN-01/TRN-02/TRN-03: PASS")


# %% ============================================================
# CELL 12: Save checkpoint (Phase 8 resume contract seed — EXP-02 keys)
# =============================================================
ckpt_dir = str(WORKING / "checkpoints")
os.makedirs(ckpt_dir, exist_ok=True)
ckpt_path = f"{ckpt_dir}/phase7_toy_gate.pt"
torch.save({
    "model": model.state_dict(),
    "optimizer": result["optimizer"].state_dict(),
    "scheduler": result["scheduler"].state_dict(),
    "epoch": result["epoch"],
    "pos_weight": final_w,
    "stage": "phase7_toy_gate",
}, ckpt_path)
print(f"Checkpoint saved: {ckpt_path} (pos_weight={final_w:.1f}, epoch={result['epoch']})")
if "show_storage" in globals():  # CELL 2 optional — Phase 7 paste-set is CELL 0+11+12
    show_storage("Working disk after checkpoint", str(WORKING))


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
