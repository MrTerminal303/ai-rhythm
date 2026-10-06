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
    """review #10 P0/P1: selection by metadata across locations, atomic
    copies, partial files never discovered."""

    @staticmethod
    def _ckpt(path, step, epoch=0):
        import torch

        torch.save({"global_step": step, "epoch": epoch}, path)

    @staticmethod
    def _step(path):
        import torch

        return torch.load(path, map_location="cpu", weights_only=False)["global_step"]

    def test_higher_step_wins_across_locations(self, tmp_path):
        """P0: stale local (40k) must lose to newer Drive (60k) — not local-first."""
        from airhythm.checkpoint_store import CheckpointStore

        local, drive = tmp_path / "local", tmp_path / "drive"
        local.mkdir(); drive.mkdir()
        self._ckpt(local / "latest_40.pt", 40_000, epoch=4)
        self._ckpt(drive / "latest_60.pt", 60_000, epoch=6)
        store = CheckpointStore(local, drive_dir=drive)
        hits = store.glob("latest_*.pt")
        assert hits[-1].parent == local          # winner copy-in'd
        assert hits[-1].name == "latest_60.pt"
        assert self._step(hits[-1]) == 60_000
        assert len(hits) == 2                    # both candidates returned

    def test_local_wins_when_it_is_newest(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        local, att = tmp_path / "local", tmp_path / "att"
        local.mkdir(); att.mkdir()
        self._ckpt(local / "best_a.pt", 90, epoch=9)
        self._ckpt(att / "best_b.pt", 50, epoch=5)
        store = CheckpointStore(local, attached_dir=att)
        hits = store.glob("best_*.pt")
        assert hits[-1] == local / "best_a.pt"
        assert not (local / "best_b.pt").exists()  # loser not copied

    def test_same_name_higher_step_overwrites_local(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        local, drive = tmp_path / "local", tmp_path / "drive"
        local.mkdir(); drive.mkdir()
        self._ckpt(local / "latest_x.pt", 40)
        self._ckpt(drive / "latest_x.pt", 60)
        store = CheckpointStore(local, drive_dir=drive)
        hits = store.glob("latest_*.pt")
        assert self._step(hits[-1]) == 60        # stale local overwritten

    def test_corrupt_candidate_discarded(self, tmp_path):
        from airhythm.checkpoint_store import CheckpointStore

        local, drive = tmp_path / "local", tmp_path / "drive"
        local.mkdir(); drive.mkdir()
        (local / "best_z.pt").write_text("not a checkpoint")
        self._ckpt(drive / "best_a.pt", 7, epoch=1)
        store = CheckpointStore(local, drive_dir=drive)
        hits = store.glob("best_*.pt")
        assert [h.name for h in hits] == ["best_a.pt"]

    def test_partial_files_never_returned(self, tmp_path):
        """P1: .tmp/.partial discovered by a loose pattern still excluded."""
        from airhythm.checkpoint_store import CheckpointStore

        local = tmp_path / "local"; local.mkdir()
        self._ckpt(local / "latest_a.pt", 1)
        (local / "latest_b.pt.tmp").write_text("partial copy")
        (local / "latest_c.pt.partial").write_text("partial copy")
        store = CheckpointStore(local)
        hits = store.glob("latest_*")   # loose pattern would match the partials
        assert [h.name for h in hits] == ["latest_a.pt"]

    def test_tie_break_deterministic(self, tmp_path):
        """Same (step, epoch): name decides; full tie: local location decides."""
        from airhythm.checkpoint_store import CheckpointStore

        local, drive = tmp_path / "local", tmp_path / "drive"
        local.mkdir(); drive.mkdir()
        self._ckpt(local / "best_a.pt", 5, epoch=1)
        self._ckpt(drive / "best_b.pt", 5, epoch=1)
        store = CheckpointStore(local, drive_dir=drive)
        hits = store.glob("best_*.pt")
        assert hits[-1].name == "best_b.pt"      # name: b > a
        # full tie (same name/step/epoch) → local preferred, no pointless copy
        local2, drive2 = tmp_path / "l2", tmp_path / "d2"
        local2.mkdir(); drive2.mkdir()
        self._ckpt(local2 / "best_a.pt", 5, epoch=1)
        self._ckpt(drive2 / "best_a.pt", 5, epoch=1)
        store2 = CheckpointStore(local2, drive_dir=drive2)
        hits2 = store2.glob("best_*.pt")
        assert hits2[-1].parent == local2

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
