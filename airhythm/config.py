# AIRhythm shared configuration module
# All downstream modules import constants from here — no magic numbers elsewhere.

from typing import List

# Audio processing — mel-spectrogram (torchaudio HTK formula, per RESEARCH.md Section 3)
SAMPLE_RATE = 22050
N_FFT = 2048
HOP_LENGTH = 220  # ~10ms stride; exact rate is FPS = SAMPLE_RATE/HOP_LENGTH ≈ 100.227 Hz
N_MELS = 128
POWER = 2.0       # power spectrogram (not magnitude)

FPS = SAMPLE_RATE / HOP_LENGTH   # 100.227..., NOT 100 — the real MelSpectrogram frame rate


def ms_to_frame(ms: float) -> int:
    """osu time (ms) -> mel frame index on the REAL grid."""
    return int(round(ms / 1000 * FPS))


def frame_to_ms(frame: float) -> float:
    """mel frame index -> ms (for the future chart-JSON writer — use THIS, never ms/10)."""
    return frame / FPS * 1000

FMAX = 11025      # librosa onset_strength default (half sample rate)

# Peak-pick — option-b as amended in STATE D-10 (2026-10-02): 0.02/15/15
PEAK_PICK_PRE_MAX = 3
PEAK_PICK_POST_MAX = 1
PEAK_PICK_PRE_AVG = 15
PEAK_PICK_POST_AVG = 15
PEAK_PICK_DELTA = 0.02
PEAK_PICK_WAIT = 3
PEAK_PICK_PARAMS = {
    "pre_max": PEAK_PICK_PRE_MAX,
    "post_max": PEAK_PICK_POST_MAX,
    "pre_avg": PEAK_PICK_PRE_AVG,
    "post_avg": PEAK_PICK_POST_AVG,
    "delta": PEAK_PICK_DELTA,
    "wait": PEAK_PICK_WAIT,
}

# Chunking
N_FRAMES = 400          # frames per chunk (~4s of audio)
HOP_FRAMES = 200        # sliding window hop for inference (50% overlap)
CHUNK_DURATION = 4.0    # seconds, for documentation

# Tensor shapes
INPUT_SHAPE = (1, 128, 400)    # (channels, n_mels, time) per Conv2d expectation
LABEL_SHAPE = (3, 400)         # (active, onset, count) per chunk
PARAM_CEILING = 400_000   # D-03 corrected: M1 spec measures 353,121 (06-RESEARCH Open Q1); rejects old CELL 10 (2,062,529)

# .osu parsing
MANIA_MODE = 3           # mode_int=3 for mania
CS_DEFAULT = 4           # default column count for 4K (from Difficulty.OverallDifficulty)
LANE_CLAMP_MIN = 0       # per D-09
LANE_CLAMP_MAX = 3       # CS - 1 for 4K

# Scraper
SERIAL_DELAY_MIN = 1.0   # seconds between requests (D-14)
SERIAL_DELAY_MAX = 2.0   # seconds between requests (D-14)
BACKOFF_START = 2.0      # seconds, start delay for 429 retry (D-15)
BACKOFF_MULTIPLIER = 2.0 # double each retry (D-15)
BACKOFF_MAX_RETRIES = 5  # max retries (D-15)
TEST_BATCH_SIZE = 5      # batch size for initial scraper test
SCALE_BATCH_SIZE = 300   # full scrape target

# Kaggle Dataset structure (D-04)
DATASET_HANDLE = "airhythm-data"
SPECTROGRAMS_DIR = "spectrograms"
BASELINE_DIR = "baseline"
CHECKPOINTS_DIR = "checkpoints"
METADATA_DIR = "metadata"

# Naming (D-05)
SPECTROGRAM_EXT = ".npy"
METADATA_EXT = ".json"
MANIFEST_FILENAME = "manifest.json"
EVAL_SONGS_FILENAME = "eval_song_ids.json"

# Kaggle environment
MAX_DATASET_GB = 20.0
EPHEMERAL_DIR = "/kaggle/working"  # local disk on Kaggle

# Training (Phase 7: TRN-01/02/03)
TRAIN_LR = 1e-3              # AdamW lr (TRN-02)
TRAIN_WD = 1e-4              # AdamW weight_decay (TRN-02)
SCHED_PATIENCE = 3           # ReduceLROnPlateau patience (TRN-02)
SCHED_FACTOR = 0.5           # ReduceLROnPlateau factor (TRN-02)
GRAD_CLIP = 1.0              # clip_grad_norm_ recovery guard (TRN-01)
TRIPWIRE_GRACE_EPOCHS = 10   # D-06 cold-start grace — epochs 1..10 never counted
TRIPWIRE_BREACH_N = 3        # D-06 halt after this many CONSECUTIVE breaches
RATE_LOW_MULT = 0.3          # degeneracy low tail: pred < 0.3*true = predict-nothing
RATE_HIGH_MULT = 3.0         # degeneracy high tail: pred > 3.0*true = all-ones
GATE_P = 0.99                # D-02 frame precision bar
GATE_R = 0.99                # D-02 frame recall bar
SIGMOID_THRESHOLD = 0.5      # gate AND tripwire use this ONE threshold (no drift)
MAX_EPOCHS = 200             # D-04 gate cap, no early stop
N_TOY = 10                   # D-04 metronome_click count

# Training (Phase 8: EVL-04 loop + EXP-02 stop rule)
EARLY_STOP_PATIENCE = 10     # D-08: halt after 10 consecutive epochs of non-improving val loss
EPOCH_CAP_HOURS = 45.0       # D-08: hard cap sized from 30-50h GPU budget (midpoint; discretion)
EPOCH_CAP_FLOOR = 10         # never cap below 10 epochs even if epoch time is huge
VAL_PRINT_EVERY = 1          # D-04: val frame-F printed every epoch — visibility only, never gates


# Datasets (Phase 8: D-05/D-06/D-07)
VAL_SPLIT_EVERY = 10    # D-07: every 10th sorted song ID -> val (~10%), song-level only
BOUNDARY_K = 5          # D-05: onsets within this many frames of a chunk edge count as boundary
BOUNDARY_FRACTION_MAX = 0.05  # success criterion 5: >5% -> mitigation decided


# Salience gate (Phase 8: EVL-03/EVL-04)
GATE_MARGIN = 0.01           # D-01: bar = pin mean_F_important + 0.01 (dust filter)
GATE_MIN_WINS = 3            # D-02: model must beat baseline on >= 3 of 5 eval songs
GATE_TOTAL_SONGS = 5
REPORT_CUTS = (0.2, 0.3, 0.5)  # EVL-03: 0.3 gates (D-01); 0.2/0.5 report-only sensitivity
BOOTSTRAP_N = 10000          # D-02: percentile CI over per-song deltas (discretion: resample count)
BOOTSTRAP_SEED = 0           # reproducible CI
MERGE_TOL_S = 0.05           # eval tolerance: cluster-merge est times within this (same as match window)


def print_config() -> None:
    """Log all config constants — used as first notebook cell per I1."""
    import sys
    for k in __all__:
        v = globals().get(k)
        if v is not None and not callable(v):
            print(f"{k}={v}", file=sys.stderr)
    print("airhythm config loaded", file=sys.stderr)


__all__: List[str] = [
    "SAMPLE_RATE",
    "N_FFT",
    "HOP_LENGTH",
    "N_MELS",
    "POWER",
    "FPS",
    "ms_to_frame",
    "frame_to_ms",
    "FMAX",
    # Peak-pick params (EVL-01 freeze)
    "PEAK_PICK_PRE_MAX",
    "PEAK_PICK_POST_MAX",
    "PEAK_PICK_PRE_AVG",
    "PEAK_PICK_POST_AVG",
    "PEAK_PICK_DELTA",
    "PEAK_PICK_WAIT",
    "PEAK_PICK_PARAMS",
    "N_FRAMES",
    "HOP_FRAMES",
    "CHUNK_DURATION",
    "INPUT_SHAPE",
    "LABEL_SHAPE",
    "PARAM_CEILING",
    "MANIA_MODE",
    "CS_DEFAULT",
    "LANE_CLAMP_MIN",
    "LANE_CLAMP_MAX",
    "SERIAL_DELAY_MIN",
    "SERIAL_DELAY_MAX",
    "BACKOFF_START",
    "BACKOFF_MULTIPLIER",
    "BACKOFF_MAX_RETRIES",
    "TEST_BATCH_SIZE",
    "SCALE_BATCH_SIZE",
    "DATASET_HANDLE",
    "SPECTROGRAMS_DIR",
    "BASELINE_DIR",
    "CHECKPOINTS_DIR",
    "METADATA_DIR",
    "SPECTROGRAM_EXT",
    "METADATA_EXT",
    "MANIFEST_FILENAME",
    "EVAL_SONGS_FILENAME",
    "MAX_DATASET_GB",
    "EPHEMERAL_DIR",
    "TRAIN_LR",
    "TRAIN_WD",
    "SCHED_PATIENCE",
    "SCHED_FACTOR",
    "GRAD_CLIP",
    "TRIPWIRE_GRACE_EPOCHS",
    "TRIPWIRE_BREACH_N",
    "RATE_LOW_MULT",
    "RATE_HIGH_MULT",
    "GATE_P",
    "GATE_R",
    "SIGMOID_THRESHOLD",
    "MAX_EPOCHS",
    "N_TOY",
    "VAL_SPLIT_EVERY",
    "BOUNDARY_K",
    "BOUNDARY_FRACTION_MAX",
    "EARLY_STOP_PATIENCE",
    "EPOCH_CAP_HOURS",
    "EPOCH_CAP_FLOOR",
    "VAL_PRINT_EVERY",
    # Salience gate (Phase 8: EVL-03/EVL-04)
    "GATE_MARGIN",
    "GATE_MIN_WINS",
    "GATE_TOTAL_SONGS",
    "REPORT_CUTS",
    "BOOTSTRAP_N",
    "BOOTSTRAP_SEED",
    "MERGE_TOL_S",
    "print_config",
]
