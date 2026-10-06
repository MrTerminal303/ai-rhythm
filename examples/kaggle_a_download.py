#!/usr/bin/env python3
"""NOTEBOOK A — download → preprocess → validate → publish Dataset.

Paste each cell section into a Kaggle notebook (GPU not required).
Cells: 0 setup, 2 storage, 3 download (pinned eval/search IDs first),
4/5/8 validate, 16 publish corpus to the Kaggle dataset (CORPUS_HANDLE).

Downstream: Notebook B attaches the corpus to train; Notebook C attaches
corpus + checkpoint for the salience gate. Cell numbers are the historical
single-notebook numbering (08-07 plan references CELL 0/3/4/13/15).
"""
# %% ============================================================
# CELL 0: Install missing deps (run once per session)
# =============================================================
# On Kaggle, datasets are read-only — pip doesn't auto-install from requirements.txt.
# numpy: do NOT pin <2.0 — downgrading over the image's numpy corrupts dist-packages
# (ModuleNotFoundError: numpy.char, observed 2026-10-01). Only repair if already broken.

import sys, subprocess
from pathlib import Path

# review #7: current Kaggle documents Python 3.11+ and ships the kaggle CLI —
# fail fast if the image drifts
assert sys.version_info >= (3, 11), f"need Python 3.11+, got {sys.version}"
_kver = subprocess.run(["kaggle", "--version"], capture_output=True, text=True)
print(f"python {sys.version.split()[0]}, kaggle {(_kver.stdout or _kver.stderr).strip()}")

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
# CELL 3: Download songs
# =============================================================
import logging
# Show search page progress (default logger output is invisible in notebooks —
# the old silent search looked frozen for minutes)
logging.basicConfig(level=logging.INFO, format="%(message)s")

from airhythm.download_batch import is_complete_song_dir, main as download_main
from airhythm.audio_preproc import preprocess_osz
from airhythm.scraper import SOURCES, download_osz

DATA_DIR = str(WORKING / "data" / "minimal_dataset")

# P0 (review #4): frozen eval/search IDs first — the random fill shuffles
# candidates and can miss them, aborting CELL 13/15 preflight later.
import json
_eval_meta = Path("metadata/eval_song_ids.json")
if _eval_meta.exists():
    _m = json.load(open(_eval_meta))
    PINNED = sorted({int(x) for x in _m["song_ids"]} | {int(x) for x in _m.get("search_set_ids", [])})
else:
    PINNED = [2255671, 2256944, 2516285, 2527391, 2589624, 2561773]

_dl_srcs = [s for s in SOURCES if SOURCES[s].get("download")]
import time
for bid in PINNED:
    song_dir = Path(DATA_DIR) / str(bid)
    if song_dir.is_dir() and is_complete_song_dir(song_dir):  # review #5: full artifact set, not any-json
        print(f"pinned {bid}: already complete")
        continue
    osz = None
    for src in _dl_srcs:
        osz = download_osz(src, bid)
        if osz is not None:
            break
    assert osz, f"frozen eval/search song {bid} failed to download from all mirrors"
    time.sleep(1.0)  # D-14 serial delay between mirror requests
    song_dir.mkdir(parents=True, exist_ok=True)
    files = preprocess_osz(osz, bid, str(song_dir))
    assert files, f"frozen eval/search song {bid} preprocess failed"
    print(f"pinned {bid}: {len(files)} files")

# n_songs = TOTAL target: resumes to 100 across reruns, prunes partial dirs;
# the 6 pinned songs already complete count toward the target
saved = download_main(output=DATA_DIR, n_songs=100)
print(f"\nDownloaded {saved} new songs to {DATA_DIR}")

# P0: all frozen eval/search songs must exist after CELL 3
_missing = [b for b in PINNED if not is_complete_song_dir(Path(DATA_DIR) / str(b))]
assert not _missing, f"Missing frozen eval/search songs: {_missing}"


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
# CELL 8: Preprocess a song
# =============================================================
if songs:
    song_dir = songs[0]
    print(f"Contents of {song_dir.name}/:")
    for f in sorted(song_dir.iterdir()):
        print(f"  {f.name:30s}  {f.stat().st_size:>10,} bytes")


# %% ============================================================
# CELL 16: Publish corpus dataset (Notebook A end — B/C attach CORPUS_HANDLE)
# =============================================================
import json, os, shutil, subprocess, time
from airhythm import config
from airhythm.kaggle_push import build_corpus_manifest, wait_dataset_ready

# review #7 P0: Kaggle CLI default --dir-mode skip uploads NO folders, so the
# corpus goes out FLAT as song_<sid>__<file>; B/C rebuild <sid>/<file> dirs
# as symlinks via kaggle_path.attach_corpus.
CORPUS_ROOT = WORKING / "data" / "corpus_publish"
CORPUS_ROOT.mkdir(exist_ok=True)
_src_root = WORKING / "data" / "minimal_dataset"
n_files = 0
for song_dir in sorted(_src_root.iterdir()):
    if song_dir.is_dir() and song_dir.name.isdigit():
        for f in song_dir.iterdir():
            n_files += 1
            dst = CORPUS_ROOT / f"song_{song_dir.name}__{f.name}"
            if dst.exists() or dst.is_symlink():
                continue
            try:
                os.link(f, dst)  # hardlink — same fs, zero copy
            except OSError:
                shutil.copy2(f, dst)  # cross-fs fallback
print(f"flat corpus staged: {n_files} files -> {CORPUS_ROOT}")

# A5 corpus manifest (review #9): ships at the dataset root so B/C read it for
# RUN_META + resume validation (B9). corpus_version = hash over song IDs.
manifest = build_corpus_manifest(_src_root, target_songs=100,
                                 pinned_ids=PINNED if "PINNED" in globals() else None)
(CORPUS_ROOT / "corpus_manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True))
print(f"manifest: version={manifest['corpus_version']} songs={manifest['song_count']} "
      f"complete={manifest['complete_song_count']} pinned={manifest['pinned_song_count']}")
assert manifest["complete_song_count"] == manifest["song_count"], (
    f"incomplete songs in corpus: {manifest['song_count'] - manifest['complete_song_count']}")

meta = CORPUS_ROOT / "dataset-metadata.json"
if not meta.exists():
    meta.write_text(json.dumps({
        "id": f"{os.environ.get('KAGGLE_USERNAME', '')}/{config.CORPUS_HANDLE}",
        "title": config.CORPUS_HANDLE,
        "licenses": [{"name": "CC0-1.0"}],
    }, indent=2))
msg = f"corpus {time.strftime('%Y-%m-%d %H:%M')}"
r = subprocess.run(["kaggle", "datasets", "version", "-p", str(CORPUS_ROOT), "-m", msg])
if r.returncode != 0:  # first push: no dataset yet — slug comes from
    # dataset-metadata.json "id"; current CLI create has no -s (review #6)
    subprocess.run(["kaggle", "datasets", "create", "-p", str(CORPUS_ROOT)],
                   check=True)
print(f"corpus published: {os.environ.get('KAGGLE_USERNAME', '')}/{config.CORPUS_HANDLE}"
      " — attach in Notebook B/C (Data → Add data)")
# review #8 #1: upload may still process after version/create — poll until READY
wait_dataset_ready(f"{os.environ.get('KAGGLE_USERNAME', '')}/{config.CORPUS_HANDLE}")
