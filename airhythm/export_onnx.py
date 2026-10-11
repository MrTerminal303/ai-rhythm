"""ONNX export + parity verify (Phase 9: EXP-01).

Version-branch export: torch >= ONNX_DYNAMO_MIN tries dynamo=True with
dynamic_shapes, any exception falls back to TorchScript (opset 14).
CPU both sides — cuDNN GRU eval-backward raises on CUDA.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import torch

from airhythm import config

__all__ = ["torch_ge", "export_model", "verify_parity"]


def torch_ge(version: str, major: int, minor: int) -> bool:
    """Parse '2.13.0+cu130' -> (2,13) >= (major, minor). Strip +local / a / b / rc suffixes."""
    core = version.split("+")[0].split("-")[0]
    parts = re.split(r"[.ab]", core)
    nums = [int(p) for p in parts[:2] if p.isdigit()]
    while len(nums) < 2:
        nums.append(0)
    return tuple(nums) >= (major, minor)


def export_model(model, out_path, *, dynamic: bool = True) -> str:
    """Export AIRhythmCRNN to ONNX. Returns 'dynamo' or 'torchscript'."""
    model.eval()
    model.cpu()
    example = torch.randn(1, 1, 128, 400)
    if dynamic and torch_ge(torch.__version__, *config.ONNX_DYNAMO_MIN):
        try:
            batch_dim = torch.export.Dim("batch")
            time_dim = torch.export.Dim("time", min=1)
            prog = torch.onnx.export(
                model, (example,),
                input_names=["mel"], output_names=["logits"],
                # tuple form: per-arg spec keyed by AXIS INDEX (name-agnostic).
                # {"mel": {...}} nesting is the TorchScript dynamic_axes API —
                # leaving this out avoids the name-being-read-as-dimension bug
                # that caused the Kaggle error.
                dynamo=True, dynamic_shapes=({0: batch_dim, 3: time_dim},),
            )
            prog.save(str(out_path))  # NEVER f= on dynamo path
            # dynamo graphs can constant-fold the time axis (reshape baked
            # to the example's 400) — claim "dynamo" only if a second
            # length actually runs; else fall back to TorchScript.
            import onnxruntime as ort
            _chk = ort.InferenceSession(str(out_path),
                                        providers=["CPUExecutionProvider"])
            _chk.run(None, {_chk.get_inputs()[0].name:
                            torch.randn(1, 1, 128, 250).numpy()})
            return "dynamo"
        except Exception as e:
            print(f"DYNAMO EXPORT FAILED, falling back: {type(e).__name__}: {e}")
    kwargs = dict(input_names=["mel"], output_names=["logits"],
                  dynamo=False, opset_version=config.ONNX_OPSET)
    if dynamic:
        kwargs["dynamic_axes"] = {"mel": {0: "batch", 3: "time"},
                                  "logits": {0: "batch", 1: "time"}}
    # dynamic=False (D-03 fallback): NO dynamic_axes = static 400
    torch.onnx.export(model, (example,), str(out_path), **kwargs)
    return "torchscript"


def verify_parity(model, sess, x, tol: float = config.ONNX_TOL) -> bool:
    """Same input through torch vs ORT; True iff max(abs diff) < tol."""
    if (not isinstance(x, torch.Tensor) or x.ndim != 4 or x.shape[1] != 1
            or x.shape[2] != config.N_MELS or x.dtype != torch.float32):
        raise ValueError(
            f"bad parity input: need float32 (1,1,{config.N_MELS},T) tensor, "
            f"got {type(x).__name__} shape={tuple(x.shape) if isinstance(x, torch.Tensor) else '?'} "
            f"dtype={x.dtype if isinstance(x, torch.Tensor) else '?'}")
    model.eval()
    model.cpu()
    with torch.no_grad():
        ref = model(x).cpu().numpy()
    name = sess.get_inputs()[0].name
    got = sess.run(None, {name: x.numpy().astype(np.float32)})[0]
    d = float(np.abs(ref - got).max())
    print(f"T={x.shape[3]} max(abs diff)={d:.3e} {'PASS' if d < tol else 'FAIL'}")
    return d < tol
