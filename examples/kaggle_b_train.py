#!/usr/bin/env python3
"""NOTEBOOK B — attach Dataset → train → checkpoint → publish checkpoint.

Prereqs: Notebook A run (corpus published as CORPUS_HANDLE); enable GPU.
Attach via Data → Add data: the corpus dataset (airhythm-corpus) and,
for resume across sessions, the checkpoint dataset (airhythm-data).

Cells: 0 setup, 2 storage, 6/7 toy baseline, 9-12 model + gates,
13 train (resume → corpus preflight → ~30min push), 14 session-end push.
Cell numbers are the historical single-notebook numbering (08-07 plan
references CELL 0/13/14).
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
# CELL 13: Full training (Phase 8) — resume (D-11) -> train (D-08) -> time push (D-10)
# =============================================================
import json
import os
import shutil
import subprocess
import time
import torch
from pathlib import Path

from airhythm import config
from airhythm.kaggle_push import prune_old_checkpoints
from airhythm.model import AIRhythmCRNN
from airhythm.train import (build_real_loaders, epoch_cap, load_checkpoint,
                            median_epoch_time, resume_smoke_test, run_real_training)

WORKING = Path(os.environ.get("KAGGLE_WORKING_DIR", config.EPHEMERAL_DIR))
CKPT_DIR = WORKING / config.CHECKPOINTS_DIR
CKPT_DIR.mkdir(exist_ok=True)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
POS_WEIGHT = 36.4  # Phase 7 logged seed (CELL 11 output: pos_weight raw=36.4 final=36.4)

# D-16 frozen eval ids — read metadata/eval_song_ids.json when present (song_ids/search_set_ids)
_eval_meta = Path("metadata/eval_song_ids.json")
if _eval_meta.exists():
    _meta = json.load(open(_eval_meta))
    EVAL_IDS = [int(x) for x in _meta["song_ids"]]
    SEARCH_ID = int(_meta["search_set_ids"][0])
else:
    EVAL_IDS = [2255671, 2256944, 2516285, 2527391, 2589624]
    SEARCH_ID = 2561773

# --- preflight: local resume smoke (CPU, ~seconds) before any GPU minute
smoke = resume_smoke_test(device="cpu")
print("resume smoke:", "PASS" if smoke["pass"] else "FAIL", smoke)
assert smoke["pass"], "resume smoke FAILED — do not start GPU training (EXP-02 criterion 4)"

# --- corpus (prints 'corpus: train=... excluded=...' audit line)
# Notebook A publishes the corpus; seed the writable working copy from the
# attached dataset once (full-song cache writes *_full_spec.npy into song
# dirs, and /kaggle/input is read-only). AIRHYTHM_DATA still overrides.
LOCAL_DATA = WORKING / "data" / "minimal_dataset"
if not LOCAL_DATA.is_dir():
    _att = Path("/kaggle/input") / config.CORPUS_HANDLE / "minimal_dataset"
    if _att.is_dir():
        print(f"copying attached corpus {_att} -> {LOCAL_DATA}")
        _tmp = LOCAL_DATA.with_name("minimal_dataset.partial")
        if _tmp.exists():
            shutil.rmtree(_tmp)
        shutil.copytree(_att, _tmp)
        _tmp.rename(LOCAL_DATA)
DATA_ROOT = Path(os.environ.get("AIRHYTHM_DATA", str(LOCAL_DATA)))
print(f"DATA_ROOT = {DATA_ROOT}")
song_dirs = sorted(p for p in DATA_ROOT.iterdir() if p.is_dir())
# P0-level data-integrity preflight: frozen eval/search songs must exist —
# split exclusion ≠ presence (random corpus download may omit them).
_required = set(EVAL_IDS) | {SEARCH_ID}
_missing = sorted(_required - {int(d.name) for d in song_dirs})
assert not _missing, f"Missing frozen eval/search songs: {_missing}"
train_loader, val_loader, info = build_real_loaders(
    song_dirs, eval_ids=EVAL_IDS, search_id=SEARCH_ID,
    num_workers=2, pin_memory=DEVICE.startswith("cuda"))  # Kaggle = 4 cores
assert not (set(info["train_ids"]) | set(info["val_ids"])) & (set(EVAL_IDS) | {SEARCH_ID})

# --- resume (D-11): local latest_*.pt (manually web-downloaded, or written by
# an earlier run in this session) OR the attached checkpoint dataset)
model = AIRhythmCRNN().to(DEVICE)
optimizer = torch.optim.AdamW(model.parameters(), lr=config.TRAIN_LR, weight_decay=config.TRAIN_WD)
scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
    optimizer, mode="min", patience=config.SCHED_PATIENCE, factor=config.SCHED_FACTOR)

def _ckpt_globs(pat):
    """Local working copy first, then the attached checkpoint dataset — a fresh
    session resumes from Notebook B's published push without a web pull.
    Attached hits are COPIED into CKPT_DIR: push_now() publishes CKPT_DIR only,
    so without the copy an attached best_*.pt vanishes from the published
    dataset when this session never improves past it (review #5)."""
    hits = sorted(CKPT_DIR.glob(pat))
    if hits:
        return hits
    _att = Path("/kaggle/input") / config.DATASET_HANDLE
    for src in sorted(_att.glob(pat)) if _att.is_dir() else []:
        shutil.copy2(src, CKPT_DIR / src.name)
    return sorted(CKPT_DIR.glob(pat))

start_epoch, global_step, resume_val = 0, 0, None
resume_candidates = _ckpt_globs("latest_*.pt")
if resume_candidates:  # load prints "resume: epoch=... global_step=..." (D-11 assert)
    ckpt = load_checkpoint(str(resume_candidates[-1]), model=model, optimizer=optimizer,
                           scheduler=scheduler, device=DEVICE)
    start_epoch, global_step = ckpt["epoch"], ckpt["global_step"]
    resume_val = ckpt.get("val_metric")
    # best over ALL sessions lives in best_*.pt — latest val_metric alone would
    # re-open best_ selection at a worse value after restart (review P1).
    _best_cands = _ckpt_globs("best_*.pt")
    if _best_cands:
        _best = torch.load(_best_cands[-1], map_location="cpu", weights_only=False)
        _bv = _best.get("val_metric")
        if _bv is not None:
            resume_val = _bv if resume_val is None else min(resume_val, _bv)
    assert ckpt["stage"].startswith("phase8"), f"wrong-stage checkpoint: {ckpt['stage']}"
    print(f"RESUMED at epoch={start_epoch} global_step={global_step}")
else:
    print("no local checkpoint — fresh start")

# --- time-based checkpoint push (D-09: 1 latest + 1 best; D-10: ~30min cadence)
PUSH_INTERVAL_S = 1800  # PLAN.md default ~30min
_last_push = {"t": time.time()}

def push_now():
    prune_old_checkpoints(str(CKPT_DIR), keep_latest=1, keep_best=1)  # D-09: 1 latest + 1 best
    # CLI needs -p <dir with dataset-metadata.json> + visible failures (review P0).
    meta = CKPT_DIR / "dataset-metadata.json"
    if not meta.exists():
        meta.write_text(json.dumps({
            "id": f"{os.environ.get('KAGGLE_USERNAME', '')}/{config.DATASET_HANDLE}",
            "title": config.DATASET_HANDLE,
            "licenses": [{"name": "CC0-100"}],
        }, indent=2))
    msg = f"phase8 checkpoint {time.strftime('%Y-%m-%d %H:%M')}"
    r = subprocess.run(["kaggle", "datasets", "version", "-p", str(CKPT_DIR), "-m", msg])
    if r.returncode != 0:  # first push: dataset doesn't exist yet -> create it
        subprocess.run(["kaggle", "datasets", "create", "-p", str(CKPT_DIR),
                        "-s", config.DATASET_HANDLE], check=True)

def maybe_push(epoch, epoch_times):  # wired as run_real_training on_epoch_end
    if time.time() - _last_push["t"] >= PUSH_INTERVAL_S:
        _last_push["t"] = time.time()
        try:
            push_now()
            print(f"pushed at epoch={epoch} (D-10 {PUSH_INTERVAL_S // 60}min cadence)")
        except subprocess.CalledProcessError as e:
            # visible, but never kill a 12h run over a push: local ckpts still save
            print(f"PUSH FAILED at epoch={epoch} ({e}) — will retry next cadence")

# --- train (D-08): fresh session epoch cap from measured time; resume runs until stop
result = run_real_training(
    train_loader, val_loader, pos_weight=POS_WEIGHT, device=DEVICE,
    ckpt_dir=str(CKPT_DIR), model=model, optimizer=optimizer, scheduler=scheduler,
    start_epoch=start_epoch, global_step=global_step, best_val=resume_val,
    max_epochs=epoch_cap(median_epoch_time([600.0])) if start_epoch == 0 else None,
    on_epoch_end=maybe_push)
print("stopped_reason:", result["stopped_reason"], "best_val:", result["best_val_loss"])

# D-10: recompute display after run (median epoch times, epoch-1 warm-up discarded)
if len(result["epoch_times"]) >= 2:
    print(f"push cadence checked at epoch {start_epoch + len(result['epoch_times'])}: "
          f"median_epoch_h={median_epoch_time(result['epoch_times']):.3f}")
push_now()  # always push at clean session end (D-10)


# %% ============================================================
# CELL 14: Push to Kaggle Dataset (end of session)
# =============================================================
# D-10 session-end push — CLI only (D-11: resume pull is a manual Kaggle web download
# OR the attached checkpoint dataset — CELL 13's _ckpt_globs finds it).
# CELL 13's push_now() already does both; standalone fallback:
#
# from airhythm.kaggle_push import prune_old_checkpoints
# prune_old_checkpoints(str(WORKING / config.CHECKPOINTS_DIR), keep_latest=1, keep_best=1)
# subprocess.run(["kaggle", "datasets", "version", "-m", "phase8 session end"])

print("\n=== Workflow complete ===")
print("Phase 6 (shape+alignment) - Cell 10")
print("Phase 7 (toy overfit gate) - Cell 11")
print("Phase 8 (full training+gate) - Cell 13 -> Notebook C Cell 15")
print("Phase 9 (ONNX export)      - after Phase 8")
print("Phase 10 (JSON charts)     - after Phase 9")
