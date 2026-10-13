"""ONNX export + parity verify (Phase 9: EXP-01).

Version-branch export: torch >= ONNX_DYNAMO_MIN tries dynamo=True with
dynamic_shapes, any exception falls back to TorchScript (opset 14).
CPU both sides — cuDNN GRU eval-backward raises on CUDA.
"""
from __future__ import annotations

import contextlib
import re
import warnings
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


@contextlib.contextmanager
def _gru_dynamic_export():
    """Scope for ONE dynamo export call — GRU decomp patch + torch-noise filters.

    Hold register_gru_while_loop_decomposition for the WHOLE torch.onnx.export
    (capture AND ONNX prepare), not just capture:
    - torch < 2.13: the ONNX exporter never registers it -> tracing specializes
      the time axis to the example's 400, and the exporter's
      refine_dynamic_shapes_from_suggested_fixes silently rewrites dynamic_shapes
      to static (input mel [.., 400]; the T=250 self-check then rejects with
      'Got: 250 Expected: 400').
    - torch >= 2.13: exporter registers it around capture only -> prepare
      re-bakes post-GRU value_info static [1, 400, 256]; ORT's default
      optimizations insert a constant reshape and every T != 400 run fails.

    Filters = two researched torch-internal false positives, unreachable from
    model code: RNN _flat_weights attribute-snapshot warning
    (torch/_functorch/_aot_autograd/frontend_utils.py — state is restored,
    weights ARE registered parameters) and dynamo's deprecated
    isinstance(treespec, LeafSpec) (torch/_dynamo/variables/builder.py).
    """
    try:
        from torch.export._patches import register_gru_while_loop_decomposition
        rnn_ctx = register_gru_while_loop_decomposition()
    except ImportError:
        rnn_ctx = contextlib.nullcontext()
    with rnn_ctx, warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore", message=r".*were assigned during export\..*",
            category=UserWarning)
        warnings.filterwarnings(
            "ignore",
            message=r"`isinstance\(treespec, LeafSpec\)` is deprecated.*",
            category=FutureWarning)
        yield


def export_model(model, out_path, *, dynamic: bool = True) -> str:
    """Export AIRhythmCRNN to ONNX. Returns 'dynamo' or 'torchscript'."""
    model.eval()
    model.cpu()
    example = torch.randn(1, 1, 128, 400)
    if dynamic and torch_ge(torch.__version__, *config.ONNX_DYNAMO_MIN):
        try:
            batch_dim = torch.export.Dim("batch")
            time_dim = torch.export.Dim("time", min=1)
            with _gru_dynamic_export():
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
