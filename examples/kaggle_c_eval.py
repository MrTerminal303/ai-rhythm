#!/usr/bin/env python3
"""NOTEBOOK C — attach Dataset + checkpoint → salience evaluation.

Prereqs: Notebook A (corpus published), Notebook B (best_*.pt published).
Enable GPU (sliding-window inference over 5 eval songs).
Attach via Data → Add data: airhythm-corpus and airhythm-data.

Cells: 0 setup, 15 salience gate (EVL-03 report + EVL-04 pass/fail, D-03
halt on fail). Fresh sessions seed the writable working copy from the
attached corpus and load best_*.pt from working checkpoints, else the
attached checkpoint dataset. Cell numbers are the historical
single-notebook numbering (08-07 plan references CELL 15).
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

# Verify critical imports (incl. scipy/soundfile/numba/requests — review #5:
# fail fast on Kaggle image drift, not at first librosa/scrape call)
import torch, torchaudio, mir_eval, librosa, scipy, soundfile, numba, requests
print(f"torch={torch.__version__} torchaudio={torchaudio.__version__} "
      f"librosa={librosa.__version__} mir_eval={mir_eval.__version__}")
# torch/torchaudio must be Kaggle's matched pair — never pip-mix them (review P1)
assert torch.__version__.split("+")[0].rsplit(".", 1)[0] == \
    torchaudio.__version__.split("+")[0].rsplit(".", 1)[0], \
    f"torch/torchaudio mismatch: {torch.__version__} vs {torchaudio.__version__}"
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
# CELL 15: Salience gate (Phase 8) — EVL-03 report + EVL-04 pass/fail (D-03 halt on fail)
# =============================================================
import json
import os
import shutil
import librosa
import numpy as np
import torch
from pathlib import Path

from airhythm import config
from airhythm.audio_preproc import normalize_chunk
from airhythm.datasets import boundary_fraction, build_full_song_cache, proximity_binned_recall
from airhythm.model import AIRhythmCRNN
from airhythm.pin_baseline import load_song_audio_sr, reconstruct_ref_times
from airhythm.salience_eval import (est_times_from_envelope, run_salience_gate,
                                    stitch_envelope)

# standalone (A1): re-derive context when CELL 13 was not in this notebook
if "WORKING" not in globals():
    WORKING = Path(os.environ.get("KAGGLE_WORKING_DIR", config.EPHEMERAL_DIR))
if "DATA_ROOT" not in globals():
    # fresh session: seed the writable working copy from the attached corpus
    # (Notebook A publish) — build_full_song_cache writes into song dirs and
    # /kaggle/input is read-only. AIRHYTHM_DATA still overrides.
    _local = WORKING / "data" / "minimal_dataset"
    if not _local.is_dir():
        _att = Path("/kaggle/input") / config.CORPUS_HANDLE / "minimal_dataset"
        if _att.is_dir():
            print(f"copying attached corpus {_att} -> {_local}")
            _tmp = _local.with_name("minimal_dataset.partial")
            if _tmp.exists():
                shutil.rmtree(_tmp)
            shutil.copytree(_att, _tmp)
            _tmp.rename(_local)
    DATA_ROOT = Path(os.environ.get("AIRHYTHM_DATA", str(_local)))
print(f"DATA_ROOT = {DATA_ROOT}")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# D-16 frozen eval ids (metadata/eval_song_ids.json: song_ids/search_set_ids)
_eval_meta = Path("metadata/eval_song_ids.json")
if _eval_meta.exists():
    _meta = json.load(open(_eval_meta))
    EVAL_IDS = [int(x) for x in _meta["song_ids"]]
    SEARCH_IDS = {int(x) for x in _meta.get("search_set_ids", [])}
else:
    EVAL_IDS = [2255671, 2256944, 2516285, 2527391, 2589624]
    SEARCH_IDS = {2561773}

# frozen eval/search songs must be present before gating (same preflight as CELL 13)
_present = {int(p.name) for p in DATA_ROOT.iterdir() if p.is_dir()}
_missing = sorted((set(EVAL_IDS) | SEARCH_IDS) - _present)
assert not _missing, f"Missing frozen eval/search songs: {_missing}"

# 1) best-val checkpoint ONLY (D-04: gate-time only + final best-val) —
# local working copy first, else the attached checkpoint dataset (fresh session)
best = sorted((WORKING / config.CHECKPOINTS_DIR).glob("best_*.pt"))
if not best:
    _att_ckpt = Path("/kaggle/input") / config.DATASET_HANDLE
    best = sorted(_att_ckpt.glob("best_*.pt")) if _att_ckpt.is_dir() else []
assert best, "no best_*.pt — run Notebook B (or attach its checkpoint dataset)"
ckpt = torch.load(best[-1], map_location=DEVICE, weights_only=False)
model = AIRhythmCRNN().to(DEVICE)
model.load_state_dict(ckpt["model"])
model.eval()
print(f"gate checkpoint: {best[-1].name} epoch={ckpt['epoch']} stage={ckpt['stage']}")

# 2) per-eval-song sliding-window envelope (hop = config.HOP_FRAMES = 200), sigmoid, stitch
def _sliding_envelope(sdir):
    # raw full-song spec (build_full_song_cache stores RAW, not chunk-normalized):
    # every window is sliced from raw then normalize_chunk(window) — identical
    # to RandomCropDataset training crops. Concatenating stored (independently
    # normalized) chunks would mix normalized halves across chunk boundaries
    # (review #3 P1 train/inference distribution mismatch).
    spec_path, _ = build_full_song_cache(sdir)
    spec = np.load(spec_path)  # (1,128,T) RAW
    n_total = spec.shape[2]
    # cover the tail stitch_envelope would zero out (review P1): align last
    # window to the song end, edge-padding a short final chunk to N_FRAMES.
    starts = list(range(0, max(1, n_total - config.N_FRAMES + 1), config.HOP_FRAMES))
    last_start = max(0, n_total - config.N_FRAMES)
    if starts[-1] != last_start:
        starts.append(last_start)
    windows = []
    for start in starts:
        chunk = spec[:, :, start:start + config.N_FRAMES]
        if chunk.shape[2] < config.N_FRAMES:
            chunk = np.pad(chunk, ((0, 0), (0, 0), (0, config.N_FRAMES - chunk.shape[2])),
                           mode="edge")
        chunk = normalize_chunk(chunk)  # whole 4s window — matches training crops
        chunk_t = torch.tensor(chunk).float().unsqueeze(0).to(DEVICE)
        with torch.no_grad():
            sig = torch.sigmoid(model(chunk_t)).squeeze().cpu().numpy()  # (400,)
        windows.append((start, sig))
    return stitch_envelope(windows, n_total)

song_evals = []
for sid in EVAL_IDS:
    sdir = DATA_ROOT / str(sid)
    env = _sliding_envelope(sdir)
    est_times, dedup = est_times_from_envelope(env)
    audio, sr = load_song_audio_sr(sdir)
    oenv = librosa.onset.onset_strength(y=audio, sr=sr, hop_length=config.HOP_LENGTH,
                                        fmax=config.FMAX)
    print(f"song {sid}: n_est={len(est_times)} dedup_ratio={dedup:.3f}")  # P6: dedup-ratio ~= 1.0
    song_evals.append({
        "song_id": sid,
        "ref_times": reconstruct_ref_times(sdir),
        "oenv": oenv,
        "est_times": est_times,
        "pred_positive_rate": float((env > 0.5).mean()),
    })

# 3) GATE (reads data/eval_pins.json via package default — never recomputes baseline, D-04)
gate = run_salience_gate(song_evals)
print("GATE:", "PASS" if gate["pass"] else "FAIL",
      f"mean_F={gate['mean_F_important']:.4f} bar={gate['bar']:.4f} wins={gate['wins']}/5",
      f"ci95={gate['ci_95']} fragile={gate['fragile']}")
print("per-song deltas:", [round(v, 4) for v in gate["deltas"]])
# D-03: ALL diagnostics printed above (per-song F deltas, P/R per bucket, pred rates)
assert gate["pass"], (
    "GATE FAILED (D-03 kill condition) — debug order: "
    "(1) label order alignment (2) pos_weight re-derivation (3) data. "
    "See diagnostics above: per-song F deltas, P/R per bucket, pred rates.")
print("Phase 8 EVL-04: PASS")

# 4) boundary-fraction report (success criterion 5) + conditional D-05 tool
excluded = set(EVAL_IDS) | SEARCH_IDS
train_dirs = [d for d in sorted(DATA_ROOT.iterdir())
              if d.is_dir() and d.name.isdigit() and int(d.name) not in excluded]
fracs = {d.name: boundary_fraction(d) for d in train_dirs}
mean_frac = float(np.mean(list(fracs.values())))
print(f"boundary-fraction: mean={mean_frac:.4f} max={max(fracs.values()):.4f} songs={len(fracs)}")
if mean_frac > config.BOUNDARY_FRACTION_MAX:
    print("boundary mitigation required — running proximity-binned recall on best checkpoint")
    # D-05 sizing: refs = stored onset labels, est = best-checkpoint inference (one train song)
    d = train_dirs[0]
    env = _sliding_envelope(d)
    est_times, _ = est_times_from_envelope(env)
    est_frames = np.round(np.asarray(est_times) * config.FPS).astype(int)
    labels = np.concatenate([np.load(p) for p in sorted(d.glob("*_labels.npy"))], axis=1)
    ref_frames = np.where(labels[1] == 1)[0]
    pbr = proximity_binned_recall(ref_frames, est_frames)
    print("proximity-binned recall:", pbr)
    if pbr["degradation"]:
        print("D-05 degradation: chunk edge REALLY hurts — context-margin mitigation justified")
    else:
        print("D-05: no edge degradation — mitigation not justified")
else:
    print("boundary-fraction OK — no mitigation needed")
