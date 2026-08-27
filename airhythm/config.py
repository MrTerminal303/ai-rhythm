# AIRhythm shared configuration module
# All downstream modules import constants from here — no magic numbers elsewhere.

from typing import List

# Audio processing — mel-spectrogram (torchaudio HTK formula, per RESEARCH.md Section 3)
SAMPLE_RATE = 22050
N_FFT = 2048
HOP_LENGTH = 220  # 10ms stride = 100Hz frame rate
N_MELS = 128
POWER = 2.0       # power spectrogram (not magnitude)
FMAX = 11025      # librosa onset_strength default (half sample rate)

# Peak-pick (EVL-01 frozen params — search-set calibration in 05-02)
PEAK_PICK_PRE_MAX = 3
PEAK_PICK_POST_MAX = 3
PEAK_PICK_PRE_AVG = 3
PEAK_PICK_POST_AVG = 5
PEAK_PICK_DELTA = 0.3
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
    "print_config",
]
