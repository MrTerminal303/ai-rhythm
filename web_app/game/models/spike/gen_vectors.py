"""B7 spike vector generator (W3 T17).

Single source of truth for EVERY artifact the spike compares against:
`preproc.json` is written FIRST and every other artifact is derived from it.

Writes to `models/spike/testvectors/` (the record) and mirrors the web-servable
copies to `apps/web/public/spike/` (what `/spike` and `e2e/w3-spike.spec.ts` fetch).

Deterministic: fixed seeds, no torch, numpy + onnx + onnxruntime + librosa +
soundfile only. Run with the pinned venv (see requirements.txt).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import librosa
import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
from onnx import TensorProto, helper, numpy_helper

SEED = 20261017
SHORT_SECONDS = 2.0
LONG_SECONDS = 30.0
MODEL_OPSET = 17

HERE = Path(__file__).resolve().parent
TESTVECTORS = HERE / "testvectors"
WEB_COPIES = (HERE / ".." / ".." / "apps" / "web" / "public" / "spike").resolve()

# ---------------------------------------------------------------- preproc.json
# The frozen preprocessing contract (D25). Written first; everything below reads
# these values rather than hard-coding its own copies.
PREPROC = {
    "version": 1,
    "sr": 22050,
    "channels": 1,
    "n_fft": 2048,
    "hop": 220,
    "n_mels": 128,
    "fmin": 0.0,
    "fmax": 11025.0,
    "htk": False,
    "norm": "slaney",
    "power": 1.0,
    "log": "power_to_db_ref_max",
    "amin": 1e-10,
    "top_db": 80.0,
    "center": True,
    "pad_mode": "constant",
    "window": "hann",
}


def synth_pcm(seconds: float, sr: int) -> np.ndarray:
    """Deterministic synthetic mono PCM in [-1, 1) — reproducible from SEED alone."""
    rng = np.random.default_rng(SEED)
    n = int(round(seconds * sr))
    t = np.arange(n, dtype=np.float64) / sr
    # A few partials at musical-ish frequencies so the mel bands are actually populated,
    # plus a seeded noise floor so no frame is accidentally silent.
    sig = np.zeros(n, dtype=np.float64)
    for freq, amp in ((220.0, 0.5), (440.0, 0.3), (880.0, 0.15), (1760.0, 0.05)):
        sig += amp * np.sin(2.0 * math.pi * freq * t)
    # Amplitude envelope with a seeded tremolo so frames differ along the time axis.
    sig *= 0.5 + 0.5 * np.sin(2.0 * math.pi * 0.75 * t)
    sig += 0.01 * rng.standard_normal(n)
    peak = float(np.max(np.abs(sig)))
    if peak > 0:
        sig = 0.95 * sig / peak
    return sig.astype(np.float32)


def expected_mel(y: np.ndarray) -> np.ndarray:
    """librosa melspectrogram + power_to_db, exactly the pinned preproc fields."""
    mel = librosa.feature.melspectrogram(
        y=y,
        sr=PREPROC["sr"],
        n_fft=PREPROC["n_fft"],
        hop_length=PREPROC["hop"],
        win_length=PREPROC["n_fft"],
        window=PREPROC["window"],
        center=PREPROC["center"],
        pad_mode=PREPROC["pad_mode"],
        power=PREPROC["power"],
        n_mels=PREPROC["n_mels"],
        fmin=PREPROC["fmin"],
        fmax=PREPROC["fmax"],
        htk=PREPROC["htk"],
        norm=PREPROC["norm"],
    )
    return librosa.power_to_db(mel, ref=np.max, amin=PREPROC["amin"], top_db=PREPROC["top_db"])


def frame_count(n_samples: int) -> int:
    """librosa center=True + pad_mode=constant: 1 + floor(n/hop) frames."""
    return 1 + n_samples // PREPROC["hop"]


# ------------------------------------------------------------------- toy.onnx
def build_toy_model(path: Path) -> None:
    """Transpose -> Reshape([-1,128]) -> MatMul(128,1) -> Unsqueeze(0).

    T is DYNAMIC end to end: the Reshape target is `[-1, 128]` (never a literal
    frame count), so the same graph runs at 2 s and 30 s.
    """
    rng = np.random.default_rng(SEED)
    weight = (rng.standard_normal((PREPROC["n_mels"], 1)) * 0.1).astype(np.float32)

    graph = helper.make_graph(
        nodes=[
            helper.make_node("Transpose", ["mel"], ["mel_t"], perm=[0, 1, 3, 2]),
            helper.make_node("Reshape", ["mel_t", "reshape_shape"], ["mel_flat"]),
            helper.make_node("MatMul", ["mel_flat", "weight"], ["logits_t"]),
            helper.make_node("Unsqueeze", ["logits_t", "unsqueeze_axes"], ["onset_logits"]),
        ],
        name="b7_toy_onset",
        inputs=[helper.make_tensor_value_info("mel", TensorProto.FLOAT, ["batch", "channel", PREPROC["n_mels"], "frames"])],
        outputs=[helper.make_tensor_value_info("onset_logits", TensorProto.FLOAT, ["batch", "frames", 1])],
        initializer=[
            numpy_helper.from_array(np.array([-1, PREPROC["n_mels"]], dtype=np.int64), "reshape_shape"),
            numpy_helper.from_array(weight, "weight"),
            numpy_helper.from_array(np.array([0], dtype=np.int64), "unsqueeze_axes"),
        ],
    )
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", MODEL_OPSET)],
        producer_name="airhythm-b7-spike",
    )
    # Newer `onnx` releases emit an IR version the pinned runtimes reject (ORT 1.30 max = 13).
    # Pin a portable IR so the SAME toy.onnx loads in Python ORT and onnxruntime-web.
    model.ir_version = 10
    onnx.checker.check_model(model)
    onnx.save(model, str(path))


def run_toy(path: Path, mel_db: np.ndarray) -> np.ndarray:
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    # (1, 1, n_mels, T) — the model's declared input layout (mel-freq, then time).
    tensor = mel_db[np.newaxis, np.newaxis, :, :].astype(np.float32)
    (logits,) = sess.run(["onset_logits"], {"mel": tensor})
    assert logits.shape[0] == 1 and logits.shape[2] == 1, f"unexpected output shape {logits.shape}"
    return logits


def write_all() -> None:
    TESTVECTORS.mkdir(parents=True, exist_ok=True)
    WEB_COPIES.mkdir(parents=True, exist_ok=True)

    preproc_path = TESTVECTORS / "preproc.json"
    preproc_path.write_text(json.dumps(PREPROC, indent=2) + "\n", encoding="utf8")

    sr = PREPROC["sr"]
    short = synth_pcm(SHORT_SECONDS, sr)
    long = synth_pcm(LONG_SECONDS, sr)
    sf.write(str(TESTVECTORS / "input.wav"), short, sr, subtype="PCM_16")
    sf.write(str(TESTVECTORS / "long_input.wav"), long, sr, subtype="PCM_16")

    short_mel = expected_mel(short)
    long_mel = expected_mel(long)
    assert short_mel.shape[1] == frame_count(short.size), (short_mel.shape, frame_count(short.size))
    assert long_mel.shape[1] == frame_count(long.size), (long_mel.shape, frame_count(long.size))

    # `expected_mel.json` stores ROWS of frame-major vectors — `[frames][n_mels]` —
    # matching the flat frame-major layout the TS side returns row-by-row.
    (TESTVECTORS / "expected_mel.json").write_text(
        json.dumps(np.round(short_mel.T, 6).tolist()), encoding="utf8"
    )
    (TESTVECTORS / "expected_mel_long.json").write_text(
        json.dumps(np.round(long_mel.T, 6).tolist()), encoding="utf8"
    )

    model_path = TESTVECTORS / "toy.onnx"
    build_toy_model(model_path)

    short_logits = run_toy(model_path, short_mel)
    long_logits = run_toy(model_path, long_mel)
    assert short_logits.shape == (1, short_mel.shape[1], 1), short_logits.shape
    assert long_logits.shape == (1, long_mel.shape[1], 1), long_logits.shape

    (TESTVECTORS / "expected_logits.json").write_text(
        json.dumps(np.round(short_logits, 6).tolist()), encoding="utf8"
    )
    (TESTVECTORS / "expected_logits_long.json").write_text(
        json.dumps(np.round(long_logits, 6).tolist()), encoding="utf8"
    )

    for name in (
        "preproc.json",
        "input.wav",
        "long_input.wav",
        "expected_mel.json",
        "expected_mel_long.json",
        "toy.onnx",
        "expected_logits.json",
        "expected_logits_long.json",
    ):
        (WEB_COPIES / name).write_bytes((TESTVECTORS / name).read_bytes())

    print(
        "[gen_vectors] wrote "
        f"short_frames={short_mel.shape[1]} long_frames={long_mel.shape[1]} "
        f"mel_json_roundtrip_max_abs="
        f"{float(np.max(np.abs(short_mel.T - np.array(json.loads((TESTVECTORS / 'expected_mel.json').read_text()))))):.2e}"
    )
    print(f"[gen_vectors] librosa={librosa.__version__} onnx={onnx.__version__} ort={ort.__version__}")


if __name__ == "__main__":
    write_all()
