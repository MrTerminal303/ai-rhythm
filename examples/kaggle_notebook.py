#!/usr/bin/env python3
"""Example: Using AIRhythm on Kaggle.

Steps:
1. In Kaggle, add the "airhythm-data" dataset to your notebook
2. Copy this file into a notebook cell
3. Run each section as a separate cell
"""
# %% Cell 1: Setup — add project to Python path
import sys
from pathlib import Path

# Debug: show what's mounted
print("=== Mounted datasets ===")
kaggle_input = Path("/kaggle/input")
if kaggle_input.is_dir():
    for child in kaggle_input.iterdir():
        print(f"  {child}/")
        if child.is_dir():
            for item in child.iterdir():
                prefix = "    " + ("├── " if item != list(child.iterdir())[-1] else "└── ")
                print(f"{prefix}{item.name}/" if item.is_dir() else f"{prefix}{item.name}")
else:
    print("  Not on Kaggle (/kaggle/input not found)")

def find_airhythm_root() -> Path:
    """Find the project root containing airhythm/ package.

    Searches up to 3 levels deep under /kaggle/input/, then local cwd.
    """
    kaggle_input = Path("/kaggle/input")
    if kaggle_input.is_dir():
        candidates = list(kaggle_input.iterdir())
        for d1 in candidates:
            if not d1.is_dir():
                continue
            if (d1 / "airhythm" / "__init__.py").exists():
                return d1
            for d2 in d1.iterdir():
                if not d2.is_dir():
                    continue
                if (d2 / "airhythm" / "__init__.py").exists():
                    return d2
                for d3 in d2.iterdir():
                    if d3.is_dir() and (d3 / "airhythm" / "__init__.py").exists():
                        return d3

    for candidate in [Path.cwd(), Path.cwd().parent]:
        if (candidate / "airhythm" / "__init__.py").exists():
            return candidate

    raise FileNotFoundError(
        "Cannot find airhythm package. "
        "The dataset must contain airhythm/__init__.py at some level.\n"
        "Add the dataset: right sidebar → Data → Add data → search 'airhythm'"
    )

airhythm_root = find_airhythm_root()
sys.path.insert(0, str(airhythm_root))
print(f"Project root: {airhythm_root}")

# Verify imports work
import airhythm
from airhythm import config
print(f"airhythm version: {airhythm.__version__}")
print(f"Sample rate: {config.SAMPLE_RATE}")
print(f"Max dataset: {config.MAX_DATASET_GB} GB")


# %% Cell 2: Check storage usage
from airhythm.kaggle_push import estimate_storage_size
from airhythm import config

dataset_dir = str(airhythm_root)
info = estimate_storage_size(dataset_dir)
total_gb = info["total_mb"] / 1024.0
pct = (total_gb / config.MAX_DATASET_GB) * 100

status = "OK" if pct < 80 else "WARNING" if pct < 100 else "OVER LIMIT"
print(f"Dataset dir: {dataset_dir}")
print(f"Storage: {total_gb:.2f} / {config.MAX_DATASET_GB:.0f} GB ({pct:.1f}%)")
print(f"Status: {status}")

# Show what's taking space
for ext, size in sorted(info["by_extension"].items(), key=lambda x: -x[1])[:5]:
    print(f"  {ext:10s} {size / 1024**2:.1f} MB")


# %% Cell 3: List available songs
data_dir = airhythm_root / "data" / "minimal_dataset"
if not data_dir.is_dir():
    print(f"No data at {data_dir}")
    print("Run download_minimal.py first (see Cell 5)")
else:
    songs = []
    for song_dir in sorted(data_dir.iterdir()):
        if song_dir.is_dir() and song_dir.name.isdigit():
            audio = song_dir / "original.audio"
            if audio.exists():
                songs.append(song_dir.name)
    print(f"Available songs ({len(songs)}):")
    for sid in songs:
        print(f"  {sid}/")


# %% Cell 4: Run baseline on a song
import librosa
import numpy as np
from airhythm.baseline import run_librosa_onset_detection, evaluate_onset_fscore

# Pick first available song
if songs:
    sid = songs[0]
    audio_path = data_dir / sid / "original.audio"
    audio, sr = librosa.load(str(audio_path), sr=config.SAMPLE_RATE, mono=True)
    print(f"Loaded {sid}: {len(audio)/sr:.1f}s, sr={sr}")

    # Run onset detection
    onset_times = run_librosa_onset_detection(audio, sr)
    print(f"Detected {len(onset_times)} onsets")
    print(f"First 5: {onset_times[:5]}")
else:
    print("No songs available")


# %% Cell 5: Download more songs (if needed)
# Option A: Run as script
# !python {airhythm_root}/download_minimal.py

# Option B: Import and call directly
from download_minimal import main
saved = main(
    output=str(airhythm_root / "data" / "minimal_dataset"),
    n_songs=3
)
print(f"Downloaded {saved} songs")


# %% Cell 6: Check storage after downloading
info = estimate_storage_size(str(airhythm_root))
total_gb = info["total_mb"] / 1024.0
pct = (total_gb / config.MAX_DATASET_GB) * 100
print(f"After download: {total_gb:.2f} / {config.MAX_DATASET_GB:.0f} GB ({pct:.1f}%)")
if pct > 80:
    print("WARNING: Prune old checkpoints to free space")
    from airhythm.kaggle_push import prune_old_checkpoints
    pruned = prune_old_checkpoints(str(airhythm_root / "checkpoints"))
    print(f"Pruned {pruned} checkpoints")


# %% Cell 7: Use the Streamlit app (run in separate notebook)
# In a new notebook cell:
# !streamlit run {airhythm_root}/test_app_baseline_fit/app.py
