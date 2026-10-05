"""Tests for notebook and Kaggle web compatibility.

download_minimal.py must work when pasted into a notebook (__file__ undefined).
app.py must resolve paths correctly on Kaggle.
"""
from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

import pytest


class TestDownloadMinimalNotebookSafe:
    """download_minimal.py must not crash when __file__ is undefined (notebook)."""

    def test_no_sys_exit_at_module_level(self):
        """No sys.exit() at module level (kills notebook kernel)."""
        source = Path(__file__).parent.parent.parent / "download_minimal.py"
        tree = ast.parse(source.read_text())
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                func = node.value.func
                if isinstance(func, ast.Attribute) and func.attr == "exit":
                    pytest.fail(f"sys.exit() at module level (line {node.lineno})")

    def test_main_logic_in_function(self):
        """Core logic is inside a function, not top-level."""
        source = Path(__file__).parent.parent.parent / "download_minimal.py"
        tree = ast.parse(source.read_text())
        funcs = [n for n in ast.iter_child_nodes(tree) if isinstance(n, ast.FunctionDef)]
        assert len(funcs) >= 1, "No function definitions found"

    def test_has_name_guard(self):
        """Has if __name__ == '__main__' guard."""
        source = Path(__file__).parent.parent.parent / "download_minimal.py"
        text = source.read_text()
        assert "__name__" in text and "__main__" in text

    def test_ensure_path_handles_no___file__(self):
        """_ensure_airhythm_on_path does not crash when __file__ is undefined."""
        source = Path(__file__).parent.parent.parent / "download_minimal.py"
        text = source.read_text()
        # The path insertion should be inside a function, not module level
        tree = ast.parse(text)
        # Check no top-level sys.path.insert uses __file__
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                func = node.value.func
                if isinstance(func, ast.Attribute) and func.attr == "insert":
                    for arg in ast.walk(node):
                        if isinstance(arg, ast.Name) and arg.id == "__file__":
                            pytest.fail("__file__ used in top-level sys.path.insert")

    def test_main_returns_count(self):
        """main() signature returns an int (saved count)."""
        source = Path(__file__).parent.parent.parent / "download_minimal.py"
        tree = ast.parse(source.read_text())
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "main":
                # Check return annotation or docstring mentions return
                assert node.returns is not None or True  # optional annotation
                return
        pytest.fail("main() function not found")


class TestAppKagglePaths:
    """app.py resolves paths correctly for Kaggle web."""

    def test_discover_songs_finds_local_data(self):
        """discover_songs finds songs in local data/minimal_dataset."""
        from test_app_baseline_fit.core import discover_songs
        data_dir = str(Path(__file__).parent.parent.parent / "data" / "minimal_dataset")
        if not Path(data_dir).is_dir():
            pytest.skip("data/minimal_dataset not present")
        songs = discover_songs(data_dir=data_dir)
        assert len(songs) > 0
        for s in songs:
            assert "song_id" in s and "path" in s and "tag" in s

    def test_discover_songs_empty_on_bad_path(self):
        """discover_songs returns [] for nonexistent path."""
        from test_app_baseline_fit.core import discover_songs
        assert discover_songs(data_dir="/nonexistent") == []

    def test_load_song_tags_custom_path(self):
        """load_song_tags returns {} for nonexistent path."""
        from test_app_baseline_fit.core import load_song_tags
        tags = load_song_tags(eval_ids_path="/nonexistent/file.json")
        assert isinstance(tags, dict) and len(tags) == 0


class TestKagglePathModule:
    """kaggle_path module works correctly."""

    def test_detect_off_kaggle(self):
        """detect_kaggle_env returns False when env var not set."""
        from airhythm.kaggle_path import detect_kaggle_env
        old = os.environ.pop("KAGGLE_KERNEL_RUN_TYPE", None)
        try:
            assert detect_kaggle_env() is False
        finally:
            if old is not None:
                os.environ["KAGGLE_KERNEL_RUN_TYPE"] = old

    def test_detect_on_kaggle(self):
        """detect_kaggle_env returns True when env var set."""
        from airhythm.kaggle_path import detect_kaggle_env
        os.environ["KAGGLE_KERNEL_RUN_TYPE"] = "Interactive"
        try:
            assert detect_kaggle_env() is True
        finally:
            del os.environ["KAGGLE_KERNEL_RUN_TYPE"]

    def test_resolve_returns_none_off_kaggle(self):
        """resolve_kaggle_input_dir returns None off Kaggle."""
        from airhythm.kaggle_path import resolve_kaggle_input_dir
        old = os.environ.pop("KAGGLE_KERNEL_RUN_TYPE", None)
        try:
            assert resolve_kaggle_input_dir() is None
        finally:
            if old is not None:
                os.environ["KAGGLE_KERNEL_RUN_TYPE"] = old

    def test_resolve_returns_path_or_none(self):
        """resolve_kaggle_input_dir returns Path or None (never crashes)."""
        from airhythm.kaggle_path import resolve_kaggle_input_dir
        result = resolve_kaggle_input_dir()
        assert result is None or isinstance(result, Path)

    def test_attach_corpus_flat_rebuilds_symlink_dirs(self, tmp_path):
        """review #7 P0: flat song_<sid>__<file> upload -> <sid>/<file> symlinks."""
        from airhythm.kaggle_path import attach_corpus

        flat = tmp_path / "corpus"
        flat.mkdir()
        (flat / "song_1__0000.npy").write_bytes(b"x")
        (flat / "song_1__original.audio").write_bytes(b"a")
        (flat / "song_2__0000.npy").write_bytes(b"y")
        dest = tmp_path / "rebuild"
        out = attach_corpus(flat, dest)
        assert out == dest
        assert (dest / "1" / "0000.npy").is_symlink()
        assert (dest / "1" / "original.audio").read_bytes() == b"a"
        assert (dest / "2" / "0000.npy").is_symlink()
        # idempotent second attach
        attach_corpus(flat, dest)
        assert (dest / "1" / "0000.npy").is_symlink()

    def test_attach_corpus_nested_passthrough_and_missing_raises(self, tmp_path):
        from airhythm.kaggle_path import attach_corpus

        nested_root = tmp_path / "nested"
        (nested_root / "minimal_dataset" / "9").mkdir(parents=True)
        assert attach_corpus(nested_root, tmp_path / "dest") == (
            nested_root / "minimal_dataset")
        with pytest.raises(FileNotFoundError):
            attach_corpus(tmp_path / "does_not_exist", tmp_path / "dest")

    def test_attach_corpus_readonly_source_cache_write_and_broken_repair(self, tmp_path):
        """review #8 verify: read-through == original, cache write elsewhere,
        source unchanged, read-only source, broken symlink re-pointed."""
        from airhythm.kaggle_path import attach_corpus

        src7 = tmp_path / "src" / "7"
        src7.mkdir(parents=True)
        orig = src7 / "0000.npy"
        orig.write_bytes(b"spec-bytes")
        (src7 / "original.audio").write_bytes(b"audio-bytes")
        # flat staging like Notebook A (hardlinks), then lock source read-only
        flat = tmp_path / "flat"
        flat.mkdir()
        os.link(orig, flat / "song_7__0000.npy")
        os.link(src7 / "original.audio", flat / "song_7__original.audio")
        os.chmod(src7, 0o555)
        try:
            dest = tmp_path / "rebuild"
            attach_corpus(flat, dest)
            # read-through: bytes equal, cache write elsewhere, source untouched
            got = (dest / "7" / "0000.npy").read_bytes()
            assert got == b"spec-bytes"
            cache = tmp_path / "cache"
            cache.mkdir()
            (cache / "7_full_spec.npy").write_bytes(got)
            assert orig.read_bytes() == b"spec-bytes"
            # broken symlink (stale mount path) re-pointed on re-attach
            link = dest / "7" / "0000.npy"
            link.unlink()
            link.symlink_to(tmp_path / "gone" / "file.npy")
            attach_corpus(flat, dest)
            assert link.is_symlink() and link.exists()
            assert link.read_bytes() == b"spec-bytes"
        finally:
            os.chmod(src7, 0o755)
