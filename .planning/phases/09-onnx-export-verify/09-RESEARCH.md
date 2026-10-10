# Phase 9: ONNX Export + Verify - Research

**Researched:** 2026-10-10
**Domain:** PyTorch → ONNX export of single bidirectional-GRU CRNN + same-session numerical parity verify
**Confidence:** HIGH

## Summary

Phase 9 exports gate-passed `best_*.pt` to ONNX and proves `max(abs(torch − onnx)) < 1e-4` at lengths 400/250/300 plus one whole-song single pass, both sides on CPU EP. Runtime version check picks path: torch ≥2.11 tries `dynamo=True` (`dynamic_shapes`), any failure falls to `dynamo=False` TorchScript (`dynamic_axes`, opset 14).

Critical risk confirmed real upstream: dynamo exporter freezes example time length into internal `Expand` for manual bidirectional RNN patterns (pytorch#191855, Aug 2026). Our model uses one bare `nn.GRU(bidirectional=True)` — the pattern upstream control cases show passing — but multi-length verify stays the guard regardless, TorchScript fallback immune.

**Primary recommendation:** Package module `airhythm/export_onnx.py` with `export()` (version branch, `.save()` on ONNXProgram) + `verify_parity()` (CPU-EP both sides, literal PASS/FAIL), mirrored pytest on seeded random weights, one Kaggle CELL on `best_*.pt` + real song(s).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Parity check runs on held-out search song **2561773** (D-16: never used in training/gate decisions) **plus a user-supplied custom song**. Verify function takes a song path parameter — no hardcoded song-ID lists.
- **D-02:** Real song goes through **whole-song single pass** — one dynamic-length forward at the song's true frame count (10k+ frames), both torch and ONNX on CPU EP. This directly exercises the frozen-dynamic-time-axis critical risk; chunked-only verify would miss it.
- **D-03:** Fixed-400 sliding-window (200-frame-hop) fallback engages when **dynamic export raises OR whole-song parity fails**. Fallback path = re-export fixed-400, re-verify chunked at 200-hop. **Either path fully verified = phase PASS**, with the winning path clearly labeled in output.
- **D-04:** Export source = `best_*.pt` (Phase 8 select-for-inference policy). Artifact pushed to **Kaggle Dataset as `onnx/stage1_best.onnx`** — stage-tagged name so Stages 2–4 re-exports never clobber Stage 1.
- **D-05:** Package module `airhythm/export_onnx.py` + mirrored `airhythm/tests/test_export_onnx.py` (local pytest: version-branch logic + parity at 400/250/300 with seeded random weights on CPU) **plus** one Kaggle CELL running the same functions on `best_*.pt` + real song(s).

### Claude's Discretion
- Dependency pin syntax beyond roadmap floors (`onnx>=1.16`, `onnxscript>=0.1`, `onnxruntime>=1.20`)
- Exact CELL number / which example notebook hosts the export cell
- Naming of intermediate verify output files
- Whether local parity test asserts exact tolerance constant from config or literal

### Deferred Ideas (OUT OF SCOPE)
- Postprocess → JSON chart pipeline — Phase 10 (PST-01)
- Real-time ONNX inference in C++ engine — v2
- Stage 2–4 head exports (only stage-tagged naming anticipates them)
- ONNX model-quality re-evaluation — parity is not accuracy, Phase 8 gate authoritative
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EXP-01 | Runtime version-check first cell; torch ≥2.11 → dynamo=True (`dynamic_shapes`), catch → TorchScript (`dynamic_axes`, opset 14); same-session CPU-EP verify `<1e-4` at 400/250/300 + one real song | Export API + branch pattern, verify snippet, opset rationale, GRU pitfalls below |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Minimum code solving problem. No speculative features, no single-use abstractions.
- Surgical changes: touch only what phase needs; match existing style; new constants go in `config.py` with `__all__`.
- State assumptions explicitly when uncertain.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| ONNX export + parity verify | Training/offline (Kaggle notebook) | — | One-shot artifact production, not serving |
| Seeded local parity test | Dev machine (pytest) | — | Proves machinery without GPU/Kaggle |
| Exported `.onnx` storage | Kaggle Dataset (`onnx/stage1_best.onnx`) | — | D5 single source of truth |
| Postprocess/JSON | Phase 10 | — | Out of scope here |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| torch | runtime-decided (local 2.13.0+cu130) [VERIFIED: local import] | export subject + reference outputs | Kaggle env decides path via `torch.__version__`; ≥2.11 dynamo threshold per STATE decision #8 [CITED: project STATE.md] |
| onnx | `>=1.16` floor (latest 1.23.2) [VERIFIED: pip index] | ModelProto IR | Floor predates all plausible Kaggle images; ORT 1.20 pairs with ONNX 1.16.1/opset 21 [CITED: onnxruntime.ai/docs/reference/compatibility.html] |
| onnxscript | `>=0.1` floor (latest 0.7.2) [VERIFIED: pip index] | dynamo exporter torchlib | Dynamo path imports torchlib; missing package = dynamo ImportError → caught → TorchScript fallback |
| onnxruntime | `>=1.20` floor (latest 1.31.0) [VERIFIED: pip index] | Verify-side inference, CPU EP | `InferenceSession(path, providers=["CPUExecutionProvider"])` standard pattern [CITED: onnxruntime.ai/docs/api/python] |
| numpy | env's own, unpinned | torch↔ORT bridge (`.numpy()`) | Pinning numpy broke Kaggle dist-packages before (requirements.txt comment) — do not pin |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| torch.export.Dim | bundled with torch ≥2.11 | symbolic time/batch dims | dynamo `dynamic_shapes` only |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| dynamo export | TorchScript-only always | Loses preferred path; use only as fallback (locked D-03) |
| opset 14 (TorchScript path) | opset 18+ | Newer ops unsupported by older Kaggle ORT; 14 runs on ORT ≥1.8 [CITED: compat table]. Keep 14. |
| `onnxruntime-gpu` | `onnxruntime` (CPU) | GPU EP silently drops to CPU on Kaggle anyway; CPU-only verify kills TF32/CUDA-CPU diff class |

**Installation:**
```bash
pip install "onnx>=1.16" "onnxscript>=0.1" "onnxruntime>=1.20"
```

## Architecture Patterns

### System Architecture Diagram

```
best_*.pt (Kaggle Dataset, epoch 141)
  │
  ▼
load state_dict → AIRhythmCRNN → .eval() → .cpu()          (both sides CPU EP, no-grad)
  │
  ▼
version cell: print torch/ort/onnx versions + get_available_providers()
  │  torch ≥2.11 ──► try dynamo=True + dynamic_shapes ──► ONNXProgram.save()
  │       │                      │ raises (GRU/export bug)
  │       │                      ▼
  │       └──────────► dynamo=False TorchScript + dynamic_axes, opset 14
  │  torch <2.11 ──► TorchScript only
  ▼
InferenceSession(providers=["CPUExecutionProvider"]) → sess.get_providers() logged
  │
  ▼
parity: max(abs(torch−onnx)) < 1e-4 at T=400, 250, 300 + whole-song single pass (10k+ frames)
  │  pass ──► PHASE PASS, push onnx/stage1_best.onnx to Dataset
  │  dynamic-export-raises OR whole-song-fails
  ▼
fallback: re-export fixed-400 (no dynamic axes) → chunked verify at 200-hop → PASS labeled "fallback"
```

### Recommended Project Structure
```
airhythm/
├── export_onnx.py        # export(), verify_parity(), version_branch() — NEW
├── config.py             # + ONNX_TOL, ONNX_OPSET, ONNX_* names/paths, __all__ — EDIT
├── requirements.txt      # + 3 floor pins — EDIT
├── model.py              # untouched (export subject)
└── tests/
    └── test_export_onnx.py  # branch logic + seeded parity 400/250/300 — NEW
examples/kaggle_c_eval.py   # + one export CELL (copy-paste-per-cell) — EDIT
```

### Pattern 1: Version-branch export
**What:** Try dynamo, catch every exception, fall back to TorchScript. Return winning path label.
**When to use:** Always — Kaggle torch version unknown until runtime.
**Example:**
```python
# Source: https://docs.pytorch.org/docs/2.14/onnx_export.html (f=None + .save() recommendation)
import torch

def export(model, example_x, out_path):
    if _torch_ge(2, 11):
        try:
            prog = torch.onnx.export(
                model, (example_x,),
                input_names=["mel"], output_names=["logits"],
                dynamo=True, dynamic_shapes=({"mel": {0: _B, 3: _T}},),  # [ASSUMED] index map, see A1
            )
            prog.save(out_path)
            return "dynamo"
        except Exception as e:
            print(f"DYNAMO EXPORT FAILED, falling back: {type(e).__name__}: {e}")
    torch.onnx.export(
        model, (example_x,), out_path,
        input_names=["mel"], output_names=["logits"],
        dynamo=False, opset_version=14,
        dynamic_axes={"mel": {0: "batch", 3: "time"}, "logits": {0: "batch", 1: "time"}},
    )
    return "torchscript"
```
Notes: `dynamo` defaults True since 2.9 — pass explicitly anyway (Kaggle may run older 2.x) [CITED: docs.pytorch.org 2.14 changelog]. Never pass `f=` with dynamo path; `f` kept for backward compat only. Never `export_params=False`.

### Pattern 2: CPU-EP parity verify
**What:** Same input, torch vs ORT, `float(max(abs diff))`, literal PASS/FAIL print.
**When to use:** Every length, both paths.
```python
# Source: onnxruntime.ai/docs/api/python + standard parity pattern
import numpy as np, onnxruntime as ort, torch

def verify_parity(model, sess, x, tol=1e-4):
    model.eval()
    with torch.no_grad():
        ref = model(x.cpu()).cpu().numpy()
    name = sess.get_inputs()[0].name
    got = sess.run(None, {name: x.cpu().numpy().astype(np.float32)})[0]
    d = float(np.abs(ref - got).max())
    print(f"T={x.shape[3]} max(abs diff)={d:.3e} {'PASS' if d < tol else 'FAIL'}")
    return d < tol
```
Session construction: `ort.InferenceSession(path, providers=["CPUExecutionProvider"])`, then log `sess.get_providers()` — proves no silent GPU EP [CITED: onnxruntime.ai execution-provider docs].

### Anti-Patterns to Avoid
- **Export/verify on CUDA:** cuDNN GRU eval-backward raises on CUDA (model.py docstring); CUDA↔CPU MatMul diffs from TF32 defaults (microsoft/onnxruntime#23792). Both sides CPU, always.
- **Chunked-only verify:** passes while real songs throw `Got: X Expected: 400`. Whole-song single pass mandatory (D-02).
- **`dynamic_axes` on dynamo path:** ignored tree shape — dynamo needs nested `dynamic_shapes`, TorchScript needs flat `dynamic_axes` [CITED: 2.14 docs]. Mixing = silently static graph.
- **Opportunistic opset bump:** keep 14 on TorchScript path for max ORT compat.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Dynamic time axis | ONNX graph surgery / shape hacks | `dynamic_shapes` / `dynamic_axes` | Upstream while_loop decompositions handle RNN loops; hand edits rot per version |
| Parity harness | Custom diff framework | `sess.run` + `max(abs)` + literal print | Phase 6/7 pattern; 1e-4 abs standard |
| Chunk merge for fallback verify | Overlap-add merger here | Per-chunk parity only | Merge semantics belong to Phase 10 (PST-01) |
| Crypto/integrity of artifact | Checksums-as-security | Parity check itself | Corrupt weights fail parity; no extra infra |

**Key insight:** Export is a solved interop path with known upstream bugs and known fallbacks. Every custom workaround here becomes version-locked tech debt.

## Common Pitfalls

### Pitfall 1: Frozen dynamic time axis (BiGRU, dynamo)
**What goes wrong:** Export at T=400 succeeds; ORT throws `invalid expand shape` / `Got: X Expected: 400` at other lengths.
**Why it happens:** Dynamo retraces RNN decompositions with Python-loop variant, specializing time dim to example length (pytorch#191855; fix PRs #191881/#193192 may postdate Kaggle torch).
**How to avoid:** `dynamic_shapes` with symbolic time + verify at 3 lengths + whole song. Fallback TorchScript immune (legacy exporter passes per issue repro).
**Warning signs:** Graph contains literal `6`/`400` in internal `Expand` shapes; passes at export length only.

### Pitfall 2: Dynamo GRU export exceptions
**What goes wrong:** `ConversionError` / `SymbolicTensor object is not iterable` / `unbind` translation failure on some torch+onnxscript combos (pytorch#126339, #164834).
**Why it happens:** GRU decomposition ↔ torchlib version skew.
**How to avoid:** Broad `except Exception` → TorchScript. Fixed onnxscript (0.7.1+ GRU/LSTM ops per microsoft/onnxscript#2674) is a reason floors stay floors, not pins.

### Pitfall 3: Forgot `model.eval()` / wrong device
**What goes wrong:** Parity fails by ~1e-2 with no export bug (BN running-stats update, dropout).
**Why it happens:** Checkpoint loads in train mode by default.
**How to avoid:** `model.eval(); model.cpu()` first lines of both export and verify; `torch.no_grad()` on reference forward.

### Pitfall 4: `export_params=False` or `f=` misuse
**What goes wrong:** Weightless ONNX (runs, garbage outputs) or deprecation-path serialization.
**Why it happens:** Copy-pasted snippets.
**How to avoid:** Never `export_params=False`; dynamo path leaves `f=None` and calls `prog.save(path)`.

### Pitfall 5: Whole-song CPU memory surprise
**What goes wrong:** [ASSUMED] 10k+ frame single pass OOMs on constrained host.
**Why it happens:** (1,1,128,10000) activations ≈ tens of MB/layer — fine on paper, unverified on Kaggle CPU.
**How to avoid:** Try single pass first (D-02); OOM counts as "whole-song parity fails" → D-03 fallback engages. No preemptive chunking.

## Code Examples

### dynamic_shapes with symbolic dims
```python
# Source: https://docs.pytorch.org/docs/2.14/onnx_export.html
import torch
B = torch.export.Dim("batch")  # or torch.export.Dim.AUTO
T = torch.export.Dim("time", min=1)  # [ASSUMED] kwarg name, see A2
prog = torch.onnx.export(
    model, (torch.randn(1, 1, 128, 400),),
    input_names=["mel"], output_names=["logits"],
    dynamo=True, dynamic_shapes=({"mel": {0: B, 3: T}},),
)
prog.save("stage1_best.onnx")
```
Input rank is (B,1,128,T) so time index 3, batch 0 [VERIFIED: model.py forward]. Output (B,T,1): `dynamic_axes={"logits": {0:"batch", 1:"time"}}` on TorchScript path.

### Fixed-400 fallback export + chunked verify
```python
torch.onnx.export(model, (torch.randn(1, 1, 128, 400),), path,
                  input_names=["mel"], output_names=["logits"],
                  dynamo=False, opset_version=14)  # no dynamic_axes = static 400
# verify: slide 400-window, 200-hop over song frames; parity per chunk
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| TorchScript-only export, `f=` path | dynamo default (2.9+), `.save()` on ONNXProgram | torch 2.9 (2025) | Preferred path; `f` backward-compat only |
| Dynamo threshold ≥2.14 (ARCHITECTURE.md) | Real threshold 2.11 (PR #169710) | STATE decision #8 | Branch condition locked at 2.11 |
| RNN dynamic export broken (Python-loop decomposition) | while_loop decompositions when `dynamic_shapes` present | PR #184872 + #191881/#193192 (2025–2026) | Bare `nn.GRU` dynamic works on recent torch; manual-bidir fix may postdate Kaggle — keep fallback |
| `training=`/`do_constant_folding` kwargs | Deprecated; set `model.eval()` before export | torch 2.6 | One more reason eval-first is load-bearing |

**Deprecated/outdated:**
- `torch.onnx.dynamo_export` standalone fn: folded into `torch.onnx.export(dynamo=True)`.
- `dynamic_axes` on dynamo path: use `dynamic_shapes`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | dynamo `dynamic_shapes` for single-arg model = `({"mel": {0: B, 3: T}},)` tuple-of-one-dict keyed by input name | Code Examples | Export raises → caught by fallback; low risk, but Kaggle CELL should print exception |
| A2 | `torch.export.Dim("time", min=1)` kwarg; `Dim.AUTO` exists as fallback | Code Examples | Same as A1 — broad except covers |
| A3 | Whole-song 10k+ frames fits Kaggle CPU RAM single-pass | Pitfall 5 | OOM → D-03 fallback engages; explicitly covered |
| A4 | Kaggle pre-installs torch; `pip install` of 3 floors works if missing | Environment | CELL must `pip install` unconditionally-safe (skip-if-present per requirements pattern) |

## Open Questions (RESOLVED)

1. **Kaggle torch/ORT versions at run time** — RESOLVED: runtime branch absorbs version drift; first CELL prints versions + providers as evidence.
   - What we know: Local 2.13.0; floors cover ≥1.20 ORT / ≥1.16 onnx.
   - What's unclear: Actual Kaggle image versions — unknowable offline by design.
   - Recommendation: Runtime branch handles it; first cell prints all versions + `get_available_providers()` into pasted evidence.
2. **Whether fix PR #193192 is in Kaggle torch** — RESOLVED: no action needed; multi-length verify detects, fallback resolves.
   - What we know: Bare (non-manual) BiGRU passes even without it per issue control cases.
   - Recommendation: No action — multi-length verify detects, fallback resolves.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| torch (local) | seeded parity test | ✓ | 2.13.0+cu130 | — |
| onnx (local) | export machinery test | ✗ | — | `pip install "onnx>=1.16"` (Wave 0; env externally-managed → venv or `--break-system-packages`) |
| onnxruntime (local) | parity test | ✗ | — | same as above |
| onnxscript (local) | dynamo path test | ✗ | — | same as above |
| Kaggle torch/ORT | export CELL | ? by design | ? | runtime version branch |
| pytest + pytest.ini | validation | ✓ | repo has pytest.ini, tests/ mirrored | — |

**Missing dependencies with no fallback:** None — every gap has a branch or install step.
**Missing dependencies with fallback:** Local onnx stack (pip install in Wave 0).

Graph context: SKIPPED — workspace not CodeGraph-indexed this session.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (repo has pytest.ini) |
| Config file | pytest.ini |
| Quick run command | `pytest airhythm/tests/test_export_onnx.py -x -q` |
| Full suite command | `pytest airhythm/tests/ -q` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EXP-01a | version-branch picks dynamo vs torchscript | unit (monkeypatched version) | `pytest airhythm/tests/test_export_onnx.py -x -q` | ❌ Wave 0 |
| EXP-01b | seeded parity <1e-4 at 400/250/300 CPU | unit | same file | ❌ Wave 0 |
| EXP-01c | whole-song single pass + fallback on Kaggle | manual-only | Kaggle CELL paste (literal PASS/FAIL) | n/a — human-run evidence |

### Sampling Rate
- **Per task commit:** `pytest airhythm/tests/test_export_onnx.py -x -q`
- **Per wave merge:** `pytest airhythm/tests/ -q`
- **Phase gate:** test file green + Kaggle CELL paste (both paths labeled) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `airhythm/tests/test_export_onnx.py` — covers EXP-01a/b
- [ ] Framework install: `pip install "onnx>=1.16" "onnxscript>=0.1" "onnxruntime>=1.20"` — none of the three importable locally
- [ ] `config.py` additions: tolerance, opset, artifact name (`stage1_best.onnx`), floor pins documented

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — (offline artifact step) |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes | Validate rank/dtype/length before export+verify; verify fn takes song path param — reject non-file, non-float32, wrong-mel-bin inputs loudly |
| V6 Cryptography | no | No hand-rolled anything; parity check doubles as corruption detection |

### Known Threat Patterns for torch→ONNX export

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Weightless/corrupt artifact pushed as good | Tampering | Parity gate blocks push; stage-tagged name prevents clobber |
| Silent provider downgrade (GPU→CPU) changing numerics | — (reliability) | CPU-only both sides + logged `get_providers()` |

## Sources

### Primary (HIGH confidence)
- Local `torch 2.13.0` `inspect.signature(torch.onnx.export)` — full kwarg list incl. `dynamo=True` default, `dynamic_shapes` vs `dynamic_axes`, `export_params`, `f` compat note [VERIFIED]
- https://docs.pytorch.org/docs/2.14/onnx_export.html — dynamo API, `.save()`, dynamic_shapes tree vs dynamic_axes flat, opset/deprecation notes [CITED]
- `pip index versions` — onnx 1.23.2, onnxruntime 1.31.0, onnxscript 0.7.2 [VERIFIED]
- https://onnxruntime.ai/docs/reference/compatibility.html — ORT↔ONNX↔opset table [CITED]
- https://onnxruntime.ai/docs/api/python/api_summary.html — providers ordered preference, CPU last [CITED]
- pytorch#191855 + PRs #184872/#191881/#193192 — frozen-time-axis bug, repro, fix [CITED]
- pytorch#164834, #126339, microsoft/onnxscript#2674 — GRU dynamo failure modes + fixes [CITED]

### Secondary (MEDIUM confidence)
- microsoft/onnxruntime#23792 (TF32 MatMul CPU/GPU diff) — supports CPU-only-both-sides rule
- onnxruntime#21220 (CPU/CUDA reduction-order diffs) — same

### Tertiary (LOW confidence)
- None — all load-bearing claims verified or cited.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — registry versions + local torch signature + compat table
- Architecture: HIGH — official docs + locked CONTEXT decisions map 1:1 to patterns
- Pitfalls: HIGH — upstream issue repros match our exact model class (BiGRU, dynamic time)

**Research date:** 2026-10-10
**Valid until:** ~30 days (stable domain; only Kaggle image drift matters, branch absorbs it)
