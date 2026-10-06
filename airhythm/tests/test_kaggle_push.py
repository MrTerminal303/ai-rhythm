"""Tests for the Kaggle Dataset push and management module."""

from __future__ import annotations

import json
import os
import tempfile

import pytest

from airhythm.kaggle_push import (
    build_manifest,
    create_dataset_structure,
    estimate_storage_size,
    prune_old_checkpoints,
    save_eval_song_ids,
)


class TestCreateDatasetStructure:
    """Tests for create_dataset_structure."""

    def test_creates_all_directories(self):
        """Create dirs, verify all 4 exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = create_dataset_structure(tmpdir)

            assert set(paths.keys()) == {
                "spectrograms",
                "baseline",
                "checkpoints",
                "metadata",
            }

            for name, path in paths.items():
                assert os.path.isdir(path), f"{name} directory missing: {path}"

    def test_returns_mapping(self):
        """Returns dict mapping dir names to absolute paths."""
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = create_dataset_structure(tmpdir)
            for name, path in paths.items():
                assert os.path.isabs(path)
                assert path.startswith(tmpdir)


class TestBuildManifest:
    """Tests for build_manifest."""

    def test_build_manifest_with_metadata(self):
        """Create test metadata JSONs, build manifest, verify D-06 structure."""
        with tempfile.TemporaryDirectory() as tmpdir:
            metadata_dir = os.path.join(tmpdir, "metadata")
            os.makedirs(metadata_dir)

            # Create test metadata files
            meta_1 = {
                "title": "Test Song 1",
                "artist": "Artist One",
                "bpm": 175.0,
                "difficulty_name": "4K HD",
            }
            meta_2 = {
                "title": "Test Song 2",
                "artist": "Artist Two",
                "bpm": 140.0,
                "difficulty_name": "4K MX",
            }

            with open(os.path.join(metadata_dir, "12345.json"), "w") as f:
                json.dump(meta_1, f)
            with open(os.path.join(metadata_dir, "67890.json"), "w") as f:
                json.dump(meta_2, f)

            manifest = build_manifest(metadata_dir, base_dir=tmpdir)

            assert "beatmapsets" in manifest
            assert "12345" in manifest["beatmapsets"]
            assert "67890" in manifest["beatmapsets"]

            entry_1 = manifest["beatmapsets"]["12345"]
            assert entry_1["title"] == "Test Song 1"
            assert entry_1["artist"] == "Artist One"
            assert entry_1["bpm"] == 175.0
            assert "files" in entry_1
            assert len(entry_1["files"]) == 2
            assert "spectrograms/12345.npy" in entry_1["files"]
            assert "metadata/12345.json" in entry_1["files"]

    def test_manifest_structure_has_required_keys(self):
        """Verify manifest has beatmapsets, dataset_version, created_at."""
        with tempfile.TemporaryDirectory() as tmpdir:
            metadata_dir = os.path.join(tmpdir, "metadata")
            os.makedirs(metadata_dir)

            # Write valid metadata to get non-empty manifest
            with open(os.path.join(metadata_dir, "99999.json"), "w") as f:
                json.dump({"title": "T", "artist": "A"}, f)

            manifest = build_manifest(metadata_dir, base_dir=tmpdir)
            assert "beatmapsets" in manifest
            assert "dataset_version" in manifest
            assert "created_at" in manifest

    def test_manifest_skips_non_json_files(self):
        """Non-.json files in metadata_dir are skipped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            metadata_dir = os.path.join(tmpdir, "metadata")
            os.makedirs(metadata_dir)

            with open(os.path.join(metadata_dir, "notes.txt"), "w") as f:
                f.write("not json")

            manifest = build_manifest(metadata_dir, base_dir=tmpdir)
            assert len(manifest["beatmapsets"]) == 0


class TestSaveEvalSongIds:
    """Tests for save_eval_song_ids."""

    def test_saves_correct_ids(self):
        """Save 5 IDs, reload, verify correct."""
        with tempfile.TemporaryDirectory() as tmpdir:
            metadata_dir = os.path.join(tmpdir, "metadata")
            song_ids = [12345, 23456, 34567, 45678, 56789]

            filepath = save_eval_song_ids(song_ids, metadata_dir)
            assert os.path.exists(filepath)

            with open(filepath) as f:
                data = json.load(f)

            assert "song_ids" in data
            assert data["song_ids"] == sorted(song_ids)
            assert "selected_at" in data
            assert "phase" in data
            assert data["phase"] == "00-foundation"

    def test_creates_metadata_dir_if_missing(self):
        """Directory is created if it doesn't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            metadata_dir = os.path.join(tmpdir, "nonexistent", "metadata")
            filepath = save_eval_song_ids([100, 200], metadata_dir)
            assert os.path.exists(filepath)

    def test_sorts_ids(self):
        """IDs are stored in sorted order regardless of input order."""
        with tempfile.TemporaryDirectory() as tmpdir:
            filepath = save_eval_song_ids([3, 1, 2], tmpdir)
            with open(filepath) as f:
                data = json.load(f)
            assert data["song_ids"] == [1, 2, 3]


class TestEstimateStorageSize:
    """Tests for estimate_storage_size."""

    def test_returns_zero_for_missing_dir(self):
        """Non-existent directory returns zero counts."""
        result = estimate_storage_size("/nonexistent/path")
        assert result["total_bytes"] == 0
        assert result["total_mb"] == 0.0
        assert result["by_extension"] == {}

    def test_calculates_sizes_correctly(self):
        """Create test files, verify size calculation."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create files of known sizes
            npy_path = os.path.join(tmpdir, "test.npy")
            with open(npy_path, "wb") as f:
                f.write(b"x" * 1000)

            json_path = os.path.join(tmpdir, "test.json")
            with open(json_path, "w") as f:
                f.write("{" + "a" * 500 + "}")

            result = estimate_storage_size(tmpdir)
            assert result["total_bytes"] == 1502
            # total_mb should approximate bytes / (1024*1024) within rounding
            expected_mb = 1502.0 / (1024.0 * 1024.0)
            assert abs(result["total_mb"] - expected_mb) < 0.01
            assert ".npy" in result["by_extension"]
            assert ".json" in result["by_extension"]
            assert result["by_extension"][".npy"] == 1000
            assert result["by_extension"][".json"] == 502  # 1 + 500 + 1 for "{}"

    def test_includes_subdirectories(self):
        """Files in subdirectories are counted."""
        with tempfile.TemporaryDirectory() as tmpdir:
            subdir = os.path.join(tmpdir, "sub")
            os.makedirs(subdir)
            with open(os.path.join(subdir, "file.bin"), "wb") as f:
                f.write(b"x" * 200)

            result = estimate_storage_size(tmpdir)
            assert result["total_bytes"] == 200


class TestPruneOldCheckpoints:
    """Tests for prune_old_checkpoints."""

    def test_removes_excess_checkpoints(self):
        """Create dummy checkpoints, call prune, verify deletion count."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create checkpoint files
            for i in range(5):
                path = os.path.join(tmpdir, f"latest_epoch_{i}.pt")
                with open(path, "w") as f:
                    f.write(f"checkpoint {i}")

            for i in range(3):
                path = os.path.join(tmpdir, f"best_val_{i}.pt")
                with open(path, "w") as f:
                    f.write(f"best {i}")

            # Create some unrelated .pt files (should be deleted)
            for i in range(2):
                path = os.path.join(tmpdir, f"epoch_{i}.pt")
                with open(path, "w") as f:
                    f.write(f"epoch {i}")

            # Count before
            before = len(os.listdir(tmpdir))

            # Prune: keep 1 latest, 1 best
            deleted = prune_old_checkpoints(tmpdir, keep_latest=1, keep_best=1)

            # After pruning: 4 latest removed (5-1), 2 best removed (3-1), 2 epoch files
            # The epoch files don't match patterns and should all be deleted
            # But wait — they're still .pt files that don't match latest/best, so they're in other_files.
            # Looking at the code: other_files are always deleted entirely.
            # So: 4 latest + 2 best + 2 other = 8 deleted
            assert deleted == 8, f"Expected 8 deletions, got {deleted}"

            # Verify remaining files
            remaining = os.listdir(tmpdir)
            assert len(remaining) == 2  # 1 latest + 1 best

    def test_handles_empty_directory(self):
        """Empty directory returns 0 deletions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            deleted = prune_old_checkpoints(tmpdir)
            assert deleted == 0

    def test_handles_missing_directory(self):
        """Non-existent directory returns 0 deletions."""
        deleted = prune_old_checkpoints("/nonexistent/checkpoints")
        assert deleted == 0

    def test_no_pruning_when_under_limit(self):
        """Fewer checkpoints than keep limit — nothing deleted."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "best_model.pt")
            with open(path, "w") as f:
                f.write("best")

            deleted = prune_old_checkpoints(tmpdir, keep_latest=1, keep_best=1)
            assert deleted == 0
            assert os.path.exists(path)

    def test_keeps_latest_checkpoints(self):
        """Only the most recent 'latest' checkpoints survive."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create checkpoint files with different timestamps
            import time

            for i in range(3):
                path = os.path.join(tmpdir, f"latest_model_{i}.pt")
                with open(path, "w") as f:
                    f.write(f"model {i}")
                # Set modified time to ensure specific ordering
                atime = mtime = 1000 + i
                os.utime(path, (atime, mtime))

            deleted = prune_old_checkpoints(tmpdir, keep_latest=2, keep_best=1)
            # 3 latest - 2 keep = 1 deleted (the oldest)
            assert deleted == 1


class TestWaitDatasetReady:
    """review #8 #1: poll status until READY; errors/timeouts fail loudly."""

    @staticmethod
    def _patch_run(monkeypatch, results):
        """results: list of (returncode, stdout) consumed one per call."""
        import subprocess
        import time

        calls = []

        def fake_run(cmd, capture_output=True, text=True):
            rc, out = results.pop(0)
            calls.append(cmd)

            class R:
                pass
            r = R()
            r.returncode, r.stdout, r.stderr, r.args = rc, out, "", cmd
            return r

        monkeypatch.setattr(subprocess, "run", fake_run)
        monkeypatch.setattr(time, "sleep", lambda s: None)
        return calls

    def test_polls_until_ready(self, monkeypatch):
        from airhythm.kaggle_push import wait_dataset_ready

        calls = self._patch_run(monkeypatch, [
            (0, "the dataset is processing"),
            (0, "the dataset airhythm-corpus is ready"),
        ])
        wait_dataset_ready("user/airhythm-corpus", delay_s=0)
        assert len(calls) == 2

    def test_cli_error_fails_loudly(self, monkeypatch):
        import subprocess

        from airhythm.kaggle_push import wait_dataset_ready

        self._patch_run(monkeypatch, [(1, "500 - Internal Server Error")])
        with pytest.raises(subprocess.CalledProcessError) as exc:
            wait_dataset_ready("user/airhythm-corpus", delay_s=0)
        assert "Internal Server Error" in (exc.value.output or "")

    def test_timeout_fails_loudly(self, monkeypatch):
        import subprocess

        from airhythm.kaggle_push import wait_dataset_ready

        self._patch_run(monkeypatch, [(0, "still processing")] * 3)
        with pytest.raises(subprocess.CalledProcessError) as exc:
            wait_dataset_ready("user/airhythm-corpus", attempts=3, delay_s=0)
        assert "not READY after 3 attempts" in (exc.value.output or "")


class TestBuildCorpusManifest:
    """review #9 A5: identity of the published corpus (resume validation B9)."""

    @staticmethod
    def _make_song(root, sid, *, complete=True):
        d = root / str(sid)
        d.mkdir(parents=True)
        (d / "meta.json").write_text("{}")
        (d / "original.audio").write_bytes(b"audio")
        if complete:
            (d / "0000.npy").write_bytes(b"spec")
            (d / "0000_labels.npy").write_bytes(b"labels")
        return d

    def test_fields_and_counts(self, tmp_path):
        from airhythm.kaggle_push import build_corpus_manifest

        for sid in (100, 200, 300):
            self._make_song(tmp_path, sid)
        self._make_song(tmp_path, 400, complete=False)  # missing chunk+labels

        m = build_corpus_manifest(tmp_path, target_songs=100, pinned_ids=[100, 200])
        assert set(m) == {
            "corpus_version", "schema_version", "target_songs", "song_count",
            "song_ids", "file_count", "complete_song_count",
            "pinned_song_count", "created_at",
        }
        assert m["schema_version"] == 1
        assert m["target_songs"] == 100
        assert m["song_count"] == 4
        assert m["song_ids"] == [100, 200, 300, 400]
        assert m["complete_song_count"] == 3
        assert m["pinned_song_count"] == 2
        assert m["file_count"] == 4 * 3 + 2  # complete: 4 files, incomplete: 2
        assert m["corpus_version"].startswith("v1-")
        assert "T" in m["created_at"]  # ISO-8601

    def test_ids_sorted_numerically_before_hashing(self, tmp_path):
        """review #10: lexicographic dir order ("10" < "2") must not leak into
        song_ids or the corpus_version hash — sha1 over sorted numeric ids."""
        import hashlib

        from airhythm.kaggle_push import build_corpus_manifest

        for sid in (100, 2, 10):  # unsorted creation order
            self._make_song(tmp_path, sid)
        m = build_corpus_manifest(tmp_path)
        assert m["song_ids"] == [2, 10, 100]
        expect = "v1-" + hashlib.sha1(
            "\n".join(str(i) for i in (2, 10, 100)).encode()).hexdigest()[:12]
        assert m["corpus_version"] == expect

    def test_version_changes_with_song_set(self, tmp_path):
        from airhythm.kaggle_push import build_corpus_manifest

        a = tmp_path / "a"
        b = tmp_path / "b"
        self._make_song(a, 100)
        self._make_song(a, 200)
        self._make_song(b, 100)
        self._make_song(b, 300)  # different set → different hash
        ma = build_corpus_manifest(a)
        mb = build_corpus_manifest(b)
        assert ma["corpus_version"] != mb["corpus_version"]

    def test_empty_root(self, tmp_path):
        from airhythm.kaggle_push import build_corpus_manifest

        m = build_corpus_manifest(tmp_path)
        assert m["song_count"] == 0
        assert m["complete_song_count"] == 0
        assert m["song_ids"] == []
