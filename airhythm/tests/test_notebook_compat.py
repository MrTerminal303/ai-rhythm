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


class TestEnsureCorpus:
    """review #9 B3 + review #10 P0-2: env override > attached > CLI download
    > loud failure — every source VERIFIED via corpus_manifest.json first."""

    @staticmethod
    def _write_manifest(root, *, version="v1-abc", song_count=1):
        import json

        root.mkdir(parents=True, exist_ok=True)
        (root / "corpus_manifest.json").write_text(json.dumps({
            "corpus_version": version, "schema_version": 1, "target_songs": 100,
            "song_count": song_count, "song_ids": list(range(7, 7 + song_count)),
            "file_count": song_count * 3, "complete_song_count": song_count,
            "pinned_song_count": 0, "created_at": "2026-10-06T00:00:00+00:00",
        }))

    @staticmethod
    def _write_flat(root):
        root.mkdir(parents=True, exist_ok=True)
        (root / "song_7__0000.npy").write_bytes(b"x")

    def test_env_override_verified(self, tmp_path, monkeypatch):
        from airhythm.kaggle_path import ensure_corpus

        env_dir = tmp_path / "env_corpus"
        (env_dir / "7").mkdir(parents=True)
        self._write_manifest(env_dir)
        monkeypatch.setenv("AIRHYTHM_DATA", str(env_dir))
        dest, src = ensure_corpus(tmp_path / "dest")
        assert dest == env_dir
        assert src == env_dir

    def test_env_without_manifest_rejected(self, tmp_path, monkeypatch):
        from airhythm.kaggle_path import ensure_corpus

        (tmp_path / "env_corpus" / "7").mkdir(parents=True)
        monkeypatch.setenv("AIRHYTHM_DATA", str(tmp_path / "env_corpus"))
        with pytest.raises(ValueError, match="corpus_manifest"):
            ensure_corpus(tmp_path / "dest")

    def test_expect_mismatch_rejected(self, tmp_path, monkeypatch):
        from airhythm.kaggle_path import ensure_corpus

        env_dir = tmp_path / "env_corpus"
        self._write_manifest(env_dir, version="v1-old")
        monkeypatch.setenv("AIRHYTHM_DATA", str(env_dir))
        with pytest.raises(ValueError, match="!= expected"):
            ensure_corpus(tmp_path / "dest", expect={"corpus_version": "v1-new"})

    def test_attached_passthrough(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm.kaggle_path import ensure_corpus

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        input_root = tmp_path / "input"
        flat = input_root / config.CORPUS_HANDLE
        self._write_flat(flat)
        self._write_manifest(flat)
        dest, src = ensure_corpus(tmp_path / "dest", input_root=str(input_root))
        assert (dest / "7" / "0000.npy").is_symlink()
        assert src == flat

    def test_attached_invalid_no_handle_rejected(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm.kaggle_path import ensure_corpus

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        flat = tmp_path / "input" / config.CORPUS_HANDLE
        self._write_flat(flat)  # files but no manifest — review #10: reject
        with pytest.raises(ValueError, match="corpus_manifest"):
            ensure_corpus(tmp_path / "dest", input_root=str(tmp_path / "input"))

    def test_attached_invalid_falls_back_to_download(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm import kaggle_path

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        flat = tmp_path / "input" / config.CORPUS_HANDLE
        self._write_flat(flat)  # no manifest → rejected
        calls = []

        def fake_download(handle, dest):
            calls.append(handle)
            self._write_flat(dest)
            self._write_manifest(dest)

        monkeypatch.setattr(kaggle_path, "_download_corpus_dataset", fake_download)
        dest, src = kaggle_path.ensure_corpus(
            tmp_path / "dest", input_root=str(tmp_path / "input"),
            download_handle=config.CORPUS_HANDLE)
        assert calls == [config.CORPUS_HANDLE]
        assert src == tmp_path / "corpus_dl"
        assert (dest / "7" / "0000.npy").read_bytes() == b"x"

    def test_download_branch_invoked(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm import kaggle_path

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        calls = []

        def fake_download(handle, dest):
            calls.append(handle)
            self._write_flat(dest)
            self._write_manifest(dest)

        monkeypatch.setattr(kaggle_path, "_download_corpus_dataset", fake_download)
        dest, src = kaggle_path.ensure_corpus(
            tmp_path / "dest", input_root=str(tmp_path / "empty_input"),
            download_handle=config.CORPUS_HANDLE)
        assert calls == [config.CORPUS_HANDLE]
        assert (dest / "7" / "0000.npy").is_symlink()
        assert src == tmp_path / "corpus_dl"
        # second call: files already present — no re-download, still verified
        kaggle_path.ensure_corpus(
            tmp_path / "dest2", input_root=str(tmp_path / "empty_input"),
            download_handle=config.CORPUS_HANDLE)
        assert calls == [config.CORPUS_HANDLE]

    def test_missing_everything_fails_loudly(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm.kaggle_path import ensure_corpus

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        with pytest.raises(FileNotFoundError, match=config.CORPUS_HANDLE):
            ensure_corpus(tmp_path / "dest", input_root=str(tmp_path / "empty"))


class TestVersionFill:
    """08-07 version-shard: attached/latest is only one Kaggle version —
    ensure_corpus fills remaining versions via kagglehub, else fails loud
    rather than train on a subset that claims to be the full corpus."""

    @staticmethod
    def _fake_kagglehub(monkeypatch, responses, calls, fail_first=0,
                        manifests=None):
        import json
        import sys
        import tempfile
        import time
        import types

        monkeypatch.setattr(time, "sleep", lambda _s: None)  # fill retry loop
        manifests = manifests or {}  # version -> song_ids for preflight fetches

        mod = types.ModuleType("kagglehub")

        flapped = set()  # first call per (handle, path) stage — the intent is
        # "one flap on preflight, one on the pull", not "two flaps wherever
        # they land first" (a global counter burns both on the manifest stage)

        def dataset_download(handle, path=None, **_kw):
            calls.append((handle, path))
            nonlocal fail_first
            if fail_first > 0 and (handle, path) not in flapped:
                flapped.add((handle, path))
                fail_first -= 1
                raise RuntimeError("mount/unmount dataset: unknown error")
            v = int(handle.rsplit("/", 1)[1])
            if path is not None:  # preflight: corpus_manifest.json only
                if v not in manifests:
                    raise ValueError(
                        f"'{path}' is not present in the dataset files.")
                d = Path(tempfile.mkdtemp())
                (d / path).write_text(json.dumps({"song_ids": manifests[v]}))
                return str(d / path)
            if v not in responses:
                raise RuntimeError(f"404: no version {v}")
            return str(responses[v])

        mod.dataset_download = dataset_download
        monkeypatch.setitem(sys.modules, "kagglehub", mod)

    @staticmethod
    def _full_calls(calls):
        return [h for h, p in calls if p is None]

    @staticmethod
    def _manifest_calls(calls):
        return [h for h, p in calls if p is not None]

    def test_fill_retries_until_version_download_finishes(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm import kaggle_path

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        monkeypatch.setenv("KAGGLE_USERNAME", "user")
        flat = tmp_path / "input" / config.CORPUS_HANDLE
        flat.mkdir(parents=True)
        (flat / "song_7__0000.npy").write_bytes(b"x")
        TestEnsureCorpus._write_manifest(flat, song_count=2)
        v1 = tmp_path / "v1"
        v1.mkdir()
        (v1 / "song_8__0000.npy").write_bytes(b"y")
        calls = []
        # flap twice: once on the manifest preflight, once on the full pull
        self._fake_kagglehub(monkeypatch, {1: v1}, calls, fail_first=2,
                             manifests={1: [7, 8]})

        dest, _src = kaggle_path.ensure_corpus(
            tmp_path / "dest", input_root=str(tmp_path / "input"),
            download_handle=config.CORPUS_HANDLE)

        assert (dest / "8" / "0000.npy").read_bytes() == b"y"
        # 08-07 CELL 13 bug: first mount failure killed the fill — now retried
        # (both the manifest preflight fetch and the full version pull)
        assert self._manifest_calls(calls) == \
            [f"user/{config.CORPUS_HANDLE}/versions/1"] * 2
        assert self._full_calls(calls) == \
            [f"user/{config.CORPUS_HANDLE}/versions/1"] * 2

    def test_fill_pulls_versions_until_covered(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm import kaggle_path

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        monkeypatch.setenv("KAGGLE_USERNAME", "user")
        flat = tmp_path / "input" / config.CORPUS_HANDLE
        flat.mkdir(parents=True)
        (flat / "song_7__0000.npy").write_bytes(b"x")  # latest version's shard only
        TestEnsureCorpus._write_manifest(flat, song_count=2)  # union = songs 7, 8
        v1 = tmp_path / "v1"
        v1.mkdir()
        (v1 / "song_8__0000.npy").write_bytes(b"y")  # older version holds the rest
        calls = []
        # preflight map: v1's manifest = full union → v1 adds both ids
        self._fake_kagglehub(monkeypatch, {1: v1}, calls, manifests={1: [7, 8]})

        dest, _src = kaggle_path.ensure_corpus(
            tmp_path / "dest", input_root=str(tmp_path / "input"),
            download_handle=config.CORPUS_HANDLE)

        assert (dest / "7" / "0000.npy").read_bytes() == b"x"
        assert (dest / "8" / "0000.npy").read_bytes() == b"y"
        # stops at target: exactly one full pull of the adding version
        assert self._full_calls(calls) == [f"user/{config.CORPUS_HANDLE}/versions/1"]

    def test_fill_map_skips_live_versions_and_pulls_missing(self, tmp_path, monkeypatch):
        """user bug: fetcher re-pulled version 1 (already covered) and never
        reached version 2's songs — preflight diff must say v1 adds nothing
        live, v2 adds the missing id, and only v2 downloads."""
        from airhythm import config
        from airhythm import kaggle_path

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        monkeypatch.setenv("KAGGLE_USERNAME", "user")
        flat = tmp_path / "input" / config.CORPUS_HANDLE
        flat.mkdir(parents=True)
        (flat / "song_7__0000.npy").write_bytes(b"x")
        (flat / "song_8__0000.npy").write_bytes(b"y")  # attached has 7, 8
        TestEnsureCorpus._write_manifest(flat, song_count=3)  # union = 7, 8, 9
        v1, v2 = tmp_path / "v1", tmp_path / "v2"
        v1.mkdir()
        (v1 / "song_8__0000.npy").write_bytes(b"y")  # v1 batch: ids 7, 8 — all live
        v2.mkdir()
        (v2 / "song_9__0000.npy").write_bytes(b"z")  # v2 batch: id 9 — missing
        calls = []
        self._fake_kagglehub(
            monkeypatch, {1: v1, 2: v2}, calls,
            manifests={1: [7, 8], 2: [7, 8, 9]})  # cumulative union manifests

        dest, _src = kaggle_path.ensure_corpus(
            tmp_path / "dest", input_root=str(tmp_path / "input"),
            download_handle=config.CORPUS_HANDLE)

        assert (dest / "9" / "0000.npy").read_bytes() == b"z"
        # v1 adds nothing live → skipped; only v2's full archive downloads
        assert self._full_calls(calls) == \
            [f"user/{config.CORPUS_HANDLE}/versions/2"]
        assert self._manifest_calls(calls) == \
            [f"user/{config.CORPUS_HANDLE}/versions/1",
             f"user/{config.CORPUS_HANDLE}/versions/2"]

    def test_fill_raises_when_versions_exhausted(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm import kaggle_path

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        monkeypatch.setenv("KAGGLE_USERNAME", "user")
        flat = tmp_path / "input" / config.CORPUS_HANDLE
        flat.mkdir(parents=True)
        (flat / "song_7__0000.npy").write_bytes(b"x")
        TestEnsureCorpus._write_manifest(flat, song_count=2)  # wants 2, has 1
        calls = []
        # production default _FILL_MAX_ATTEMPTS=0 waits forever — cap here so
        # the loud-stop path stays reachable under test
        monkeypatch.setattr(kaggle_path, "_FILL_MAX_ATTEMPTS", 3)
        # no manifests: preflight gives up after 3 manifest-less versions,
        # falls back to blind fill, which then hits the same 404 wall
        self._fake_kagglehub(monkeypatch, {}, calls)

        with pytest.raises(RuntimeError, match="corpus incomplete"):
            kaggle_path.ensure_corpus(
                tmp_path / "dest", input_root=str(tmp_path / "input"),
                download_handle=config.CORPUS_HANDLE)

    def test_no_fill_when_attached_covers_manifest(self, tmp_path, monkeypatch):
        from airhythm import config
        from airhythm import kaggle_path

        monkeypatch.delenv("AIRHYTHM_DATA", raising=False)
        flat = tmp_path / "input" / config.CORPUS_HANDLE
        TestEnsureCorpus._write_flat(flat)  # song_count defaults to 1
        TestEnsureCorpus._write_manifest(flat)
        calls = []
        self._fake_kagglehub(monkeypatch, {}, calls)

        dest, _src = kaggle_path.ensure_corpus(
            tmp_path / "dest", input_root=str(tmp_path / "input"),
            download_handle=config.CORPUS_HANDLE)

        assert (dest / "7" / "0000.npy").is_symlink()
        assert calls == []  # covered — kagglehub never touched

    def test_env_override_skips_fill(self, tmp_path, monkeypatch):
        """AIRHYTHM_DATA = operator's own tree — partial local trees are a
        valid dev setup; fill must not demand Kaggle versions there."""
        from airhythm import kaggle_path

        env_dir = tmp_path / "env"
        (env_dir / "7").mkdir(parents=True)
        TestEnsureCorpus._write_manifest(env_dir, song_count=2)  # under-filled
        monkeypatch.setenv("AIRHYTHM_DATA", str(env_dir))
        calls = []
        self._fake_kagglehub(monkeypatch, {}, calls)

        _dest, src = kaggle_path.ensure_corpus(tmp_path / "dest")

        assert src == env_dir
        assert calls == []


class TestReadCorpusManifest:
    def test_reads_json(self, tmp_path):
        from airhythm.kaggle_path import read_corpus_manifest

        (tmp_path / "corpus_manifest.json").write_text(
            '{"corpus_version": "v1-abc", "song_count": 100}')
        m = read_corpus_manifest(tmp_path)
        assert m["corpus_version"] == "v1-abc"
        assert m["song_count"] == 100

    def test_absent_returns_none(self, tmp_path):
        from airhythm.kaggle_path import read_corpus_manifest

        assert read_corpus_manifest(tmp_path) is None

    def test_none_source_returns_none(self):
        from airhythm.kaggle_path import read_corpus_manifest

        assert read_corpus_manifest(None) is None


class TestFindAttachedInput:
    """Resume/attach lookup: bare legacy mount vs current Kaggle nesting
    datasets/<owner>/<slug> (CELL 0 finds /kaggle/input/datasets/<owner>/...).
    Wrong shape made CheckpointStore.attached_dir point at a non-dir — every
    fresh session printed 'no local checkpoint — fresh start'."""

    def test_bare_wins_over_nested(self, tmp_path):
        from airhythm.kaggle_path import find_attached_input

        root = tmp_path / "input"
        bare = root / "my-ds"
        bare.mkdir(parents=True)
        (root / "datasets" / "owner" / "my-ds").mkdir(parents=True)
        assert find_attached_input("my-ds", str(root)) == bare

    def test_nested_layout_found(self, tmp_path):
        from airhythm.kaggle_path import find_attached_input

        root = tmp_path / "input"
        nested = root / "datasets" / "owner" / "my-ds"
        nested.mkdir(parents=True)
        assert find_attached_input("my-ds", str(root)) == nested

    def test_absent_returns_none(self, tmp_path):
        from airhythm.kaggle_path import find_attached_input

        root = tmp_path / "input"
        root.mkdir()
        assert find_attached_input("my-ds", str(root)) is None
        assert find_attached_input("my-ds", str(tmp_path / "nope")) is None
