"""AIRhythm shared configuration module.

Every downstream module imports constants from here — no magic numbers elsewhere.

All mel-spectrogram parameters (SAMPLE_RATE, N_FFT, HOP_LENGTH, N_MELS, POWER, FMAX)
use the torchaudio HTK formula per RESEARCH.md Section 3.
"""

__all__ = [
    # Audio processing — mel-spectrogram
    "SAMPLE_RATE",
    "N_FFT",
    "HOP_LENGTH",
    "N_MELS",
    "POWER",
    "FMAX",
    # Chunking
    "N_FRAMES",
    "HOP_FRAMES",
    "CHUNK_DURATION",
    # Tensor shapes
    "INPUT_SHAPE",
    "LABEL_SHAPE",
    # .osu parsing
    "MANIA_MODE",
    "CS_DEFAULT",
    "LANE_CLAMP_MIN",
    "LANE_CLAMP_MAX",
    # Scraper
    "SERIAL_DELAY_MIN",
    "SERIAL_DELAY_MAX",
    "BACKOFF_START",
    "BACKOFF_MULTIPLIER",
    "BACKOFF_MAX_RETRIES",
    "TEST_BATCH_SIZE",
    "SCALE_BATCH_SIZE",
    # Kaggle Dataset structure
    "DATASET_HANDLE",
    "SPECTROGRAMS_DIR",
    "BASELINE_DIR",
    "CHECKPOINTS_DIR",
    "METADATA_DIR",
    # Naming
    "SPECTROGRAM_EXT",
    "METADATA_EXT",
    "MANIFEST_FILENAME",
    "EVAL_SONGS_FILENAME",
    # Kaggle environment
    "MAX_DATASET_GB",
    "EPHEMERAL_DIR",
]

# ── Audio processing — mel-spectrogram ──────────────────────────────
# torchaudio HTK formula, per RESEARCH.md Section 3
SAMPLE_RATE = 22050
N_FFT = 2048
HOP_LENGTH = 220  # 10ms stride = 100Hz frame rate
N_MELS = 128
POWER = 2.0       # power spectrogram (not magnitude)
FMAX = 11025      # librosa onset_strength default (half sample rate)

# ── Chunking ────────────────────────────────────────────────────────
N_FRAMES = 400          # frames per chunk (~4s of audio)
HOP_FRAMES = 200        # sliding window hop for inference (50% overlap)
CHUNK_DURATION = 4.0    # seconds, for documentation

# ── Tensor shapes ───────────────────────────────────────────────────
INPUT_SHAPE = (1, 128, 400)    # (channels, n_mels, time) per Conv2d expectation
LABEL_SHAPE = (400,)           # binary onset vector per chunk

# ── .osu parsing ───────────────────────────────────────────────────
MANIA_MODE = 3           # mode_int=3 for mania
CS_DEFAULT = 4           # default column count for 4K (from Difficulty.OverallDifficulty)
LANE_CLAMP_MIN = 0       # per D-09
LANE_CLAMP_MAX = 3       # CS - 1 for 4K

# ── Scraper ─────────────────────────────────────────────────────────
SERIAL_DELAY_MIN = 1.0   # seconds between requests (D-14)
SERIAL_DELAY_MAX = 2.0   # seconds between requests (D-14)
BACKOFF_START = 2.0      # seconds, start delay for 429 retry (D-15)
BACKOFF_MULTIPLIER = 2.0  # double each retry (D-15)
BACKOFF_MAX_RETRIES = 5   # max retries (D-15)
TEST_BATCH_SIZE = 5       # batch size for initial scraper test
SCALE_BATCH_SIZE = 300    # full scrape target

# ── Kaggle Dataset structure (D-04) ─────────────────────────────────
DATASET_HANDLE = "airhythm-data"
SPECTROGRAMS_DIR = "spectrograms"
BASELINE_DIR = "baseline"
CHECKPOINTS_DIR = "checkpoints"
METADATA_DIR = "metadata"

# ── Naming (D-05) ───────────────────────────────────────────────────
SPECTROGRAM_EXT = ".npy"
METADATA_EXT = ".json"
MANIFEST_FILENAME = "manifest.json"
EVAL_SONGS_FILENAME = "eval_song_ids.json"

# ── Kaggle environment ──────────────────────────────────────────────
MAX_DATASET_GB = 20.0
EPHEMERAL_DIR = "/kaggle/working"  # local disk on Kaggle


def print_config() -> None:
    """Log all configuration constants.

    Used as the first cell in Kaggle/Colab notebooks for version/env info (per I1).
    """
    import sys

    print("=" * 60, file=sys.stdout)
    print("AIRhythm Configuration", file=sys.stdout)
    print("=" * 60, file=sys.stdout)
    print(f"  SAMPLE_RATE      = {SAMPLE_RATE}", file=sys.stdout)
    print(f"  N_FFT            = {N_FFT}", file=sys.stdout)
    print(f"  HOP_LENGTH       = {HOP_LENGTH}", file=sys.stdout)
    print(f"  N_MELS           = {N_MELS}", file=sys.stdout)
    print(f"  POWER            = {POWER}", file=sys.stdout)
    print(f"  FMAX             = {FMAX}", file=sys.stdout)
    print(f"  N_FRAMES         = {N_FRAMES}", file=sys.stdout)
    print(f"  HOP_FRAMES       = {HOP_FRAMES}", file=sys.stdout)
    print(f"  CHUNK_DURATION   = {CHUNK_DURATION}", file=sys.stdout)
    print(f"  INPUT_SHAPE      = {INPUT_SHAPE}", file=sys.stdout)
    print(f"  LABEL_SHAPE      = {LABEL_SHAPE}", file=sys.stdout)
    print(f"  MANIA_MODE       = {MANIA_MODE}", file=sys.stdout)
    print(f"  CS_DEFAULT       = {CS_DEFAULT}", file=sys.stdout)
    print(f"  LANE_CLAMP_MAX   = {LANE_CLAMP_MAX}", file=sys.stdout)
    print(f"  SERIAL_DELAY_MIN = {SERIAL_DELAY_MIN}", file=sys.stdout)
    print(f"  SERIAL_DELAY_MAX = {SERIAL_DELAY_MAX}", file=sys.stdout)
    print(f"  BACKOFF_START    = {BACKOFF_START}", file=sys.stdout)
    print(f"  BACKOFF_MULTIPLIER = {BACKOFF_MULTIPLIER}", file=sys.stdout)
    print(f"  BACKOFF_MAX_RETRIES = {BACKOFF_MAX_RETRIES}", file=sys.stdout)
    print(f"  TEST_BATCH_SIZE  = {TEST_BATCH_SIZE}", file=sys.stdout)
    print(f"  SCALE_BATCH_SIZE = {SCALE_BATCH_SIZE}", file=sys.stdout)
    print(f"  DATASET_HANDLE   = {DATASET_HANDLE}", file=sys.stdout)
    print(f"  MAX_DATASET_GB   = {MAX_DATASET_GB}", file=sys.stdout)
    print(f"  EPHEMERAL_DIR    = {EPHEMERAL_DIR}", file=sys.stdout)
    print("=" * 60, file=sys.stdout)
