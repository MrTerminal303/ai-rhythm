"""Tests for runtime / checkpoint_store / run_meta (review #9 portability)."""

from __future__ import annotations

from pathlib import Path

import pytest


class TestRuntime:
    def test_local_runtime(self):
        from airhythm.runtime import Runtime

        rt = Runtime(is_kaggle=False, is_colab=False)
        assert rt.name == "local"
        assert rt.scratch == Path(".airhythm")
        assert rt.checkpoints == Path(".airhythm/checkpoints")
        assert rt.output == Path(".airhythm/outputs")
        assert rt.drive_root is None
        assert rt.drive_checkpoints is None

    def test_kaggle_scratch_env_override(self, monkeypatch):
        from airhythm.runtime import Runtime

        monkeypatch.setenv("KAGGLE_WORKING_DIR", "/tmp/kw")
        rt = Runtime(is_kaggle=True, is_colab=False)
        assert rt.name == "kaggle"
        assert rt.scratch == Path("/tmp/kw")
        monkeypatch.delenv("KAGGLE_WORKING_DIR")
        assert rt.scratch == Path("/kaggle/working")
        assert rt.drive_root is None

    def test_colab_scratch_and_drive(self):
        from airhythm.runtime import Runtime

        rt = Runtime(is_kaggle=False, is_colab=True)
        assert rt.name == "colab"
        assert rt.scratch == Path("/content/airhythm")
        assert rt.checkpoints == Path("/content/airhythm/checkpoints")
        assert rt.drive_root == Path("/content/drive/MyDrive/airhythm")
        assert rt.drive_checkpoints == Path("/content/drive/MyDrive/airhythm/checkpoints")


class TestCheckpointStore:
    def test_local_wins_no_copy(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        local, att = tmp_path / "local", tmp_path / "att"
        local.mkdir(); att.mkdir()
        (local / "best_a.pt").write_text("L")
        (att / "best_b.pt").write_text("A")
        store = CheckpointStore(local, attached_dir=att)
        hits = store.glob("best_*.pt")
        assert [h.name for h in hits] == ["best_a.pt"]
        assert not (local / "best_b.pt").exists()

    def test_attached_copy_in(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        local, att = tmp_path / "local", tmp_path / "att"
        local.mkdir(); att.mkdir()
        (att / "best_b.pt").write_text("A")
        store = CheckpointStore(local, attached_dir=att)
        hits = store.glob("best_*.pt")
        assert [h.name for h in hits] == ["best_b.pt"]
        assert (local / "best_b.pt").read_text() == "A"

    def test_drive_wins_over_attached(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        local = tmp_path / "local"; local.mkdir()
        drive = tmp_path / "drive"; drive.mkdir()
        att = tmp_path / "att"; att.mkdir()
        (drive / "latest_x.pt").write_text("D")
        (att / "latest_x.pt").write_text("A")
        store = CheckpointStore(local, attached_dir=att, drive_dir=drive)
        hits = store.glob("latest_*.pt")
        assert hits[0].read_text() == "D"

    def test_empty_returns_empty(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        local, att = tmp_path / "local", tmp_path / "att"
        local.mkdir(); att.mkdir()
        store = CheckpointStore(local, attached_dir=att)
        assert store.glob("best_*.pt") == []

    def test_sync_to_drive(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        local = tmp_path / "local"; local.mkdir()
        drive = tmp_path / "drive"
        (local / "latest_e1.pt").write_text("1")
        (local / "best_e2.pt").write_text("2")
        (local / "other.pt").write_text("x")
        store = CheckpointStore(local, drive_dir=drive)
        assert store.sync_to_drive() == 2
        assert (drive / "latest_e1.pt").exists()
        assert (drive / "best_e2.pt").exists()
        assert not (drive / "other.pt").exists()

    def test_sync_noop_without_drive(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        store = CheckpointStore(tmp_path)
        assert store.sync_to_drive() == 0


class TestRunMeta:
    def test_build_keys_and_values(self, monkeypatch):
        from airhythm.run_meta import CHECKPOINT_SCHEMA, build_run_meta

        monkeypatch.setenv("KAGGLE_USERNAME", "tester")
        meta = build_run_meta("local", {"corpus_version": "v1-abc", "song_count": 3})
        assert set(meta) == {
            "runtime", "code_commit", "corpus_dataset", "corpus_version",
            "checkpoint_schema", "torch", "torchaudio", "cuda", "python",
        }
        assert meta["runtime"] == "local"
        assert meta["corpus_dataset"] == "tester/airhythm-corpus"
        assert meta["corpus_version"] == "v1-abc"
        assert meta["checkpoint_schema"] == CHECKPOINT_SCHEMA
        # B6: no absolute paths in ckpt metadata
        assert "/home/" not in str(meta) and "/kaggle/" not in str(meta)

    def test_build_without_manifest(self, monkeypatch):
        from airhythm.run_meta import build_run_meta

        monkeypatch.delenv("KAGGLE_USERNAME", raising=False)
        meta = build_run_meta("kaggle", None)
        assert meta["corpus_version"] is None
        assert meta["corpus_dataset"] == "airhythm-corpus"

    def test_verify_match_ok(self):
        from airhythm.run_meta import verify_resume_compat

        verify_resume_compat(
            {"corpus_version": "v1-a", "checkpoint_schema": 1, "code_commit": "abc1234"},
            {"corpus_version": "v1-a"},
        )

    def test_verify_corpus_mismatch_raises(self):
        from airhythm.run_meta import verify_resume_compat

        with pytest.raises(AssertionError, match="corpus mismatch"):
            verify_resume_compat(
                {"corpus_version": "v1-a", "checkpoint_schema": 1},
                {"corpus_version": "v1-b"},
            )

    def test_verify_bad_schema_raises(self):
        from airhythm.run_meta import verify_resume_compat

        with pytest.raises(AssertionError, match="checkpoint_schema"):
            verify_resume_compat(
                {"corpus_version": "v1-a", "checkpoint_schema": 99},
                {"corpus_version": "v1-a"},
            )

    def test_verify_missing_meta_skips(self, capsys):
        from airhythm.run_meta import verify_resume_compat

        verify_resume_compat(None, {"corpus_version": "v1-a"})
        assert "SKIPPED" in capsys.readouterr().out

    def test_verify_missing_manifest_skips(self, capsys):
        from airhythm.run_meta import verify_resume_compat

        verify_resume_compat({"corpus_version": "v1-a"}, None)
        assert "SKIPPED" in capsys.readouterr().out

    def test_verify_commit_drift_prints_no_raise(self, capsys):
        from airhythm.run_meta import verify_resume_compat

        verify_resume_compat(
            {"corpus_version": "v1-a", "checkpoint_schema": 1, "code_commit": "aaaaaaa"},
            {"corpus_version": "v1-a"},
            current_commit="bbbbbbb",
        )
        assert "code drift" in capsys.readouterr().out
