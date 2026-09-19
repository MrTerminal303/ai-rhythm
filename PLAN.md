# PLAN.md — AI Rhythm Game Note-Chart Generator

## Goal
Train own neural net (from scratch, learning-focused) to convert any song into a rhythm-game note chart: onset time, hold duration, simultaneous count (chords), optional special class. Game engine in C++. Zero cost. No local GPU/storage — Kaggle + Colab only.

## Constraints (locked)
- $0 budget, no paid compute.
- No local GPU. Weak laptop = code editing only.
- No local storage for data/models — cloud (Kaggle Dataset) is source of truth.
- Compute: Kaggle (primary, 30h/week GPU, 20GB Dataset) + Colab (overflow only).
- Engine: C++, inference via ONNX Runtime, or offline-precomputed JSON charts (preferred for weak hardware).
- Data source: Nerinyan (nerinyan.moe) primary, Beatconnect.io fallback. Chimu/Bloodcat/Hexide are dead — do not use.

## Architecture decision
One CRNN backbone (conv layers over mel-spectrogram → BiGRU) with 4 output heads, added incrementally:
1. Onset (binary, sigmoid, BCE)
2. Hold/sustain (binary, sigmoid, BCE)
3. Count/chord (categorical, softmax, cross-entropy)
4. Special class (categorical, cross-entropy, optional/last)

Rule: never add a head until the previous one overfits a 10-song toy subset cleanly.

---

## PROGRESS STATUS (update as stages complete)

**Stage 0: in progress — hold/chord label extraction (0.6) underway.**
- [x] `config.py` — full training config (CRNN shapes, gating thresholds, phase stop criteria)
- [x] `osu_parser.py` — parses .osu, extracts mania hit objects
- [x] `toygen.py` + `test_toygen.py` — synthetic dataset generator
- [x] `audio_preproc.py` — mel-spectrogram pipeline, chunking, normalization
- [x] `scraper.py` + `test_scraper.py` — .osz downloader, retry/backoff, 3 mirror sources
- [x] `baseline.py` + `test_baseline.py` — librosa onset baseline, F-score yardstick
- [x] `kaggle_push.py` + `test_kaggle_push.py` — Dataset upload
- [x] `verify_song.py` — spectrogram/onset viewer GUI
- [x] `osu_parser.py` restored + **now extracts `end_time`** (hold/slider duration, taps get `end_time = time`), lane, type bitmask, key-mode (cs from OverallDifficulty). Note: file had been accidentally dropped in branch cleanup — recovered from worktree copy, 25 tests pass. `[TimingPoints]`/BPM intentionally NOT parsed (D-08).
- [ ] `audio_preproc.py`: still builds only `onset[t]`. `active[t]` + `count[t]` label arrays still to add (part of 0.6 below).
- [ ] Stage 0 exit criteria not yet met — see updated checklist at end of Stage 0.

---

## .osu FILE FORMAT REFERENCE (verified against official osu! wiki)

Needed so `osu_parser.py` extracts everything, not just onset.

**Hit object line:** `x,y,time,type,hitSound,objectParams,hitSample`

| Field | Meaning | Label use |
|---|---|---|
| `x` | column = `floor(x * columnCount / 512)`, clamped `[0, columnCount-1]` | lane |
| `time` | ms, onset time | **onset label** |
| `type` | bit 3 (value 8) set = hold note (mania LN); 128 = new combo, not relevant for mania | hold flag |
| objectParams (holds only) | `endTime:hitSample` — last field before hitSample chain | **hold-duration label** |
| `[Difficulty] CircleSize` | column count for mania (4K/7K etc) | filter/condition by key-mode |
| `[General] Mode` | must be `3` for mania | filter non-mania maps out |
| `Version` (Metadata) | difficulty name string | Stage 4 difficulty conditioning |
| `[TimingPoints]` | BPM/beat grid | optional: quantize onsets to grid later |

**Simultaneous notes (chords):** no explicit field — group hit objects whose `time` falls within the same ~10ms frame. Count = chord size.

**Parser fix required (`osu_parser.py`):** currently extracts `{time, lane, type}` only. Must also extract `end_time` (= `time` for taps, real value for holds — only present when type bit 7 is set) so downstream labeling has it.

**Label builder fix required (`audio_preproc.py`):** currently builds `onset[t]` only. Must also build:
- `active[t]` — binary, 1 for every frame between a hold's `time` and `end_time`.
- `count[t]` — int, number of hit objects whose `time` falls in frame t (chord size).

Cheap to add now even though Stage 1 only trains on `onset` — avoids re-scraping/re-parsing when Stage 2/3 start.

---

## STAGE 0 — Foundation
**Where:** Kaggle notebook, CPU-only session (no GPU quota spent).

### 0.1 Verify data source — DONE
`scraper.py` supports 3 mirror sources (Nerinyan primary, Beatconnect fallback; Chimu/Bloodcat/Hexide confirmed dead, not used) with retry/backoff, tested in `test_scraper.py`.

### 0.2 Scraper — DONE
`scraper.py`: downloads .osz, extracts in Kaggle ephemeral disk, deletes raw audio+osz after conversion, pushes to Kaggle Dataset via `kaggle_push.py`.

### 0.3 Toy synthetic dataset — DONE
`toygen.py`: metronome clicks, sustained tones, chords, configurable noise/complexity. `test_toygen.py` covers it (301 lines).

### 0.4 Baseline — DONE
`baseline.py`: librosa spectral-flux onset detection, F-score yardstick, tested.

### 0.5 Persist — DONE
`kaggle_push.py` uploads processed datasets to Kaggle Dataset.

### 0.6 Fix hold + chord label extraction — in progress, blocks Stage 1 exit
1. `osu_parser.py`: ~~parse `end_time` from hold notes' objectParams (see table above). Taps get `end_time = time`.~~ **DONE** — restored + verified, 25 tests pass.
2. `audio_preproc.py`: build `active[t]` and `count[t]` label arrays alongside existing `onset[t]`, per chunk (400 frames).
3. `verify_song.py`: render hold notes as a colored horizontal span from `time` to `end_time` on the note's lane row; render chords as stacked/color-coded markers when `count[t] > 1`.
4. Re-run `verify_song.py` on a handful of real songs, visually confirm holds and chords now show correctly, before trusting the dataset.

Griffin-Lim audio reconstruction quality (noted as "not complex enough") is a separate, non-blocking issue — the model trains on the spectrogram, not reconstructed audio. If reconstruction is only for manual verification, either raise `n_iter` (60–100+) or skip reconstruction entirely and play the original audio file for the small subset being manually checked (temporary, deleted after inspection, doesn't violate zero-local-storage rule in practice).

**Stage 0 exit criteria (updated):** scraper + toy set + baseline all done (✅ above) AND hold/chord labels correctly extracted and visually verified in `verify_song.py`.

---

## STAGE 1 — Onset head
**Where:** Kaggle GPU session (30h/week).

### Input spec
- Mel-spectrogram: 22050Hz, n_fft=2048, hop=220 (~10ms), n_mels=128.
- Fixed-length chunks for training: 400 frames (~4s), random crop per sample (avoids variable-length batching).
- Input tensor: `(batch, 1, 128, 400)`. Label: `(batch, 400)` binary onset vector.

### Model (exact layers)
```
Conv2d(1,16,k=3,pad=1)→BN→ReLU→MaxPool(kernel=(2,1))   # freq 128→64, time unchanged
Conv2d(16,32,k=3,pad=1)→BN→ReLU→MaxPool(kernel=(2,1))  # freq 64→32
Conv2d(32,64,k=3,pad=1)→BN→ReLU→MaxPool(kernel=(2,1))  # freq 32→16
reshape (batch,64,16,400) → (batch,400,1024)
Linear(1024,128)
BiGRU(128, hidden=128, layers=1, bidirectional=True)   # → (batch,400,256)
Linear(256,1)   # logits, no sigmoid (BCEWithLogitsLoss handles it)
```
~400-600k params. All pooling confined to freq axis — time dimension must stay 400 throughout.

### Verification — run BEFORE any real training, both must pass
1. **Shape assert:** `out.shape == (2, 400, 1)` on dummy `(2,1,128,400)` input. Standard software-engineering practice (unreported in onset papers but universally used in code).
2. **Synthetic impulse-gradient alignment test (novel diagnostic — not in published onset detection lit):** inspired by gradient-based saliency (Simonyan et al. 2014) and Grad-CAM (Selvaraju et al. 2017), but the specific temporal-alignment application is not a standard protocol. Build synthetic input with a single sharp energy spike at frame 200 (near-zero elsewhere). Forward pass through untrained model, backprop a dummy loss computed only on the frame-200 output. Check `argmax(gradient_magnitude_over_time)` in the first conv layer. **Pass condition: `abs(argmax_frame - 200) <= 2`** (literal boolean check, not visual inspection). This catches phase-shift/off-by-one bugs the shape check misses.
3. **Translation test (optional, stronger):** place impulses at multiple frames (e.g. 50, 200, 350) and verify the offset `Δ(t₀) = argmax_y - t₀` is constant (≤2) across all positions. A changing Δ indicates boundary/stride/padding effects. This also catches false positives from the single-impulse test (symmetric receptive field, bypass paths, batch norm effects on synthetic inputs).

If either fails: fix pooling/padding before writing another line of training code.

### Loss / imbalance handling — pos_weight derived empirically
- Compute `pos_frac` = positive frame ratio on the real training set (not toy set).
- Candidate weight = `(1 - pos_frac) / pos_frac`.
- **Stability probe (novel diagnostic — not in published onset detection lit):** run 200 steps on a small batch at candidate weight. If loss NaNs/explodes, halve weight, retry, repeat until stable — this derived value is the actual weight used (not a guessed constant). Formalize as `Stability(w) = 1 - #{nonfinite runs}/K` across K short trials with different seeds. Record max gradient norm, final loss, validation F1, variance across seeds.
- **Degeneracy probe (novel diagnostic — not in published onset detection lit):** on a small held-out batch, check predicted positive rate is within 0.3x–3x of true positive rate. If predicted rate collapses near 0, weight is too conservative even though "stable" — increase weight and retest. Formalize as `D_rate = |log(π̂+ε / π+ε)|`. Also report fraction of clips with zero predictions and average predicted onsets per minute.
- Log both the raw candidate and the final value used.
- `BCEWithLogitsLoss(pos_weight=final_value)`. AdamW lr=1e-3, weight_decay=1e-4. ReduceLROnPlateau(patience=3, factor=0.5, monitor val loss).
- **Literature context:** Hawthorne et al. (2018) use a joint onset/frame CE objective with temporal frame weighting around note onsets — NOT explicit pos_weight from training stats. Kwon et al. (2024) found BCE with positive weighting outperforms Dice/focal in ablation, but their final model uses focal loss (α=1.0, γ=2.0) — the BCE result is model/data-specific, not a universal rule. OWBCE (2024) shows temporal boundary weighting improves event-F1 by 6.43% over standard BCE — potential upgrade for Phase 8 if model underperforms. No single paper establishes a universal ranking between pos-weighted BCE, focal loss, and asymmetric focal loss for musical onset detection.

### Training loop
Write forward/backward/optimizer step by hand (PyTorch), not a `Trainer` abstraction — this is where the actual learning happens.

### Overfit gate
- 10 toy songs only, ≤200 epochs, no early stop. Target ~100% train frame-accuracy.
- If stuck on a plateau, debug in this order: (1) alignment test result, (2) pos_weight stability/degeneracy logs, (3) architecture/capacity.

### Eval — reuse Stage 0's exact code, do not reimplement
- Import/call the same peak-picking + onset-merge function used in `baseline.py` (same tolerance constant, same merge-distance logic) — prevents silent drift between baseline and model comparisons. Peak-pick algorithm from Böck et al. (2012) via librosa; CRNN architecture follows Schlüter & Böck (2014) and Hawthorne et al. (2018).
- Run on the same held-out real songs Stage 0 was evaluated on.
- **Kill condition:** must beat Stage 0 baseline F_important using identical eval code on identical held-out songs. If not: check alignment test, then pos_weight logs, then data quantity — in that order. Do not proceed to Stage 2 until beaten.

### Checkpointing — time-based interval, not blind epoch count
- Save `{model_state, optimizer_state, epoch, val_metric}` to `/kaggle/working/checkpoint.pt` every epoch (cheap, local disk).
- Measure wall-clock time per epoch using epochs 2–4 (discard epoch 1 — warm-up/compilation overhead makes it unrepresentative), take the median.
- Push to Kaggle Dataset (`kaggle datasets version`) every ~30 min of wall-clock training time based on that measurement. Recompute the interval once more around epoch 10 in case data-loading speed drifts.
- Always push once more at clean session end.
- On resume: pull latest Dataset version, load full checkpoint dict including optimizer state.

### Export — verify environment, don't hardcode from memory
- Check `onnxruntime.__version__` and supported opset range in the actual Kaggle/laptop environment before picking `opset_version` (do not assume a fixed number).
- Export with dynamic time axis:
```python
dummy = torch.randn(1, 1, 128, 400)
torch.onnx.export(model, dummy, "onset_stage1.onnx",
    input_names=["spec"], output_names=["onset_logits"],
    dynamic_axes={"spec": {3: "time"}, "onset_logits": {1: "time"}},
    opset_version=<verified_value>)
```
- **Immediately after export, same session:** reload via `onnxruntime.InferenceSession`, run the same dummy input through both PyTorch and ONNX, assert `max(abs(diff)) < 1e-4`.
- If GRU + dynamic_axes fails to export/load cleanly: fallback to fixed 400-frame export, run real songs through sliding 400-frame windows with overlap at inference time instead of one dynamic-length pass.

### Stage 1 exit checklist
- [ ] Shape assert passes
- [ ] Synthetic impulse-gradient alignment test passes with `abs(argmax_frame - 200) <= 2` (novel diagnostic; also run translation test across 3+ impulse positions if time permits)
- [ ] Overfits 10-song toy set
- [ ] pos_weight derived via stability + degeneracy probes, both values logged (novel diagnostics)
- [ ] Eval uses Stage 0's exact peak-picking code, not a reimplementation
- [ ] Beats Stage 0 baseline on real val songs (same songs, same tolerance, same merge logic)
- [ ] Checkpoint pushed on time-based interval + at session end, resumable with optimizer state
- [ ] onnxruntime version/opset verified in-environment before export
- [ ] ONNX output numerically verified against PyTorch in the same session (diff < 1e-4)

---

## STAGE 2 — Hold head
**Where:** Kaggle GPU (or Colab overflow if Kaggle hours exhausted).

- Before training: compute hold/tap ratio from labels (CPU, laptop or Kaggle CPU session, pandas). Expect strong imbalance (most notes are taps).
- Add `active` binary head to same backbone, weighted BCE loss (weight by inverse class frequency).
- Overfit gate: 10 toy songs (include sustained tones) first.
- **Kill condition:** if head always predicts "tap" (mode collapse) → reweight loss, don't proceed until fixed.
- Scale to full dataset, checkpoint/export as Stage 1.

---

## STAGE 3 — Count/chord head
**Where:** Kaggle GPU (or Colab overflow).

- Before training: compute chord-frequency histogram (expect most frames = 0 or 1 note, chords rare).
- Add `count` categorical head ({0,1,2,3,4+}), weighted cross-entropy or oversampling of chord frames.
- Overfit gate: 10 toy songs with chords included.
- **Kill condition:** if model always predicts most common class (1 note) → fix class weighting/oversampling before scaling.
- Scale, checkpoint, export.

---

## STAGE 4 — Special note class (optional, only if time remains)
**Where:** Kaggle GPU (or Colab overflow).

- Add `class` categorical head (e.g. kick/vocal/crash — define concrete label set before coding).
- Accept more label noise here (ground truth is mapper-style-driven, not pure acoustic truth) — lower success bar than Stages 1–3.
- Overfit gate + kill condition same pattern as above.

---

## STAGE 5 — Primary/secondary note tiering (optional, after Stage 1-3 solid)
**Where:** Kaggle GPU (or Colab overflow).

**Concept:** two-tier note output instead of one flat chart.
- **Primary notes** — strong acoustic evidence (high onset-head confidence). Always included in the generated chart, non-optional. This is Stage 1-3's output as-is, just relabeled "primary."
- **Secondary notes** — mapper-convention-style notes with weak/no acoustic evidence (fillers, trills, stream extensions placed on beat subdivisions rather than audible events). Generated by a beat-grid-conditioned model, offered as an **optional toggle layer** the player can include or exclude. Editing individual notes after generation is a later phase, out of scope here.

### 5.1 Beat-grid feature
- From `[TimingPoints]` (BPM, first uninherited timing point's `time`+`beatLength`), compute a beat-phase feature per frame: which beat subdivision (1/1, 1/2, 1/4, 1/8, etc) each frame falls on.
- Encode as an extra input channel (or small side-input concatenated before the BiGRU) alongside the mel-spectrogram — `(batch, 400, k)` where k = number of subdivision categories, one-hot or embedded.

### 5.2 Secondary-note model
- Reuse the same CRNN backbone (frozen or fine-tuned — try frozen first, cheaper, only trains new head+beat-input layers).
- New output head: predicts probability a mapper would place a note here **given** beat-phase, independent of onset-head confidence. Trained on real map data only (ranked/loved filtered set) — the label is "mapper placed a note here" regardless of whether onset-head also fired. Toy set doesn't help here (it has no mapper-convention signal), so overfit-gate uses a small real-map subset instead of toy songs for this stage specifically.
- Loss: BCE, same imbalance-handling pattern as Stage 1 (pos_weight derived empirically, capped via stability+degeneracy probes).

### 5.3 Tiering logic (postprocessing)
- Run primary onset head (Stage 1) → note candidates with confidence scores.
- Run secondary head (5.2) → additional note candidates conditioned on beat-grid.
- Merge, dedupe (a frame flagged by both stays primary — primary wins on overlap).
- Tag every note `tier: "primary" | "secondary"` in output.

### 5.4 Kill condition
- Secondary head must show higher precision than "place a note at every beat subdivision" (trivial baseline) on held-out real maps — otherwise it's not adding signal beyond the beat grid alone, not worth the added complexity, fall back to Option A only (primary notes) for that release.

### 5.5 Human validation
- Playtest with secondary layer ON vs OFF. Secondary notes should feel like plausible optional stream/filler additions, not random noise. If they feel arbitrary, lower secondary-head confidence threshold or revisit beat-grid feature encoding before shipping this tier.

**Stage 5 is fully optional** — ship with primary-only (Stages 1-3) first; add this only once that's solid and there's appetite for the extra complexity.

---

## Output chart schema (updated)
```json
[
  {"time": 12345, "duration": 0, "lane": 2, "count": 1, "tier": "primary"},
  {"time": 12600, "duration": 480, "lane": 1, "count": 1, "tier": "primary"},
  {"time": 12750, "duration": 0, "lane": 3, "count": 2, "tier": "secondary"}
]
```
- `tier` field added by Stage 5 postprocessing (5.3). Absent/always `"primary"` if Stage 5 not implemented yet.
- Engine-side: primary notes always spawned; secondary notes spawned only if player has the optional layer toggled on (engine UI toggle — later phase, not covered in this ML plan).
- Peak-pick onset head output → discrete note times.
- For each onset, walk forward through hold/active head until it drops → hold duration.
- Split by count head → assign lanes/positions (heuristic first; can become its own lightweight model later).
- Output: JSON `[{time, duration, lane, type}, ...]` per song.

## Human validation (every stage, not just at the end)
- After each stage: overlay predicted notes on spectrogram, eyeball sanity.
- Playtest the resulting chart in-engine (or a minimal stub player) — precision/recall numbers can look good while the chart still feels unplayable. Trust ears/hands over metrics.

---

## C++ Engine Integration
- Recommended: **offline precompute**. Run inference once per song in the Kaggle/Colab notebook → output JSON chart → download JSON (KB-sized) to laptop → game loads JSON directly. Avoids real-time inference constraint on weak hardware entirely.
- Optional later: real-time inference via ONNX Runtime C++ (static lib, free) if offline precompute proves insufficient — load `.onnx`, run mel-spectrogram extraction in C++ (kissfft or pffft, lightweight, no GPU) → feed model → spawn notes live.
- Game styles (4, osu-inspired): build after single-style pipeline is proven end-to-end. Condition placement logic or model on style/difficulty label — do not attempt all 4 upfront.

---

## Global kill conditions / fallbacks
- Kaggle Dataset nearing 20GB → drop sample rate 22050→16000Hz, or shorten clips to 30s segments.
- Kaggle 30h/week insufficient → shrink model further or reduce dataset before assuming more compute is available (there isn't).
- Data source rate-limits/dies mid-scrape → fallback to manual curated batch, uploaded directly to Kaggle Dataset.
- Any stage: if val metric looks good but human playtest feels wrong → treat as failure, metric doesn't capture "fun," add/adjust human-in-loop check before proceeding.

---

## Immediate next action
`osu_parser.py` restored and extracting `end_time`/lane/key-mode (verified). Next: `audio_preproc.py` build `active[t]` + `count[t]` label arrays, then update `verify_song.py` to render holds/chords, re-verify visually on real songs before starting Stage 1 training (stage 0.6 steps 2-4).