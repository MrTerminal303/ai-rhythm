# Roadmap: AIRhythm

## Overview

Train a CRNN neural network from scratch (no pretrained models, no transfer learning) to convert raw audio into rhythm game note charts. Five sequential phases: foundation data pipeline, then four incremental model heads (onset, hold, chord, special class). Each head stage has hard gates -- must overfit toy synthetic set and beat prior benchmarks before proceeding. Game engine (C++) deferred to v2. All training on Kaggle/Colab at $0 cost.

**v1.0** established the Phase 0 foundation (data pipeline, toygen, baseline yardstick). **v1.1** (current milestone) expands the old coarse "Phase 1: Onset Head" into six detailed phases (5-10) that ship Stage 1: CRNN backbone + onset head overfits toy set, beats a pinned librosa baseline on the acoustic-salience bucket of real songs, exports verified ONNX, and emits primary-onset JSON charts.

## Phases

- [x] **Phase 0: Foundation** -- Data pipeline (scraper, audio preprocessing, .osu parser), toygen synthetic dataset, librosa baseline metrics, Kaggle Dataset persistence
- [ ] **Phase 1: Onset Head** -- CRNN backbone + onset detection head, overfit toy set, beat baseline on real songs, ONNX export with numerical verification *(v1.0 coarse scope -- SUPERSEDED by v1.1 Phases 5-10, see note in Phase Details)*
- [ ] **Phase 2: Hold Head** -- Add hold/sustain binary head, inverse-frequency weighting, hold walking postprocessing, JSON with duration
- [ ] **Phase 3: Chord Head** -- Add count/chord categorical head, oversample chord frames, lane assignment, complete JSON chart output
- [ ] **Phase 4: Special Class** -- Add special note type head (lower bar, label noise accepted), final end-to-end pipeline validation, all 4 ONNX heads exported

### v1.1 — Stage 1 Onset Head (current milestone)

- [x] **Phase 5: Eval Foundation** -- Shared normalized-envelope peak-pick + pinned baseline important-bucket F; gates everything downstream (eval AND JSON)
- [ ] **Phase 6: Model Build + Verification** -- CRNN backbone + onset head; shape assert `(2,400,1)` + alignment `abs(argmax−200)≤2` pass BEFORE any training
- [ ] **Phase 7: pos_weight Probes + Toy Overfit Gate** -- imbalanced-BCE probes (stability + degeneracy) + hand-written loop overfits 10 metronome toys, ~100% frame P/R ≤200 epochs
- [ ] **Phase 8: Full Training + Salience Eval** -- beat pinned baseline F on important salience bucket using identical eval code; time-based checkpointing + resume across 9h sessions
- [ ] **Phase 9: ONNX Export + Verify** -- runtime version-check branch (dynamo=True / TorchScript fallback), same-session CPU-EP verify `max(abs(diff))<1e-4` at 3+ lengths
- [ ] **Phase 10: Postprocess → JSON** -- sigmoid → shared peak-pick → overlap-merge → `[{time_s, ...}]` primary-onset JSON, dedup ratio ≈1.0

## Phase Details

### Phase 0: Foundation
**Goal**: Working data pipeline producing labeled training data on Kaggle Dataset, with synthetic dataset generator and baseline metrics established
**Depends on**: Nothing (first phase)
**Time estimate**: 5-7 days (CPU-only, no GPU quota spent)
**Requirements**: D1, D2, D3, D4, D5, T1, T2, E1, I1
**Success Criteria** (what must be TRUE):
  1. `test_mirrors.py` downloads a real .osz from an active mirror (Nerinyan first, fallback Beatconnect, fallback manual upload)
  2. Scraper produces 5+ parsed .osu files with correct timing/lane labels and mel-spectrogram .npy files on Kaggle ephemeral disk
  3. `toygen` generates synthetic samples (metronome clicks with configurable noise) as a standalone package with self-test suite
  4. Baseline (`librosa.onset.onset_detect`) precision/recall logged to CSV on toy set + 5 real songs -- this is the permanent yardstick
  5. All preprocessed data, toy set, and baseline CSV pushed to a single Kaggle Dataset under 20GB limit
**Plans**: 5 plans (Wave 1: 3, Wave 2: 1, Wave 3: 1)
**Plan list**:
- [x] 00-01-PLAN.md -- Config, mirror verification, requirements.txt
- [x] 00-02-PLAN.md -- .osu parser with unit tests
- [x] 00-03-PLAN.md -- Toygen synthetic dataset generator with self-tests
- [x] 00-04-PLAN.md -- Audio preprocessing and scraper
- [x] 00-05-PLAN.md -- Baseline evaluation and Kaggle Dataset persistence
**Critical path item**: Mirror verification (D1) gates everything else -- if all sources fail, manual .osz fallback to Kaggle upload widget must be ready
**Resource constraints**: 20GB Dataset cumulative; raw audio + .osz deleted immediately after preprocessing; Phase 0 consumes zero GPU quota (CPU only)
**Risk items**:
  - Source API rate-limiting or outage (mitigation: exponential backoff + manual .osz fallback)
  - 20GB Dataset limit hit during scraping (mitigation: delete raw audio, prune old checkpoints, keep only latest + best-val)
  - Green-line timing point misinterpretation in .osu parser (mitigation: parser unit test distinguishes uninherited/red from inherited/green)
  - Toy set too clean (mitigation: inject noise; test: baseline should NOT score 100% on toy)

### Phase 1: Onset Head
**Goal**: CRNN backbone trained on real data, detects onsets reliably, beats librosa baseline, exported to ONNX with numerical verification
**Depends on**: Phase 0
**Time estimate**: 10-14 days (approx 2 Kaggle GPU quota cycles -- 30h/week, Phase 1 needs ~50-60h)
**Requirements**: M1, M2, M3, O1, O2, O3, O4, E2, E3, I2, I3
**Success Criteria** (what must be TRUE):
  1. Shape assert passes: `out.shape == (2, 400, 1)` on dummy `(2,1,128,400)` input
  2. Alignment test passes: impulse at frame 200 detected within 2 frames (`abs(argmax_frame - 200) <= 2`)
  3. Model overfits 10-song toy set (frame-accuracy near 100%) within 200 epochs
  4. Onset F-measure beats librosa baseline on held-out real songs using identical eval code imported from baseline.py (not reimplemented)
  5. ONNX exports with same-session numerical verification: reload via InferenceSession, assert `max(abs(PyTorch - ONNX)) < 1e-4`
  6. Checkpoint pushed every ~30min training wall-clock time; session resumable via kagglehub download with optimizer state intact
  7. pos_weight derived via stability probe (200 steps, halve if NaN) + degeneracy probe (predicted rate within 0.3x-3x true rate), both values logged
**Plans**: TBD
**Critical path item**: pos_weight stability + degeneracy probes must pass before scaling to full dataset -- if either fails, training is blocked
**Resource constraints**: Kaggle 30h/week GPU (T4 x 2). Colab overflow only if exhausted. Bidirectional GRU chosen for faster epochs per hour.
**Risk items**:
  - NaN loss from aggressive pos_weight candidate (~32x) (mitigation: stability probe halves weight on NaN, retry until stable)
  - ONNX dynamo=True incompatibility with Kaggle's PyTorch version (mitigation: version-check first; >=2.14 dynamo=True, <2.9 dynamo=False/TorchScript)
  - Session timeout loses progress (mitigation: time-based checkpoint push every ~30min + session-end push)
  - Time-axis pooling by accident (mitigation: all MaxPool kernel_size=(2,1), time dimension stays 400 through all layers)
  - `model.eval()` forgotten before export (mitigation: call before export, never set `export_params=False`)

> **Superseded by v1.1 (Phase 1 → Phases 5-10):** The v1.0 roadmap's coarse "Phase 1: Onset Head" is replaced by v1.1's six detailed phases (5-10) which break the same Stage 1 work into hard-gated delivery boundaries: shared peak-pick + baseline pin first, model build/verify, toy gate, full training + salience eval, ONNX, JSON last. Requirements M1/M2/M3/O1-O4/E2/E3/I2/I3 are the v1.0-level statements of the v1.1 requirements MOD/TRN/EVL/EXP/PST below. Phases 2-4 (hold/chord/special) remain v2-future, still gated on Stage 1 shipping.

### Phase 2: Hold Head
**Goal**: Hold/sustain binary head added to backbone, produces note durations, passes backward-compat eval against Phase 1 metrics
**Depends on**: Phase 1 (must beat baseline and ONNX export verified before starting)
**Time estimate**: 5-7 days
**Requirements**: M4
**Success Criteria** (what must be TRUE):
  1. Model correctly predicts tap vs hold (binary classification) with hold recall > 30%
  2. Hold collapse (head always predicts "tap") resolved via inverse-frequency weighting
  3. Backward-compat eval: Phase 1 onset F-measure does NOT regress on Phase 2 model
  4. Postprocessing outputs `{time_s, duration_s}` for each detected note via hold walking
  5. 10-song toy set overfit gate passes (toy includes sustained tones) before scaling to full dataset
**Plans**: TBD
**Critical path item**: Hold collapse detection -- if head always predicts tap, block scaling until reweighted
**Resource constraints**: GPU same as Phase 1; epochs faster since backbone frozen during head training phase
**Risk items**:
  - Hold mode collapse (mitigation: degeneracy probe on hold recall; increase weight until recall > 30%)
  - Checkpoint format drift -- Stage 2 model has new keys incompatible with Stage 1 checkpoint (mitigation: checkpoint includes `stage` field; load backbone keys only when stage differs)
  - Wrong LR on joint fine-tune causes catastrophic forgetting (mitigation: freeze backbone -> train head at 1e-3 -> unfreeze -> joint at 1e-4/1e-5)

### Phase 3: Chord Head
**Goal**: Count/chord categorical head added, produces simultaneous note counts and lane assignments, complete JSON chart output
**Depends on**: Phase 2
**Time estimate**: 5-7 days
**Requirements**: (M4 pattern continued -- chord head addition)
**Success Criteria** (what must be TRUE):
  1. Model predicts {0,1,2,3,4+} simultaneous notes with chord recall above majority-class baseline
  2. Chord collapse (head always predicts most common class, usually 1) resolved via class weighting or oversampling
  3. Backward-compat eval: Phases 1-2 metrics do NOT regress on Phase 3 model
  4. Postprocessing outputs complete `{time_s, duration_s, lane, type}` JSON per song with lane clamp to `[0, cs-1]`
  5. Joint fine-tune follows the same freeze -> train -> unfreeze pattern established in Phase 2
**Plans**: TBD
**Critical path item**: Chord imbalance -- most frames have 0-1 notes, chords are rare; oversample chord frames or weight by inverse frequency before scaling
**Resource constraints**: Same as Phase 2; 30h/week quota may be tight if Phases 0-2 consumed more than expected
**Risk items**:
  - Chord collapse (mitigation: oversample chord frames, weight CE by inverse frequency)
  - Wrong LR on joint fine-tune (mitigation: 1e-3 head-only, 1e-4/1e-5 joint, same pattern as Phase 2)
  - Kaggle 30h/week quota exhausted (mitigation: colab overflow, or shrink dataset before assuming more compute)

### Phase 4: Special Class
**Goal**: Special note type classifier head added (v1 final stage, lower success bar due to label noise from mapper style)
**Depends on**: Phase 3
**Time estimate**: 5-7 days
**Requirements**: (M4 pattern continued -- special class head addition)
**Success Criteria** (what must be TRUE):
  1. Model predicts special note classes with accuracy above chance (exact target depends on defined class set)
  2. Backward-compat eval: Phases 1-3 metrics do NOT regress on Phase 4 model
  3. Complete end-to-end pipeline validated: song input -> mel-spectrogram -> model inference -> JSON chart
  4. All 4 ONNX heads exported and numerically verified in same session
  5. Final chart JSON validated: parseable, lane values clamped, durations non-negative, types match expected set
**Plans**: TBD
**Critical path item**: Label noise from mapper style (not pure acoustic truth) -- if accuracy is too low, accept and move to v2 rather than over-tune
**Resource constraints**: Remaining GPU quota may be tight; what's achievable within remaining 30h/week is the scope boundary
**Risk items**:
  - Insufficient GPU quota remaining (mitigation: defer special class to v2 if Kaggle time insufficient)
  - Kaggle Dataset approaching 20GB cumulative limit (mitigation: prune old checkpoints aggressively, keep only latest + best-val)

### v1.1 — Stage 1 Onset Head

**Milestone Goal:** CRNN backbone + onset head overfits toy set, beats librosa baseline on the audio-grounded (salience-bucketed) notes of real songs, exports verified ONNX, emits primary-onset JSON. All on Kaggle GPU, $0. Kill condition: model must beat baseline F on the important bucket using identical eval code on identical held-out songs.

### Phase 5: Eval Foundation — Baseline Pin + Shared Peak-Pick
**Goal**: The identical-code rule becomes real: shared normalized-envelope peak-pick extracted from baseline.py, baseline important-bucket F pinned, so every downstream comparison (salience gate, JSON) routes through one source
**Depends on**: Phase 0 (needs Phase 0 baseline CSV, eval-song set, real songs)
**Requirements**: EVL-01, EVL-02
**Success Criteria** (what must be TRUE):
  1. `baseline.py` exposes public `peak_pick_frames(envelope, **params)`; both baseline and model eval call it over min-max-normalized [0,1] envelopes with an [0,1] input assert
  2. Baseline re-run through the shared peak-pick emits the SAME onset times as the pinned Phase 0 baseline CSV (no regressed yardstick; `run_librosa_onset_detection` output unchanged)
  3. Baseline important-bucket F pinned from Phase 0 CSV on the fixed eval-song set (important + filler both computed); value committed to paper
  4. If pinned important-bucket F > 0.9, gate renegotiated BEFORE training (filler-bucket beat / matched-recall precision / different salience feature) and decision recorded
  5. Fixed eval-song set (`eval_song_ids.json`) + peak-pick params frozen; params calibrated on search set only, never eval set; shared peak-pick has scalar-statistic self-check
**Plans**: 2 plans (Wave 1: 1, Wave 2: 1)
**Plan list**:
- [x] 05-01-PLAN.md — Extract shared peak_pick_frames + normalize_envelope; freeze params in config.py; golden regression on 6 local songs (EVL-01)
- [x] 05-02-PLAN.md — Seed eval_song_ids.json; pin_baseline.py CLI; write data/eval_pins.json with bucket-F + yardstick-derivation decision (EVL-02)
**Critical path item**: Baseline important-bucket F pin -- if >0.9 the gate is unmeetable by construction (baseline peaks the same onset_strength envelope that defines "important"); must be decided here, before any training
**Resource constraints**: CPU-only (baseline re-run + pin). No GPU quota spent.
**Risk items**:
  - Gate circularity / unmeetable gate (mitigation: pin baseline F first, renegotiate if >0.9 -- P1)
  - "Identical peak-pick" lies -- librosa `onset_detect` min-max normalizes internally while raw logits don't (mitigation: single shared normalized peak-pick, [0,1] assert both sides -- P2)

### Phase 6: Model Build + Pre-Training Verification
**Goal**: CRNN backbone + onset head exists and passes literal shape + alignment checks on CPU BEFORE any GPU spend
**Depends on**: Phase 5 (baseline + shared peak-pick pinned before model work; no training without pinned yardstick)
**Requirements**: MOD-01, MOD-02
**Success Criteria** (what must be TRUE):
  1. Shape assert passes: `out.shape == (2, 400, 1)` on dummy `(2,1,128,400)` input
  2. Alignment test passes: impulse at frame 200 → `abs(argmax_frame - 200) <= 2` (literal bool, not visual inspection)
  3. All MaxPool `kernel_size=(2,1)` -- time dimension stays 400 through all layers
  4. Both checks pass with zero GPU training (CPU-only), results logged in notebook; failing either check blocks Phase 7
**Plans**: TBD
**Critical path item**: Alignment test -- shape assert catches pooling bugs but NOT late-alignment (pad bug); both checks gate all GPU spend
**Resource constraints**: CPU-only (dummy tensors). No GPU quota.
**Risk items**:
  - Time-axis pooling by accident (mitigation: explicit `(2,1)` pools + alignment companion test -- P7)
  - Late-alignment pad bug passes shape assert (mitigation: impulse-at-200 alignment test is the companion check)

### Phase 7: pos_weight Probes + Toy Overfit Gate
**Goal**: Training loop + imbalance handling proven on 10 metronome toys before real data; NaN/collapse caught cheaply
**Depends on**: Phase 6 (alignment bug would poison the toy gate's signal)
**Requirements**: TRN-01, TRN-02, TRN-03
**Success Criteria** (what must be TRUE):
  1. pos_weight = n_neg/n_pos (~20-50× for 2-5% onset rate) derived via stability probe on a large slice (halve on NaN) + degeneracy probe (predicted rate within 0.3×-3× true, BOTH tails); both values logged
  2. Hand-written loop (no Trainer): BCEWithLogitsLoss(pos_weight), AdamW(lr=1e-3, wd=1e-4), ReduceLROnPlateau(patience=3, factor=0.5); grad clip recovery guard active; no NaN run
  3. Toy overfit gate passes: 10 `generator_type="metronome_click"` songs only (NOT mixed toygen set), ≤200 epochs, ~100% frame P AND R (not raw accuracy)
  4. Predicted positive rate tracked per epoch as tripwire against all-ones / predict-nothing collapse
**Plans**: TBD
**Critical path item**: pos_weight probes -- aggressive ~32× weight + lr=1e-3 → NaN; too weak → predict-nothing collapse. Large-slice probe (full/half epoch, not 200 steps of one batch) is the guard
**Resource constraints**: GPU quota spent here (toy training, short runs). First GPU use of the milestone.
**Risk items**:
  - NaN from aggressive pos_weight (mitigation: large-slice stability probe halves on NaN, grad clip 1.0 -- P4)
  - Mode collapse both tails (mitigation: degeneracy probe checks 0.3×-3× BOTH ways, per-epoch predicted-rate tripwire -- P4)
  - Toy set mixed generators poison gate (mitigation: filter `generator_type="metronome_click"` only -- Gate Block #3)

### Phase 8: Full Training + Salience-Bucketed Eval
**Goal**: Model beats pinned baseline F on the important (acoustic-grounding) salience bucket of real songs, using identical eval code; training survives 9h session caps via resumable checkpoints
**Depends on**: Phase 7 (toy gate must pass) + Phase 5 (gate vs pinned CSV, not recompute)
**Requirements**: EVL-03, EVL-04, EXP-02
**Success Criteria** (what must be TRUE):
  1. Per-note salience via `librosa.onset.onset_strength` (identical kwargs as baseline) ranks chart notes; P/R reported per bucket (important top-30% + filler) at 20/30/50% thresholds
  2. Gate passes: model beats pinned baseline F on the important bucket using identical eval code (shared peak-pick + onset-merge) on the 5 fixed eval songs from `eval_song_ids.json`
  3. Time-based checkpointing works: full state `{model, optimizer, scheduler, epoch, global_step, val_metric, stage, torch_rng, random_rng, pos_weight}` saved per epoch; pushed ~every 30min + session-end
  4. Resume smoke test passes: epoch-3-then-4 loss matches fresh epoch 4 (scheduler + RNG restored in order); session resumable across 9h Kaggle cap
  5. Chunk-boundary label noise quantified (boundary-fraction); >5% → mitigation decided (random-crop offset / label-smear / boundary-excluded eval)
**Plans**: TBD
**Critical path item**: Salience gate vs pinned baseline -- the milestone's acceptance test. Kill condition: metric-looks-good-but-playtest-feels-wrong = failure
**Resource constraints**: Main GPU consumer (~30-50h). Checkpoint push dual-depth (local per-epoch + Dataset ~30min) protects 9h session cap; prune on push >16GB.
**Risk items**:
  - Resume drift -- ReduceLROnPlateau state + RNG not in optimizer.state_dict() (mitigation: save scheduler + RNG + stage + pos_weight, restore in order, smoke test -- P5)
  - Boundary label noise distrust (mitigation: quantify boundary-fraction >5% early, pick mitigation -- P10)
  - Gate circularity sneak-back (mitigation: gate vs PINNED CSV, never per-run recompute -- P1)
  - Overlap-inference double onsets (mitigation: cluster merge within 0.05s eval tolerance, dedup-ratio ≈1.0 -- P6)

### Phase 9: ONNX Export + Verify
**Goal**: Model exported to ONNX with numerical parity verified same-session, runtime version-checked so Kaggle's actual env decides the path
**Depends on**: Phase 8 (export meaningless until model passes its gate; verify is the cheap step, never skipped)
**Requirements**: EXP-01
**Success Criteria** (what must be TRUE):
  1. First Kaggle cell prints torch/onnxruntime/onnx versions and branches: torch ≥2.11 → try `dynamo=True` (`dynamic_shapes`), catch → `dynamo=False` TorchScript (`dynamic_axes`, opset 14); <2.11 → TorchScript only
  2. Same-session CPU-EP verify passes: `max(abs(torch - onnx)) < 1e-4` at 400 AND 250 AND 300 lengths + one real song (both sides on CPU EP)
  3. `model.eval()` called before export; `dynamo=True` path calls `.save()` on the ONNXProgram (not `f=` arg); never `export_params=False`
  4. Fixed-400 sliding-window (200-frame hop) fallback ready if dynamic export fails on real-song lengths
**Plans**: TBD
**Critical path item**: Frozen dynamic time axis -- same-length verify passes while real songs throw `Got: X Expected: 400`; multi-length verify is the guard
**Resource constraints**: CPU-EP ORT (GPU ORT silently drops to CPU EP on Kaggle). No floor-pinned blind versions -- runtime check branches.
**Risk items**:
  - Frozen dynamic time axis in BiGRU export (mitigation: verify at 3+ lengths + real song -- P3)
  - GPU/CPU parity false-failure (mitigation: both torch `.eval()` and ORT on CPU EP, tolerance 1e-4 -- P9)
  - Missing onnx/onnxscript on Kaggle (mitigation: floor-pinned deps `onnx>=1.16`, `onnxscript>=0.1`, `onnxruntime>=1.20` in requirements)

### Phase 10: Postprocess → JSON
**Goal**: Proven model emits primary-onset JSON charts via the shared peak-pick (identical-code rule holds), deduplicated across overlap windows
**Depends on**: Phase 9 (JSON from proven model; reuses Phase 5 shared peak-pick)
**Requirements**: PST-01
**Success Criteria** (what must be TRUE):
  1. sigmoid → shared normalized peak-pick → overlap-merge → JSON `[{time_s, duration_s, lane, type}]` per song; primary onsets only (no creative/secondary tier in v1)
  2. Overlap-merge dedups double onsets within eval tolerance 0.05s (same constant as eval); dedup-ratio ≈1.0 vs baseline single-pass control
  3. Peak-pick uses all 6 explicit params (no defaults): `pre_max=3, post_max=3, pre_avg=3, post_avg=5, delta=0.3, wait=3`
  4. JSON validates: parseable, lane clamped `[0, cs-1]`, times non-negative, types match expected set
**Plans**: TBD
**Critical path item**: Sliding-window normalization at inference -- per-window renormalization distorts edges; window-consistent (global song stats) or overlap-sufficient merge decided here
**Resource constraints**: CPU inference on Kaggle (offline precompute per song). No GPU needed.
**Risk items**:
  - Overlap-inference double onsets (mitigation: cluster merge within eval tolerance, dedup-ratio test vs baseline control -- P6)
  - Peak-pick reimplementation drift (mitigation: import shared peak-pick from Phase 5, never reimplement -- identical-code rule)

## Dependencies

| Phase | Depends On | Rationale |
|-------|------------|-----------|
| 0 | Nothing | Foundation -- all data must exist before any training |
| 1 | Phase 0 | Needs preprocessed data, toygen for overfit gate, baseline for comparison *(superseded by v1.1 Phases 5-10)* |
| 2 | Phase 1 | Needs working onset backbone; hold head adds to same time-aligned features |
| 3 | Phase 2 | Needs hold detection working; chord head uses same features + postprocessing pipeline |
| 4 | Phase 3 | Needs all prior heads working; special class is additive final head |
| 5 | Phase 0 | Shared peak-pick + pinned baseline CSV come from Phase 0 eval assets; 5 eval songs frozen |
| 6 | Phase 5 | Baseline + shared peak-pick pinned before model work; no training without pinned yardstick |
| 7 | Phase 6 | Alignment bug would poison the toy gate's signal -- literal checks gate all GPU spend |
| 8 | Phase 7, Phase 5 | Toy gate must pass before full training; salience gate compares vs pinned CSV via shared peak-pick |
| 9 | Phase 8 | Export meaningless until model passes its gate; verify is the cheap step, never skipped |
| 10 | Phase 9 | JSON from proven model; reuses Phase 5 shared peak-pick (identical-code rule) |

## Critical Path

v1.0: Phase 0 -> Phase 1 -> Phase 2 -> Phase 3 -> Phase 4

v1.1: Phase 0 -> Phase 5 -> Phase 6 -> Phase 7 -> Phase 8 -> Phase 9 -> Phase 10

No parallelization possible -- each phase sequentially gates the next. Riskiest single point in v1.1: Phase 5 baseline important-bucket F pin (if >0.9 the gate is unmeetable by construction -- renegotiation decided at plan time, not after training). Second riskiest: Phase 8 salience gate itself (novel protocol, no paper precedent) and Phase 7 pos_weight probes (NaN/collapse at full scale costs hours).

## Resource Constraints

| Resource | Limit | Strategy |
|----------|-------|----------|
| GPU compute | Kaggle 30h/week (T4 x 2), Colab overflow | Phase 0, 5, 6 CPU-only preserve quota for Phases 7-8. BiGRU chosen for faster epochs |
| Dataset storage | 20GB cumulative Kaggle Dataset | Raw audio + .osz deleted after preprocessing. Spectrograms ~4GB/100 songs. Prune on push (>16GB guard), keep latest + best-val |
| Budget | $0 | No paid APIs, no paid compute. Free tiers only. Manual .osz fallback if API sources fail |
| Session duration | 9h interactive Kaggle max | Time-based checkpoint push every ~30min (Phase 8). Session-end push always. Resumable via kagglehub |
| Packages | onnx>=1.16, onnxscript>=0.1, onnxruntime>=1.20 (CPU) | dynamo exporter deps torch does not install by default; runtime version-check branches, never blind-pins |

## Coverage

| Requirement | Phase | Status |
|-------------|-------|--------|
| D1 | Phase 0 | Complete |
| D2 | Phase 0 | Complete (00-04) |
| D3 | Phase 0 | Complete (00-04) |
| D4 | Phase 0 | Complete (00-02) |
| D5 | Phase 0 | Complete (00-05) |
| T1 | Phase 0 | Complete (00-03) |
| T2 | Phase 0 | Complete (00-03) |
| E1 | Phase 0 | Complete (00-05) |
| I1 | Phase 0 | Complete |
| M1 | Phase 1 | Pending |
| M2 | Phase 1 | Pending |
| M3 | Phase 1 | Pending |
| O1 | Phase 1 | Pending |
| O2 | Phase 1 | Pending |
| O3 | Phase 1 | Pending |
| O4 | Phase 1 | Pending |
| E2 | Phase 1 | Pending |
| E3 | Phase 1 | Pending |
| I2 | Phase 1 | Pending |
| I3 | Phase 1 | Pending |
| M4 | Phase 2 | Pending |
| MOD-01 | Phase 6 | Pending |
| MOD-02 | Phase 6 | Pending |
| TRN-01 | Phase 7 | Pending |
| TRN-02 | Phase 7 | Pending |
| TRN-03 | Phase 7 | Pending |
| EVL-01 | Phase 5 | Pending |
| EVL-02 | Phase 5 | Pending |
| EVL-03 | Phase 8 | Pending |
| EVL-04 | Phase 8 | Pending |
| EXP-01 | Phase 9 | Pending |
| EXP-02 | Phase 8 | Pending |
| PST-01 | Phase 10 | Pending |

**Total requirements mapped: 33 (21 v1.0 + 12 v1.1) — all mapped**

Note on coverage: M1-M4/O1-O4/E2-E3/I2-I3 are the v1.0-level statements of the work; v1.1 refines Stage 1 (onset head) into MOD/TRN/EVL/EXP/PST requirements, which supersede the M1-M3/O1-O4/E2-E3/I2-I3 rows for the Stage 1 milestone. Phases 5-10 deliver the v1.1 requirements 1:1. Phases 2-4 (M4 pattern continued) remain v2-future, gated on Stage 1 shipping.

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Foundation | 5/5 | Complete | 00-01 through 00-05 |
| 1. Onset Head | 0/0 | Superseded (v1.1 Phases 5-10) | - |
| 2. Hold Head | 0/0 | Not started | - |
| 3. Chord Head | 0/0 | Not started | - |
| 4. Special Class | 0/0 | Not started | - |
| 5. Eval Foundation | 2/2 | Complete | 05-01 through 05-02 |
| 6. Model Build + Verification | 0/0 | Not started | - |
| 7. pos_weight Probes + Toy Overfit | 0/0 | Not started | - |
| 8. Full Training + Salience Eval | 0/0 | Not started | - |
| 9. ONNX Export + Verify | 0/0 | Not started | - |
| 10. Postprocess → JSON | 0/0 | Not started | - |
