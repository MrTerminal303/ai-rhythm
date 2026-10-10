"""EXP-01a branch + EXP-01b parity tests (Phase 9).

RED deliverable: imports airhythm.export_onnx (missing until Task 3).
"""
from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")
onnx = pytest.importorskip("onnx")
ort = pytest.importorskip("onnxruntime")

from airhythm import config
from airhythm.export_onnx import export_model, torch_ge, verify_parity
from airhythm.model import AIRhythmCRNN


@pytest.fixture
def model():
    torch.manual_seed(0)        # seed BEFORE construction — pins the weights
    m = AIRhythmCRNN()
    m.eval()
    return m


def test_torch_ge_parses_local_version():
    assert torch_ge("2.13.0+cu130", 2, 11) is True
    assert torch_ge("2.10.1", 2, 11) is False
    assert torch_ge("2.11.0", 2, 11) is True


def test_export_picks_torchscript_below_threshold(model, tmp_path, monkeypatch):
    monkeypatch.setattr(torch, "__version__", "2.10.0")
    out = tmp_path / "m.onnx"
    assert export_model(model, out) == "torchscript"
    assert out.stat().st_size > 0


def test_export_falls_back_when_dynamo_raises(model, tmp_path, monkeypatch):
    real_export = torch.onnx.export

    def boom(*a, **k):
        if k.get("dynamo") is True:
            raise RuntimeError("fake dynamo failure")
        return real_export(*a, **k)

    monkeypatch.setattr(torch.onnx, "export", boom)
    out = tmp_path / "m.onnx"
    assert export_model(model, out) == "torchscript"
    assert out.stat().st_size > 0


def test_export_returns_dynamo_or_torchscript(model, tmp_path):
    out = tmp_path / "m.onnx"
    label = export_model(model, out)
    assert label in {"dynamo", "torchscript"}
    assert out.stat().st_size > 0


def test_dynamo_dynamic_shapes_use_axis_index_keys(model, tmp_path, monkeypatch):
    """09-02 regression: dynamic_shapes tuple form keys per-arg spec by AXIS
    INDEX ({0: ..., 3: ...}); {"mel": {...}} nesting is the TorchScript
    dynamic_axes API and makes torch.export read "mel" as a dimension."""
    import torch.export

    seen = {}
    real_export = torch.onnx.export

    def spy(*a, **k):
        if k.get("dynamo") is True:
            seen["shapes"] = k.get("dynamic_shapes")
        return real_export(*a, **k)

    monkeypatch.setattr(torch.onnx, "export", spy)
    # torch 2.13 local: no Dim constraint with min= breaks dynamo guard here,
    # so only assert the SHAPE STRUCTURE passed — never the export label.
    monkeypatch.setattr(torch.export, "Dim", lambda *a, **k: a[0] if a else None)
    out = tmp_path / "m.onnx"
    try:
        export_model(model, out)
    except Exception:
        pass  # export success irrelevant — structure assertion below is the test
    assert seen, "dynamo path was not attempted — version gate or API changed"
    shapes = seen["shapes"]
    assert isinstance(shapes, tuple) and len(shapes) == 1
    assert set(shapes[0].keys()) == {0, 3}, f"axis-index keys required, got {shapes!r}"


def test_parity_all_lengths(model, tmp_path, capsys):
    out = tmp_path / "dyn.onnx"
    export_model(model, out)
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    for t in (400, 250, 300):
        torch.manual_seed(1)
        x = torch.randn(1, 1, 128, t)
        assert verify_parity(model, sess, x) is True
    captured = capsys.readouterr()
    assert "PASS" in captured.out


def test_parity_static_fallback(model, tmp_path):
    out = tmp_path / "static.onnx"
    export_model(model, out, dynamic=False)
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    torch.manual_seed(1)
    assert verify_parity(model, sess, torch.randn(1, 1, 128, 400)) is True


def test_verify_rejects_bad_input(model, tmp_path):
    out = tmp_path / "m.onnx"
    export_model(model, out, dynamic=False)
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    with pytest.raises(ValueError):
        verify_parity(model, sess, torch.randn(1, 1, 100, 400))
    with pytest.raises(ValueError):
        verify_parity(model, sess, torch.randn(1, 1, 128, 400).double())
    assert config.ONNX_TOL == 1e-4
