"""Kaggle environment detection and path resolution.

When the project is imported as a Kaggle Dataset, this module locates the
mounted dataset root and resolves paths relative to it.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from airhythm import config

__all__ = [
    "detect_kaggle_env",
    "resolve_kaggle_input_dir",
    "attach_corpus",
    "ensure_corpus",
    "read_corpus_manifest",
]


def detect_kaggle_env() -> bool:
    """Return True if running inside a Kaggle kernel."""
    return "KAGGLE_KERNEL_RUN_TYPE" in os.environ


def resolve_kaggle_input_dir() -> Path | None:
    """Find the airhythm dataset root under /kaggle/input/.

    Returns Path to the mounted dataset directory, or None if not on Kaggle.
    """
    if not detect_kaggle_env():
        return None
    input_root = Path("/kaggle/input")
    if not input_root.is_dir():
        return None
    for child in input_root.iterdir():
        if child.is_dir() and (child / "airhythm" / "__init__.py").exists():
            return child
    return None


def attach_corpus(flat_root, dest_root) -> Path:
    """Rebuild song dirs from a FLAT corpus upload (review #7 P0).

    Kaggle CLI's default --dir-mode skip uploads no folders, so Notebook A
    publishes files named song_<sid>__<file> at the dataset root. This
    reconstructs <dest>/<sid>/<file> as SYMLINKS to the mounted files —
    zero-copy, /kaggle/input stays read-only and is the only data copy.
    A nested minimal_dataset/ layout (local or AIRHYTHM_DATA-style trees)
    passes through unchanged.
    """
    flat_root = Path(flat_root)
    nested = flat_root / "minimal_dataset"
    if nested.is_dir():
        return nested
    dest_root = Path(dest_root)
    n = 0
    for f in sorted(flat_root.glob("song_*__*")):
        sid, sep, name = f.name[5:].partition("__")
        if not sep or not sid.isdigit():
            continue
        song_dir = dest_root / sid
        song_dir.mkdir(parents=True, exist_ok=True)
        link = song_dir / name
        if link.is_symlink() and not link.exists():
            link.unlink()  # stale target (e.g. prior session's mount path) — re-point
        if not link.exists():
            link.symlink_to(f.resolve())
        n += 1
    if not n:
        raise FileNotFoundError(
            f"no flat corpus files (song_<sid>__<file>) under {flat_root} "
            "and no minimal_dataset/ subdir — is the corpus dataset attached?"
        )
    return dest_root


def _verify_corpus_manifest(manifest, *, where, expect=None) -> dict:
    """review #10 P0-2: identity, not existence — structural validation plus
    optional expect={field: value} matches (e.g. corpus_version from a ckpt).

    Raises ValueError with the offending source; callers reject the source
    and download the correct corpus when possible.
    """
    required = ("corpus_version", "schema_version", "song_count", "song_ids",
                "file_count", "complete_song_count", "pinned_song_count")
    if not isinstance(manifest, dict):
        raise ValueError(
            f"corpus_manifest.json missing/invalid at {where} "
            "(review #10: identity check, not existence)")
    missing = [k for k in required if k not in manifest]
    if missing:
        raise ValueError(f"corpus manifest at {where} missing fields: {missing}")
    if manifest["schema_version"] != 1:
        raise ValueError(
            f"corpus manifest at {where}: schema_version "
            f"{manifest['schema_version']} != 1")
    if manifest["song_count"] != len(manifest["song_ids"]):
        raise ValueError(
            f"corpus manifest at {where}: song_count {manifest['song_count']} "
            f"!= len(song_ids) {len(manifest['song_ids'])}")
    if (manifest["complete_song_count"] > manifest["song_count"]
            or manifest["pinned_song_count"] > manifest["song_count"]):
        raise ValueError(f"corpus manifest at {where}: counts exceed song_count")
    if manifest["song_count"] > 0 and manifest["file_count"] <= 0:
        raise ValueError(
            f"corpus manifest at {where}: file_count {manifest['file_count']} "
            "with songs present")
    for k, v in (expect or {}).items():
        if manifest.get(k) != v:
            raise ValueError(
                f"corpus manifest at {where}: {k}={manifest.get(k)!r} "
                f"!= expected {v!r}")
    return manifest


def ensure_corpus(dest_root, *, input_root="/kaggle/input", download_handle=None,
                  expect=None) -> tuple[Path, Path | None]:
    """Obtain the corpus for B/C (review #9 B3, review #10 P0-2).

    Order: AIRHYTHM_DATA env (local override) > attached Kaggle Dataset >
    CLI download (Colab) > loud failure. Every source's corpus_manifest.json
    is VERIFIED (structure + optional expect field matches) before use — an
    invalid source is rejected; with download_handle the correct corpus is
    downloaded instead and any dest tree built from the rejected source is
    rebuilt. Returns (attached_dest, source_root); source_root is where
    corpus_manifest.json lives (A5). Never re-downloads a verified corpus_dl/.
    ponytail: a persisted corpus_dl/ can be structurally valid but stale —
    detect that via expect (ckpt corpus_version) or delete corpus_dl/ and
    re-run; a remote-version poll would need a Kaggle API round-trip.
    """
    env = os.environ.get("AIRHYTHM_DATA")
    if env:
        root = Path(env)
        _verify_corpus_manifest(read_corpus_manifest(root), where=root, expect=expect)
        return root, root
    attached = Path(input_root) / config.CORPUS_HANDLE
    if attached.is_dir():
        try:
            _verify_corpus_manifest(read_corpus_manifest(attached),
                                    where=attached, expect=expect)
        except ValueError:
            if not download_handle:
                raise
            print(f"attached corpus rejected: {attached} — downloading correct corpus")
            dl = _obtain_dl(dest_root, download_handle)
            _verify_corpus_manifest(read_corpus_manifest(dl), where=dl, expect=expect)
            # dest symlinks may point at the rejected source — rebuild
            shutil.rmtree(dest_root, ignore_errors=True)
            return attach_corpus(dl, dest_root), dl
        return attach_corpus(attached, dest_root), attached
    if download_handle:
        dl = _obtain_dl(dest_root, download_handle)
        _verify_corpus_manifest(read_corpus_manifest(dl), where=dl, expect=expect)
        return attach_corpus(dl, dest_root), dl
    raise FileNotFoundError(
        "corpus not found: no AIRHYTHM_DATA env, no "
        f"{attached} mount, no download_handle — attach the corpus dataset "
        f"({config.CORPUS_HANDLE}) or set AIRHYTHM_DATA"
    )


def _obtain_dl(dest_root, handle: str) -> Path:
    """Download dir for the CLI branch; skips the kaggle CLI when corpus_dl/
    already holds flat corpus files (review #9 B3)."""
    dl = Path(dest_root).parent / "corpus_dl"
    if not any(dl.glob("song_*__*")):
        _download_corpus_dataset(handle, dl)
    return dl


def _download_corpus_dataset(handle: str, dest) -> None:
    """kaggle CLI download for Colab (review #9 B3). Bare handle is expanded
    with the owner from KAGGLE_USERNAME or ~/.kaggle/kaggle.json."""
    if "/" not in handle:
        owner = os.environ.get("KAGGLE_USERNAME")
        if not owner:
            try:
                with open(Path.home() / ".kaggle" / "kaggle.json") as f:
                    owner = json.load(f).get("username")
            except (OSError, ValueError):
                owner = None
        if not owner:
            raise ValueError(
                f"cannot expand bare handle {handle!r}: set KAGGLE_USERNAME "
                "or provide ~/.kaggle/kaggle.json"
            )
        handle = f"{owner}/{handle}"
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    import subprocess

    r = subprocess.run(
        ["kaggle", "datasets", "download", "-d", handle, "-p", str(dest), "--unzip"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(
            f"kaggle datasets download {handle} failed (rc={r.returncode}): "
            + ((r.stdout or "") + (r.stderr or "")).strip()
        )


def read_corpus_manifest(source_root) -> dict | None:
    """corpus_manifest.json at the corpus source root (A5), or None if absent."""
    if source_root is None:
        return None
    p = Path(source_root) / "corpus_manifest.json"
    if not p.is_file():
        return None
    return json.loads(p.read_text())
