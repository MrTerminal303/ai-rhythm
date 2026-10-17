# W3 B7 — AI spike report (toy ONNX in a Worker)

Protocol: **D25** (frozen before any number was produced). Results: **D26**. This template is
committed; the filled report lives at `evidence/w3-b7-spike-report.md` (gitignored).

## Tensor shape

- Model input `(1, 1, 128, T)` float32; T dynamic (derived by `Reshape([-1, 128])`, never a literal).
- Output `onset_logits` `(1, T, 1)`.
- **T_short = `<n>`**, **T_long = `<n>`** — both produced in ONE session (dynamic-T proof).

## Preprocessing pointer

- Committed source of truth: `apps/web/public/spike/preproc.json` (also `models/spike/testvectors/`).
- `sr` 22050, mono, `n_fft` 2048, `hop` 220, `n_mels` 128, `fmin` 0, `fmax` 11025, `htk` false,
  `norm` slaney, `power` 1.0, log = `power_to_db(ref=max)`, `center` true, Hann window.
- TS implementation: `packages/chartgen/src/mel.ts`. Python generator: `models/spike/gen_vectors.py`
  (`librosa.feature.melspectrogram` + `librosa.power_to_db`).

## Tolerances (D25 — FIXED, not re-definable by the measurement)

- `MEL_FEATURE_TOL = 1e-3`
- `MODEL_OUTPUT_TOL = 1e-3`

## Warm-up and window

- Warm-up = 3 discarded runs; timing = median of 5 runs + spread (min–max, p95).
- Vector mode window: per-length mel + inference on the committed 2 s and 30 s vectors.
- Benchmark mode window: full mel + inference on the 240 s `long.webm`, decoded in-page and
  streamed to the Worker (single-outstanding-chunk ack backpressure).

## Results vs both tolerances

| Category | Input | Measurement | Value | Verdict |
| --- | --- | --- | --- | --- |
| Mel parity | committed 2 s vector | mel MAE | `<measured>` | `<PASS/FAIL>` vs 1e-3 |
| Logits parity | committed 2 s vector | logits max-abs-diff | `<measured>` | `<PASS/FAIL>` vs 1e-3 |

## Runtime vs §13.3 budget

| Category | Input | median (5) | spread | Budget | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Full-track timing (MEASURED, direct)** | `long.webm` (240 s) | `<x>` s | `<min>–<max>` s | < 40 s | `<PASS/FAIL>` |
| Vector parity (NOT the budget verdict) | committed 2 s / 30 s | `<melMs>` / `<inferMs>` ms | — | n/a | n/a |

Extrapolated (labeled; NOT the verdict): `<formula, e.g. per-minute rate>`.

## Environment

- Browser: `<name + version>` (headless/headed); OS: `<...>`; machine: `<CPU/RAM>`.
- `onnxruntime-web@<version>` — WASM, single-thread, SIMD; WebGPU off (D24, PLAN §13.3).

## W8 recommendation

`<GO / NO-GO / conditional>` — `<one-sentence rationale; state whether it rests on direct measurement>`.

## Limitations

- Toy model ≠ CRNN: logits parity validates the **ORT-web plumbing**, not the real model.
- Full-track timing is a direct measurement on THIS machine/browser, not a cross-machine guarantee.
- The mel path's `power_to_db(ref=max)` is computed over the whole track; if a later design
  changes the reference (e.g. per-chunk), re-run under a NEW protocol version — never retro-fit D25.
