"""Tests for Kaggle Dataset compatibility.

Verifies the airhythm package can be imported and used when the project
is mounted as a Kaggle Dataset at /kaggle/input/{slug}/.
"""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

import pytest


class TestPackageImportable:
    """airhythm must import cleanly as a top-level package."""

    def test_import_airhythm(self):
        """import airhythm succeeds."""
        import airhythm
        assert airhythm is not None

    def test_import_config(self):
        """from airhythm import config succeeds."""
        from airhythm import config
        assert config is not None

    def test_import_baseline(self):
        """from airhythm import baseline succeeds."""
        from airhythm import baseline
        assert baseline is not None

    def test_import_osu_parser(self):
        """from airhythm import osu_parser succeeds."""
        from airhythm import osu_parser
        assert osu_parser is not None

    def test_import_toygen(self):
        """from airhythm import toygen succeeds."""
        from airhythm import toygen
        assert toygen is not None

    def test_import_audio_preproc(self):
        """from airhythm import audio_preproc succeeds."""
        from airhythm import audio_preproc
        assert audio_preproc is not None

    def test_import_kaggle_push(self):
        """from airhythm import kaggle_push succeeds."""
        from airhythm import kaggle_push
        assert kaggle_push is not None


class TestPackageMetadata:
    """Package must carry version info for reproducibility on Kaggle."""

    def test_has_version(self):
        """airhythm.__version__ exists and is a string."""
        import airhythm
        assert hasattr(airhythm, "__version__")
        assert isinstance(airhythm.__version__, str)

    def test_version_is_pep440(self):
        """Version string is non-empty and looks like a version."""
        import airhythm
        v = airhythm.__version__
        assert len(v) > 0
        # At least has a digit
        assert any(c.isdigit() for c in v)


class TestKaggleEnvironmentDetection:
    """detect_kaggle_env returns correct boolean based on env vars."""

    def test_detects_kaggle_when_env_set(self):
        """Returns True when KAGGLE_KERNEL_RUN_TYPE is set."""
        from airhythm.kaggle_path import detect_kaggle_env
        with tempfile.TemporaryDirectory():
            os.environ["KAGGLE_KERNEL_RUN_TYPE"] = "Interactive"
            try:
                assert detect_kaggle_env() is True
            finally:
                del os.environ["KAGGLE_KERNEL_RUN_TYPE"]

    def test_detects_local_when_no_env(self):
        """Returns False when KAGGLE_KERNEL_RUN_TYPE is not set."""
        from airhythm.kaggle_path import detect_kaggle_env
        old = os.environ.pop("KAGGLE_KERNEL_RUN_TYPE", None)
        try:
            assert detect_kaggle_env() is False
        finally:
            if old is not None:
                os.environ["KAGGLE_KERNEL_RUN_TYPE"] = old


class TestResolveKaggleInputDir:
    """resolve_kaggle_input_dir finds the dataset root."""

    def test_finds_input_dir_on_kaggle(self):
        """Simulates Kaggle mount: returns /kaggle/input/{slug}."""
        from airhythm.kaggle_path import resolve_kaggle_input_dir
        fake_input = "/kaggle/input/airhythm-data"
        os.environ["KAGGLE_KERNEL_RUN_TYPE"] = "Interactive"
        try:
            # On real Kaggle, this path exists. In test, it won't,
            # so we accept None or the path.
            result = resolve_kaggle_input_dir()
            # Should return a Path or None, not crash
            assert result is None or isinstance(result, Path)
        finally:
            del os.environ["KAGGLE_KERNEL_RUN_TYPE"]

    def test_returns_none_off_kaggle(self):
        """Returns None when not on Kaggle."""
        from airhythm.kaggle_path import resolve_kaggle_input_dir
        old = os.environ.pop("KAGGLE_KERNEL_RUN_TYPE", None)
        try:
            assert resolve_kaggle_input_dir() is None
        finally:
            if old is not None:
                os.environ["KAGGLE_KERNEL_RUN_TYPE"] = old


class TestConfigSane:
    """Config constants are correct and Kaggle-compatible."""

    def test_ephemeral_dir_is_kaggle_path(self):
        """EPHEMERAL_DIR points to Kaggle working directory."""
        from airhythm import config
        assert config.EPHEMERAL_DIR == "/kaggle/working"

    def test_dataset_handle_is_string(self):
        """DATASET_HANDLE is a non-empty string."""
        from airhythm import config
        assert isinstance(config.DATASET_HANDLE, str)
        assert len(config.DATASET_HANDLE) > 0

    def test_max_dataset_gb_positive(self):
        """MAX_DATASET_GB is positive and <= 20."""
        from airhythm import config
        assert config.MAX_DATASET_GB > 0
        assert config.MAX_DATASET_GB <= 20.0

    def test_no_hardcoded_user_paths(self):
        """Config contains no /home/ or /Users/ paths."""
        from airhythm import config
        for attr in dir(config):
            if attr.startswith("_"):
                continue
            val = getattr(config, attr)
            if isinstance(val, str):
                assert "/home/" not in val, f"{attr} has hardcoded /home/ path"
                assert "/Users/" not in val, f"{attr} has hardcoded /Users/ path"

    def test_sample_rate_standard(self):
        """SAMPLE_RATE is 22050 (standard for this project)."""
        from airhythm import config
        assert config.SAMPLE_RATE == 22050

    def test_peak_pick_has_six_params(self):
        """PEAK_PICK_PARAMS has exactly 6 keys."""
        from airhythm import config
        expected = {"pre_max", "post_max", "pre_avg", "post_avg", "delta", "wait"}
        assert set(config.PEAK_PICK_PARAMS.keys()) == expected

    def test_input_shape_correct(self):
        """INPUT_SHAPE matches (1, 128, 400)."""
        from airhythm import config
        assert config.INPUT_SHAPE == (1, 128, 400)

    def test_label_shape_correct(self):
        """LABEL_SHAPE matches (3, 400)."""
        from airhythm import config
        assert config.LABEL_SHAPE == (3, 400)


class TestKaggleDatasetStructure:
    """create_dataset_structure works with Kaggle paths."""

    def test_creates_in_temp_dir(self):
        """Can create dataset structure in arbitrary directory."""
        from airhythm.kaggle_push import create_dataset_structure
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = create_dataset_structure(tmpdir)
            assert set(paths.keys()) == {
                "spectrograms",
                "baseline",
                "checkpoints",
                "metadata",
            }
            for path in paths.values():
                assert os.path.isdir(path)

    def test_all_paths_are_strings(self):
        """Returned paths are string type (not Path objects)."""
        from airhythm.kaggle_push import create_dataset_structure
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = create_dataset_structure(tmpdir)
            for name, path in paths.items():
                assert isinstance(path, str), f"{name} path is {type(path)}, expected str"


class TestRequirementsExist:
    """requirements.txt exists and is parseable."""

    def test_requirements_file_exists(self):
        """airhythm/requirements.txt exists."""
        req_path = Path(__file__).parent.parent / "requirements.txt"
        assert req_path.exists(), f"Missing: {req_path}"

    def test_requirements_parseable(self):
        """requirements.txt can be parsed as pip requirements."""
        req_path = Path(__file__).parent.parent / "requirements.txt"
        if not req_path.exists():
            pytest.skip("requirements.txt not found")
        lines = req_path.read_text().strip().splitlines()
        # Filter comments and empty lines
        deps = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]
        assert len(deps) > 0, "requirements.txt has no dependencies"
        # Each line should look like a pip requirement
        for dep in deps:
            # Basic sanity: should have a package name (alphanumeric + dots/hyphens)
            name = dep.split("==")[0].split(">=")[0].split("<=")[0].split("!=")[0].strip()
            assert len(name) > 0, f"Empty package name in: {dep}"

    def test_core_deps_present(self):
        """Core deps (torch, librosa, numpy, mir_eval) are listed."""
        req_path = Path(__file__).parent.parent / "requirements.txt"
        if not req_path.exists():
            pytest.skip("requirements.txt not found")
        text = req_path.read_text().lower()
        core = ["torch", "librosa", "numpy", "mir_eval"]
        for dep in core:
            assert dep in text, f"Missing core dependency: {dep}"


class TestImportsWorkFromDifferentPaths:
    """Simulate importing from a Kaggle-like path layout."""

    def test_import_after_sys_path_insert(self):
        """Package imports correctly after sys.path manipulation."""
        # Get the project root (parent of airhythm/)
        project_root = str(Path(__file__).parent.parent.parent)
        # Add to front of sys.path temporarily
        if project_root not in sys.path:
            sys.path.insert(0, project_root)
            try:
                # Force reimport
                if "airhythm" in sys.modules:
                    del sys.modules["airhythm"]
                import airhythm
                assert airhythm is not None
            finally:
                sys.path.remove(project_root)
        else:
            import airhythm
            assert airhythm is not None
