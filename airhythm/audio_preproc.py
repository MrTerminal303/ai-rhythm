"""Audio preprocessing pipeline for AIRhythm.

Extracts audio from .osz archives, converts to mel-spectrograms using torchaudio,
chunks into (1, 128, 400) frames, normalizes, and extracts onset labels from parsed
.osu hit objects. This is the production data pipeline used for all training phases.

Per D-03: DC offset removal before STFT. torchaudio (not librosa) for MelSpectrogram.
Per config.py: single source for all mel-spectrogram parameters.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import zipfile
from typing import Any, Dict, List, Optional, Tuple

import librosa
import numpy as np
import torch
import torchaudio

from airhythm import config

__all__ = [
    "load_audio_from_osz",
    "remove_dc_offset",
    "audio_to_mel_spec",
    "chunk_spectrogram",
    "normalize_chunk",
    "extract_chunk_labels",
    "preprocess_osz",
]

logger = logging.getLogger(__name__)


def _sanitize_filename(name: str) -> str:
    """Replace unsafe filename characters with underscores.

    Keeps alphanumeric characters, hyphens, underscores, and dots.
    Everything else becomes an underscore.
    """
    sanitized = re.sub(r"[^\w\-.]", "_", name)
    return sanitized.strip("_")


def _extract_audio_filename(osu_content: str) -> Optional[str]:
    """Extract AudioFilename value from .osu file content.

    The [General] section contains AudioFilename=<path/to/audio>.
    Returns None if not found.
    """
    for line in osu_content.splitlines():
        stripped = line.strip()
        if stripped.startswith("AudioFilename:"):
            return stripped.split(":", 1)[1].strip()
    return None


def load_audio_from_osz(
    osz_bytes: bytes, audio_filename: str
) -> Tuple[np.ndarray, int]:
    """Load audio waveform from a .osz archive.

    Opens the .osz (zip) archive, locates the audio file by normalized
    filename, and decodes it with librosa as a universal audio decoder
    (handles mp3, ogg, wav).

    Args:
        osz_bytes: Raw bytes of the .osz file (zip archive).
        audio_filename: AudioFilename value from .osu [General] section.

    Returns:
        Tuple of (audio_waveform, sample_rate). Waveform is float32
        np.ndarray shape (N,) at SAMPLE_RATE (22050 Hz).

    Raises:
        FileNotFoundError: If audio_filename cannot be found in the archive.
        ValueError: If the .osz archive is invalid, or the audio is corrupt
            and cannot be decoded.
    """
    # Normalize: strip leading ./, .\ for cross-platform paths
    normalized = audio_filename.lstrip("./\\")

    try:
        with zipfile.ZipFile(io.BytesIO(osz_bytes)) as zf:
            # Try exact match first
            if normalized in zf.namelist():
                audio_bytes = zf.read(normalized)
            else:
                # Case-insensitive search through namelist
                namelist_lower = {name.lower(): name for name in zf.namelist()}
                normalized_lower = normalized.lower()
                if normalized_lower in namelist_lower:
                    audio_bytes = zf.read(namelist_lower[normalized_lower])
                else:
                    raise FileNotFoundError(
                        f"Audio file '{audio_filename}' not found in .osz archive"
                    )
    except zipfile.BadZipFile as e:
        raise ValueError(f"Invalid .osz archive: {e}") from e

    # Decode with librosa as universal decoder
    try:
        waveform, sr = librosa.load(
            io.BytesIO(audio_bytes), sr=config.SAMPLE_RATE, mono=True
        )
    except Exception as e:
        # Corrupt/truncated audio: soundfile raises LibsndfileError (a
        # RuntimeError), which callers catching ValueError would miss and a
        # batch run would die on. Normalize to the documented ValueError.
        raise ValueError(f"Audio decode failed for '{audio_filename}': {e}") from e
    if waveform.size == 0:
        raise ValueError(f"Audio '{audio_filename}' decoded to zero samples")
    return (waveform.astype(np.float32), sr)


def remove_dc_offset(audio: np.ndarray) -> np.ndarray:
    """Remove DC offset from audio signal.

    Per D-03: DC offset removal must happen before STFT.

    Args:
        audio: Input audio waveform as float32 np.ndarray shape (N,).

    Returns:
        Float32 array with zero mean.
    """
    return (audio - audio.mean()).astype(np.float32)


def audio_to_mel_spec(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Convert audio waveform to log-power mel-spectrogram.

    Uses torchaudio transforms (not librosa) for the production pipeline,
    matching Phase 1+ training. DC offset is removed before STFT per D-03.

    Args:
        audio: Audio waveform as float32 np.ndarray shape (N,).
        sample_rate: Sample rate of the audio (unused — sr from config).

    Returns:
        Log-power mel-spectrogram as float32 np.ndarray
        shape (1, N_MELS, T) with an added channel dimension.
    """
    # DC offset removal before STFT per D-03
    audio = remove_dc_offset(audio)

    # torchaudio MelSpectrogram (HTK formula, matching Phase 1 training)
    mel_spec_transform = torchaudio.transforms.MelSpectrogram(
        sample_rate=config.SAMPLE_RATE,
        n_fft=config.N_FFT,
        hop_length=config.HOP_LENGTH,
        n_mels=config.N_MELS,
        power=config.POWER,
    )

    spec_t = mel_spec_transform(torch.from_numpy(audio).float())

    # Log-power: log1p avoids log(0)
    spec_db = torch.log1p(spec_t)

    # Add channel dim -> (1, N_MELS, T) for Conv2d input
    spec_db = spec_db.unsqueeze(0)

    return spec_db.numpy().astype(np.float32)


def chunk_spectrogram(
    spec: np.ndarray,
    n_frames: int = 400,
    hop_frames: Optional[int] = None,
) -> List[np.ndarray]:
    """Split a mel-spectrogram into fixed-length chunks along the time axis.

    Slides a window along the time dimension (axis=2). If the spectrogram
    is shorter than n_frames, pads by repeating the last frame.

    Args:
        spec: Spectrogram as float32 np.ndarray shape (1, N_MELS, T).
        n_frames: Number of time frames per chunk.
        hop_frames: Step size between chunk starts. If None, uses
            non-overlapping chunks (hop_frames = n_frames).

    Returns:
        List of (1, N_MELS, n_frames) float32 np.ndarray chunks.
    """
    if hop_frames is None:
        hop_frames = n_frames

    _, n_mels, time_frames = spec.shape
    chunks: List[np.ndarray] = []

    if time_frames < n_frames:
        # Pad by repeating the last frame
        pad_width = n_frames - time_frames
        padded = np.pad(spec, ((0, 0), (0, 0), (0, pad_width)), mode="edge")
        chunks.append(padded.astype(np.float32))
        return chunks

    for start in range(0, time_frames - n_frames + 1, hop_frames):
        chunk = spec[:, :, start : start + n_frames]
        chunks.append(chunk.astype(np.float32))

    # Option B (review #3): never silently drop the tail — if the last window
    # doesn't reach the song end, append one edge-padded partial chunk so
    # labels + training + eval all include the final frames.
    if chunks and (len(chunks) - 1) * hop_frames + n_frames < time_frames:
        start = (len(chunks) - 1) * hop_frames + n_frames
        tail = np.pad(
            spec[:, :, start:],
            ((0, 0), (0, 0), (0, n_frames - (time_frames - start))),
            mode="edge",
        )
        chunks.append(tail.astype(np.float32))

    return chunks


def normalize_chunk(chunk: np.ndarray) -> np.ndarray:
    """Normalize a spectrogram chunk to zero mean and unit variance.

    Uses 1e-8 epsilon to prevent division by zero on silent chunks.

    Args:
        chunk: Spectrogram chunk as np.ndarray.

    Returns:
        Normalized chunk as float32 np.ndarray with mean ~0 and std ~1.
    """
    return ((chunk - chunk.mean()) / (chunk.std() + 1e-8)).astype(np.float32)


def extract_chunk_labels(
    hit_objects: list,
    chunk_start_frame: int,
    n_frames: int,
) -> np.ndarray:
    """Extract active/onset/count labels for a chunk from hit objects.

    Rows (dtype int8, shape (3, n_frames)):
        active: 1 for every frame inside a hold's [time, end_time) span.
        onset:  1 at frame where a note starts.
        count:  number of notes whose start frame is this frame (0-4+).

    Converts hit object times (milliseconds) to frame indices on the REAL mel
    grid via config.ms_to_frame (config.FPS = SAMPLE_RATE/HOP_LENGTH ≈ 100.227 Hz).

    Args:
        hit_objects: List of HitObject from osu_parser.
        chunk_start_frame: Start frame index (0-indexed) for this chunk.
        n_frames: Number of frames in the chunk.

    Returns:
        (3, n_frames) int8 label array. Row 0 active, row 1 onset, row 2 count.
    """
    labels = np.zeros((3, n_frames), dtype=np.int8)
    chunk_end_frame = chunk_start_frame + n_frames

    for ho in hit_objects:
        start = config.ms_to_frame(ho.time)
        end = config.ms_to_frame(ho.end_time)
        if not (chunk_start_frame <= start < chunk_end_frame):
            continue
        local = start - chunk_start_frame
        labels[1, local] = 1              # onset at start
        labels[2, local] += 1             # count += 1
        # active: from start to end-1 (half-open span)
        active_end = min(end, chunk_end_frame)
        active_start = max(start, chunk_start_frame)
        span_end = active_end if active_end > active_start else active_start + 1
        labels[0, active_start - chunk_start_frame : span_end - chunk_start_frame] = 1

    return labels


def preprocess_osz(
    osz_bytes: bytes,
    beatmapset_id: int,
    output_dir: str,
) -> List[Dict[str, Any]]:
    """Full preprocessing pipeline for a .osz file.

    Parses mania .osu files, extracts audio, converts to mel-spectrogram,
    chunks, normalizes, extracts onset labels, and saves all artifacts to
    output_dir as .npy and .json files.

    Per T-00-13: Catches parse failures, missing audio, and continues
    with warnings rather than crashing.

    Args:
        osz_bytes: Raw bytes of the .osz file.
        beatmapset_id: Beatmapset identifier for file naming.
        output_dir: Directory for saved .npy and .json files.

    Returns:
        List of dicts with keys: file_type, path, beatmapset_id,
        difficulty_name. Empty list if no mania maps found.
    """
    from airhythm.osu_parser import find_audio_file, parse_osz

    parsed = parse_osz(osz_bytes)
    if not parsed:
        logger.warning("No mania beatmaps found in %d", beatmapset_id)
        return []

    # Build osu_filename -> content map for AudioFilename extraction
    osu_content_map: Dict[str, str] = {}
    try:
        with zipfile.ZipFile(io.BytesIO(osz_bytes)) as zf:
            for _, _, osu_filename in parsed:
                try:
                    osu_content_map[osu_filename] = zf.read(osu_filename).decode(
                        "utf-8", errors="replace"
                    )
                except Exception as e:
                    logger.warning(
                        "Failed to read %s from %d: %s",
                        osu_filename,
                        beatmapset_id,
                        e,
                    )
    except zipfile.BadZipFile as e:
        logger.warning("Invalid .osz for %d: %s", beatmapset_id, e)
        return []

    saved_files: List[Dict[str, Any]] = []
    processed_difficulties: set = set()

    for metadata, hit_objects, osu_filename in parsed:
        # Skip if we already processed this .osu file
        if osu_filename in processed_difficulties:
            continue
        processed_difficulties.add(osu_filename)

        # Dataset contract = 4K (review #3): archives may list 5K/7K first —
        # never train on a non-4K just because of zip order. Missing CircleSize
        # parses to CS_DEFAULT=4, so legacy 4K maps without the key keep working.
        if metadata.cs != config.CS_DEFAULT:
            logger.warning(
                "Skipping cs=%s difficulty %r in %d (dataset contract = 4K)",
                metadata.cs, metadata.difficulty_name, beatmapset_id,
            )
            continue

        # Extract AudioFilename from .osu content
        osu_content = osu_content_map.get(osu_filename)
        if osu_content is None:
            continue
        audio_filename = _extract_audio_filename(osu_content)
        if audio_filename is None:
            logger.warning(
                "No AudioFilename in %s for %d", osu_filename, beatmapset_id
            )
            continue

        # Load audio from .osz
        try:
            waveform, sr = load_audio_from_osz(osz_bytes, audio_filename)
        except (FileNotFoundError, ValueError) as e:
            logger.warning(
                "Failed to load audio for %d (%s): %s",
                beatmapset_id,
                audio_filename,
                e,
            )
            continue

        # Convert to mel-spectrogram
        spec = audio_to_mel_spec(waveform, sr)

        # Chunk spectrogram (non-overlapping chunks for training)
        chunks = chunk_spectrogram(spec, n_frames=config.N_FRAMES)
        if not chunks:
            continue

        # Save original audio bytes for debug/playback (not the model input)
        try:
            with open(os.path.join(output_dir, "original.audio"), "wb") as af:
                af.write(find_audio_file(osz_bytes, audio_filename) or b"")
        except OSError as exc:
            logger.warning("Failed to save original audio for %d: %s", beatmapset_id, exc)

        # Sanitize difficulty name for filenames
        difficulty_slug = _sanitize_filename(metadata.difficulty_name) or "unknown"

        metadata_dict: Dict[str, Any] = {
            "beatmapset_id": beatmapset_id,
            "title": metadata.title,
            "artist": metadata.artist,
            "difficulty_name": metadata.difficulty_name,
            "bpm": metadata.bpm,
            "cs": metadata.cs,
            "num_chunks": len(chunks),
            "chunk_frames": config.N_FRAMES,
            "files": [],
        }

        for chunk_idx, chunk in enumerate(chunks):
            # Compute chunk start frame (non-overlapping)
            chunk_start_frame = chunk_idx * config.N_FRAMES

            # Normalize chunk
            normalized = normalize_chunk(chunk)

            # Extract active/onset/count labels for this chunk
            labels = extract_chunk_labels(
                hit_objects,
                chunk_start_frame=chunk_start_frame,
                n_frames=config.N_FRAMES,
            )

            # Save normalized spectrogram chunk
            chunk_filename = f"{chunk_idx:04d}.npy"
            chunk_filepath = os.path.join(output_dir, chunk_filename)
            np.save(chunk_filepath, normalized)

            # Save onset labels
            labels_filename = f"{chunk_idx:04d}_labels.npy"
            labels_filepath = os.path.join(output_dir, labels_filename)
            np.save(labels_filepath, labels)

            metadata_dict["files"].append(chunk_filename)
            saved_files.append(
                {
                    "file_type": "spectrogram",
                    "path": chunk_filepath,
                    "beatmapset_id": beatmapset_id,
                    "difficulty_name": metadata.difficulty_name,
                }
            )

        # Save per-difficulty metadata JSON
        meta_filename = f"{beatmapset_id}_{difficulty_slug}.json"
        meta_filepath = os.path.join(output_dir, meta_filename)
        with open(meta_filepath, "w") as f:
            json.dump(metadata_dict, f, indent=2)

        saved_files.append(
            {
                "file_type": "metadata",
                "path": meta_filepath,
                "beatmapset_id": beatmapset_id,
                "difficulty_name": metadata.difficulty_name,
            }
        )

        # Process only the first difficulty (subsequent diffs share the
        # same audio file but differ in hit_objects; Phase 1 expands this)
        break

    return saved_files
