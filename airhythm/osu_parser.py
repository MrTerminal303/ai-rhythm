"""Minimal .osu parser for mania beatmaps.

Extracts only ML-relevant labels from .osu files inside .osz archives:
note time, end_time (for sliders/LNs), lane (from x-coordinate), type bitmask.
No timing point parsing per D-08 — audio is source of truth for timing.
"""

from __future__ import annotations

import io
import logging
import zipfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from airhythm import config

__all__ = [
    "HitObject",
    "BeatmapMetadata",
    "lane_from_x",
    "parse_hit_object_line",
    "parse_osu",
    "parse_osz",
    "find_audio_file",
]

logger = logging.getLogger(__name__)


@dataclass
class HitObject:
    """A single hit object from a .osu beatmap.

    Attributes:
        time: Start time in milliseconds.
        end_time: End time in milliseconds (same as time for circles).
        lane: Mania lane index, clamped to [0, cs-1].
        type_bitmask: Bitmask: 1=circle, 2=slider, 8=long note (LN).
    """

    time: float
    end_time: float
    lane: int
    type_bitmask: int


@dataclass
class BeatmapMetadata:
    """Metadata extracted from a .osu beatmap.

    Attributes:
        title: Song title.
        artist: Song artist.
        beatmapset_id: Beatmapset identifier.
        difficulty_name: Difficulty name (e.g. "4K HD").
        bpm: Always 0.0 — no timing point parsing per D-08.
        cs: Column count (OverallDifficulty for mania, int).
        mode: Game mode (3 = mania).
    """

    title: str
    artist: str
    beatmapset_id: int
    difficulty_name: str
    bpm: float = 0.0
    cs: int = config.CS_DEFAULT
    mode: int = config.MANIA_MODE


def lane_from_x(x: int, cs: int) -> int:
    """Compute mania lane from x-coordinate and column count.

    Formula: floor(x / 512 * cs), clamped to [LANE_CLAMP_MIN, cs - 1].

    Args:
        x: X-coordinate from .osu hit object.
        cs: Column count (OverallDifficulty for mania).

    Returns:
        Lane index in [0, cs-1].
    """
    lane = int(x / 512 * cs)
    return max(config.LANE_CLAMP_MIN, min(lane, cs - 1))


def parse_hit_object_line(line: str, cs: int) -> Optional[HitObject]:
    """Parse a single [HitObjects] line into a HitObject.

    Format: x,y,time,type,hitSound,extParams,hitSample
    - ext field: endTime:params,... (after 5th comma, before colon)

    Args:
        line: A raw line from the [HitObjects] section.
        cs: Column count for lane calculation.

    Returns:
        HitObject if parsing succeeds, None if the line is malformed.
    """
    line = line.strip()
    if not line:
        return None

    try:
        parts = line.split(",")
        if len(parts) < 5:
            logger.warning("Skipping malformed hit object line (too few fields): %s", line)
            return None

        x = int(parts[0])
        time = float(parts[2])
        type_bitmask = int(parts[3])

        lane = lane_from_x(x, cs)

        # Determine end_time based on type
        if type_bitmask & 8 or type_bitmask & 2:
            # LN (type 8) or slider (type 2): end_time from ext field
            # ext is whatever remains after 5th comma, before first colon
            if len(parts) > 5:
                ext = parts[5]
                end_time_str = ext.split(":")[0]
                try:
                    end_time = float(end_time_str) if end_time_str else time
                except ValueError:
                    # Non-numeric ext field (e.g. slider curve data) — fall back
                    end_time = time
            else:
                end_time = time
        else:
            # Circle (type 1) or other: end_time = time
            end_time = time

        return HitObject(
            time=time,
            end_time=end_time,
            lane=lane,
            type_bitmask=type_bitmask,
        )
    except (ValueError, IndexError) as exc:
        logger.warning("Skipping malformed hit object line: %s — %s", line, exc)
        return None


def _parse_section_value(content: str, section: str, key: str) -> Optional[str]:
    """Extract a key=value from a specific [Section] in .osu content.

    Args:
        content: Full .osu file content.
        section: Section name (without brackets).
        key: Key to look up.

    Returns:
        Value string if found, None otherwise.
    """
    section_header = f"[{section}]"
    lines = content.splitlines()
    in_section = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            in_section = stripped == section_header
            continue
        if in_section and ":" in stripped:
            k, v = stripped.split(":", 1)
            if k.strip() == key:
                return v.strip()
    return None


def parse_osu(content: str) -> Optional[Tuple[BeatmapMetadata, List[HitObject]]]:
    """Parse a complete .osu file content.

    Extracts metadata and hit objects. Skips non-mania (Mode != 3) maps.
    Per D-08: no timing point parsing. bpm is always 0.0.

    Args:
        content: Raw .osu file text.

    Returns:
        Tuple of (BeatmapMetadata, List[HitObject]) for mania maps.
        None for non-mania maps.
    """
    # Check game mode — skip if not mania
    mode_str = _parse_section_value(content, "General", "Mode")
    if mode_str is not None:
        try:
            mode = int(mode_str)
        except ValueError:
            mode = -1
    else:
        mode = -1

    if mode != config.MANIA_MODE:
        return None

    # Parse metadata
    title = _parse_section_value(content, "Metadata", "Title") or ""
    artist = _parse_section_value(content, "Metadata", "Artist") or ""

    beatmapset_id_str = _parse_section_value(content, "Metadata", "BeatmapSetID")
    beatmapset_id = 0
    if beatmapset_id_str is not None:
        try:
            beatmapset_id = int(beatmapset_id_str)
        except ValueError:
            beatmapset_id = 0

    difficulty_name = _parse_section_value(content, "Metadata", "Version") or ""

    # Parse difficulty / column count
    cs_str = _parse_section_value(content, "Difficulty", "OverallDifficulty")
    cs = config.CS_DEFAULT
    if cs_str is not None:
        try:
            cs = int(float(cs_str))
        except ValueError:
            cs = config.CS_DEFAULT
    # Clamp cs to minimum 1
    cs = max(1, cs)

    metadata = BeatmapMetadata(
        title=title,
        artist=artist,
        beatmapset_id=beatmapset_id,
        difficulty_name=difficulty_name,
        bpm=0.0,  # D-08: no timing point parsing
        cs=cs,
        mode=config.MANIA_MODE,
    )

    # Parse hit objects
    hit_objects: List[HitObject] = []
    lines = content.splitlines()
    in_hit_objects = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            in_hit_objects = stripped == "[HitObjects]"
            continue
        if in_hit_objects and stripped:
            ho = parse_hit_object_line(stripped, cs)
            if ho is not None:
                hit_objects.append(ho)

    return (metadata, hit_objects)


def parse_osz(
    file_bytes: bytes,
) -> List[Tuple[BeatmapMetadata, List[HitObject], str]]:
    """Parse all mania .osu files from a .osz archive.

    Args:
        file_bytes: Raw bytes of the .osz file (zip archive).

    Returns:
        List of (BeatmapMetadata, List[HitObject], osu_filename) tuples.
        Empty list if no mania maps found or if the archive is invalid.
    """
    results: List[Tuple[BeatmapMetadata, List[HitObject], str]] = []

    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            for name in zf.namelist():
                if not name.endswith(".osu"):
                    continue
                try:
                    content = zf.read(name).decode("utf-8", errors="replace")
                except Exception as exc:
                    logger.warning("Failed to read %s from archive: %s", name, exc)
                    continue

                parsed = parse_osu(content)
                if parsed is None:
                    # Non-mania map, skip
                    continue

                metadata, hit_objects = parsed
                results.append((metadata, hit_objects, name))
    except (zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
        logger.warning("Invalid or corrupt .osz archive: %s", exc)
        return []
    except Exception as exc:
        logger.warning("Unexpected error parsing .osz: %s", exc)
        return []

    return results


def find_audio_file(osz_bytes: bytes, audio_filename: str) -> Optional[bytes]:
    """Find and extract an audio file from a .osz archive.

    Tries the exact audio filename first, then common variations
    (e.g. different extensions, leading path adjustments).

    Args:
        osz_bytes: Raw bytes of the .osz file.
        audio_filename: AudioFilename value from .osu [General] section.

    Returns:
        Raw audio file bytes, or None if not found.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(osz_bytes)) as zf:
            # Try exact name first
            if audio_filename in zf.namelist():
                return zf.read(audio_filename)

            # Try basename-only lookup (some archives strip paths)
            import os

            basename = os.path.basename(audio_filename)
            for name in zf.namelist():
                if os.path.basename(name) == basename:
                    return zf.read(name)

            # Try common extension variations
            root, _ = os.path.splitext(audio_filename)
            for ext in [".mp3", ".ogg", ".wav", ".m4a", ".flac"]:
                alt_name = root + ext
                if alt_name in zf.namelist():
                    return zf.read(alt_name)

            logger.warning("Audio file not found in archive: %s", audio_filename)
            return None
    except (zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
        logger.warning("Invalid .osz when searching for audio: %s", exc)
        return None
    except Exception as exc:
        logger.warning("Unexpected error finding audio file: %s", exc)
        return None
