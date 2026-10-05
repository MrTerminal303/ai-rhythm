# PLAN.md — AI Rhythm Game Note-Chart Generator

## Goal
Train own neural net (from scratch, learning-focused) to convert any song into a rhythm-game note chart: onset time, hold duration, simultaneous count (chords), optional special class. Game is a web/TypeScript app (multiplayer, Vercel); inference runs in the browser (ONNX Runtime Web) for uploaded songs, offline on Kaggle for bundled songs. Zero cost. No local GPU/storage — Kaggle + Colab only.

## Constraints (locked)
- $0 budget, no paid compute.
- No local GPU. Weak laptop = code editing only.
- No local storage for data/models — cloud (Kaggle Dataset) is source of truth.
- Compute: Kaggle (primary, 30h/week GPU, 20GB Dataset) + Colab (overflow only).
- Engine: web/TypeScript. Inference: browser ONNX Runtime Web (WASM, in a Web Worker) for uploaded songs; offline precompute on Kaggle for bundled songs. Avoid WebGPU and multithreaded WASM (cross-origin isolation headers) until verified.
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

**Stage 0: infrastructure committed; hold/chord label fix (0.6) treated as done per user. Phase 6 (model build + gates) plan reviewed, execution not confirmed here. No real data scraped yet.**
- [x] `config.py` — full training config (CRNN shapes, gating thresholds, phase stop criteria)
- [x] `osu_parser.py` — parses .osu, extracts mania hit objects
- [x] `toygen.py` + `test_toygen.py` — synthetic dataset generator
- [x] `audio_preproc.py` — mel-spectrogram pipeline, chunking, normalization
- [x] `scraper.py` + `test_scraper.py` — .osz downloader, retry/backoff, 3 mirror sources
- [x] `baseline.py` + `test_baseline.py` — librosa onset baseline, F-score yardstick
- [x] `kaggle_push.py` + `test_kaggle_push.py` — Dataset upload
- [x] `verify_song.py` — spectrogram/onset viewer GUI
- [x] (marked done by user; re-verify on real data) **BUG FOUND via verify_song.py:** `osu_parser.py`/`audio_preproc.py` only extract onset time. Hold `endTime` and simultaneous-note grouping are not parsed/labeled, so holds and chords can't be visualized or trained. Fix below (0.6) before Stage 1 starts.
- [ ] Stage 0 exit criteria still open: real data scraped; holds/chords visually verified on real songs; per-difficulty 4K filter in place; every frame↔ms conversion routed through `config.FPS` helpers (see Stage 1 input spec).

---

## .osu FILE FORMAT REFERENCE (verified against official osu! wiki)

Needed so `osu_parser.py` extracts everything, not just onset.

**Hit object line:** `x,y,time,type,hitSound,objectParams,hitSample`

| Field | Meaning | Label use |
|---|---|---|
| `x` | column = `floor(x * columnCount / 512)`, clamped `[0, columnCount-1]` | lane |
| `time` | ms, onset time | **onset label** |
| `type` | bit 7 (value 128) set = hold note | hold flag |
| objectParams (holds only) | `endTime:hitSample` — last field before hitSample chain | **hold-duration label** |
| `[Difficulty] CircleSize` | column count for mania (4K/7K etc) | filter/condition by key-mode |
| `[General] Mode` | must be `3` for mania | filter non-mania maps out |
| `Version` (Metadata) | difficulty name string | Stage 4 difficulty conditioning |
| `[TimingPoints]` | BPM/beat grid | optional: quantize onsets to grid later |

**Simultaneous notes (chords):** no explicit field — group hit objects whose `time` falls within the same ~10ms frame. Count = chord size.

**Key-mode filter (game is 4K-only):** filter per `.osu` difficulty file, never per `.osz` (one set mixes 4K/7K difficulties): keep only `[General] Mode == 3` AND `[Difficulty] CircleSize == 4`. Count head classes for 4K are {0..4}.

**Difficulty band:** the game targets about 7 notes/sec, so train on a mid-difficulty band (or thin output by onset confidence) instead of all tiers. Training on expert charts teaches expert density.

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

### 0.6 Fix hold + chord label extraction — TODO, blocks Stage 1 exit
1. `osu_parser.py`: parse `end_time` from hold notes' objectParams (see table above). Taps get `end_time = time`.
2. `audio_preproc.py`: build `active[t]` and `count[t]` label arrays alongside existing `onset[t]`, per chunk (400 frames).
3. `verify_song.py`: render hold notes as a colored horizontal span from `time` to `end_time` on the note's lane row; render chords as stacked/color-coded markers when `count[t] > 1`.
4. Re-run `verify_song.py` on a handful of real songs, visually confirm holds and chords now show correctly, before trusting the dataset.
5. **Verification-mode audio (debug tool, not pipeline change):** for a small manual QA subset only (~5-10 songs), keep the original decoded audio temporarily instead of deleting it, and play it directly alongside the spectrogram plot in `verify_song.py` — synced to the same time axis as the onset/hold/chord markers. This replaces Griffin-Lim reconstruction for verification, since Griffin-Lim is inherently lossy (phase is discarded when computing the mel-spectrogram) and its playback quality says nothing about whether chord/hold info is actually present in the spectrogram — that's visible directly in the spectrogram image itself (simultaneous frequency peaks = chord, sustained energy across frames = hold), not through reconstructed audio.
   - Scope: this subset's audio is deleted after manual QA is done, same as the rest of the pipeline. Does not change the "delete raw audio immediately after processing" rule in `scraper.py` for the full dataset — verification-mode is an opt-in flag/separate code path in `verify_song.py`, not a default.
   - Purpose: sanity-check that spectrogram content and label markers agree with what's audibly happening at that timestamp (e.g. "yes, there's a real chord here" vs "the mel-spec looks washed out here, check n_mels/hop resolution").

Griffin-Lim audio reconstruction quality (noted as "not complex enough") is a separate, non-blocking issue — the model trains on the spectrogram, not reconstructed audio. Keep Griffin-Lim as a fallback playback option only; original-audio verification mode (0.6.5) is the primary QA method going forward.

**Stage 0 exit criteria (updated):** scraper + toy set + baseline all done (✅ above) AND hold/chord labels correctly extracted and visually verified in `verify_song.py`, cross-checked against original audio on a QA subset.

---

## STAGE 1 — Onset head
**Where:** Kaggle GPU session (30h/week).

### Input spec
- Mel-spectrogram: 22050Hz, n_fft=2048, hop=220 (~10ms), n_mels=128.
- Fixed-length chunks for training: 400 frames (~4s), random crop per sample (avoids variable-length batching).
- Input tensor: `(batch, 1, 128, 400)`. Label: `(batch, 400)` binary onset vector.
- **Frame grid:** hop 220 at 22050 Hz = 9.977 ms/frame = 100.227 fps. Every frame↔ms conversion uses `config.FPS` / `ms_to_frame` / `frame_to_ms` in Python and `fps` from `preproc.json` in TypeScript. Never assume 10 ms.
- **Preprocessing parity (browser must reproduce training exactly):** record in `preproc.json` the resample method, DC removal, fmin/fmax, mel scale and norm, power, log scaling and floor, per-chunk normalization (mean/std, eps), center and pad mode. As far as I know torchaudio's `MelSpectrogram` defaults to HTK/no-norm and librosa to Slaney/Slaney, so read the real arguments in `audio_preproc.py` and match those, not librosa's. Per-chunk normalization means inference must use identical chunk boundaries and overlap.
- **Chunk stitching (inference):** 400-frame windows with overlap, discarding a margin at each window edge because the BiGRU starts from zero state (start at ~50 frames, tune). Test in Python that stitched output matches a single full-song pass before porting to TypeScript.
- **Decoder offset:** browser `decodeAudioData` and `librosa.load` can differ by tens of ms on MP3s. Measure the median gap between baseline onsets and nearest labels on 5-10 real songs and check for a constant nonzero offset.

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
1. **Shape assert:** `out.shape == (2, 400, 1)` on dummy `(2,1,128,400)` input.
2. **Alignment test:** build synthetic input with a single sharp energy spike at frame 200 (near-zero elsewhere). Forward pass through untrained model, backprop a dummy loss computed only on the frame-200 output. Check `argmax(gradient_magnitude_over_time)` in the first conv layer. **Pass condition: `abs(argmax_frame - 200) <= 2`** (literal boolean check, not visual inspection). This catches phase-shift/off-by-one bugs the shape check misses.

If either fails: fix pooling/padding before writing another line of training code.

### Loss / imbalance handling — pos_weight derived empirically
- Compute `pos_frac` = positive frame ratio on the real training set (not toy set).
- Candidate weight = `(1 - pos_frac) / pos_frac`.
- **Stability probe:** run 200 steps on a small batch at candidate weight. If loss NaNs/explodes, halve weight, retry, repeat until stable — this derived value is the actual weight used (not a guessed constant).
- **Degeneracy probe (in addition to stability):** on a small held-out batch, check predicted positive rate is within 0.3x–3x of true positive rate. If predicted rate collapses near 0, weight is too conservative even though "stable" — increase weight and retest.
- Log both the raw candidate and the final value used.
- `BCEWithLogitsLoss(pos_weight=final_value)`. AdamW lr=1e-3, weight_decay=1e-4. ReduceLROnPlateau(patience=3, factor=0.5, monitor val loss).

### Training loop
Write forward/backward/optimizer step by hand (PyTorch), not a `Trainer` abstraction — this is where the actual learning happens.

### Overfit gate
- 10 toy songs only, ≤200 epochs, no early stop. Target ~100% train frame-accuracy.
- If stuck on a plateau, debug in this order: (1) alignment test result, (2) pos_weight stability/degeneracy logs, (3) architecture/capacity.

### Eval — reuse Stage 0's exact code, do not reimplement
- Import/call the same peak-picking + onset-merge function used in `baseline.py` (same tolerance constant, same merge-distance logic) — prevents silent drift between baseline and model comparisons.
- Run on the same held-out real songs Stage 0 was evaluated on.

### Kill condition
Must beat Stage 0 baseline precision/recall using identical eval code on identical held-out songs. If not: check alignment test, then pos_weight logs, then data quantity — in that order. Do not proceed to Stage 2 until beaten.

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
- **Output contract for the game:** export with output names `onset_logits`, `active_logits`, `count_logits` from the first toy export (untrained heads allowed) so the browser glue never changes when Stages 2-3 land.
- **Export alongside the model:** `models/preproc.json` (all preprocessing parameters above, peak-picking thresholds, `fps`) and test vectors (a short WAV, expected mel features, expected logits).
- **Early toy ONNX:** export a toy model before the real one so the browser spike can run first. The spike tests the bidirectional GRU in ORT-web WASM and times a 4-minute song (rough estimate: ~1.2M MACs per frame, ~30 GMACs per song, so likely tens of seconds; measure, don't trust).
- **Measure F1 on browser-preprocessed audio**, not only Python-preprocessed audio. Browser resampling differs from librosa's.

### Stage 1 exit checklist
- [ ] Shape assert passes
- [ ] Alignment (impulse-response) test passes with `abs(argmax_frame - 200) <= 2`
- [ ] Overfits 10-song toy set
- [ ] pos_weight derived via stability + degeneracy probes, both values logged
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

## Postprocessing (TypeScript chartgen, needed after Stage 1, refined through Stage 3)
- Peak-pick onset head output → discrete note times. Port the peak-picking from `baseline.py` and test it against Python-generated test vectors.
- For each onset, walk forward through the hold/active head until it drops → hold duration.
- Count head gives chord size only, not lanes. Lane assignment is a TypeScript heuristic with chord caps and an NPS cap (target ~7 notes/sec) that thins by onset confidence. It can become a model later.
- Beat grid: the game needs `timing[]` and `pulses[]` for editor snapping and beat-synced visuals. Use a beat tracker in TypeScript (Essentia.js is unverified: check it is maintained and fast enough in-browser) with a user-set BPM as fallback.
- Special class head (Stage 4): the game has no special notes; if trained, use it to drive beat-synced decoration strength.
- Schema mapping to the game's beatmap format: `time` → `t`; `duration` → `d` (0 = tap); `count` → chord expansion into multiple notes; optional `tier` field (in multiplayer the host picks the density so both players get the same chart).
- Output: JSON per song in the game's schema.

## Human validation (every stage, not just at the end)
- After each stage: overlay predicted notes on spectrogram, eyeball sanity.
- Playtest the resulting chart in-engine (or a minimal stub player) — precision/recall numbers can look good while the chart still feels unplayable. Trust ears/hands over metrics.

---

## Web Engine Integration (replaces the old C++ plan)
- **Bundled songs:** offline precompute on Kaggle → JSON chart → clean up in the editor. No browser inference needed for these.
- **Uploaded songs:** browser inference in a Web Worker with ONNX Runtime Web (WASM backend, single-threaded; avoid WebGPU and multithreaded WASM until verified). The model is ~1.4 MB in fp32 (353k params), so skip int8.
- Pipeline in the Worker: decode + resample → mel (matching `preproc.json`) → overlapped windows → ONNX → stitch → TypeScript postprocessing. Show a progress bar; ORT-web operator coverage (the bidirectional GRU) is verified by the toy-ONNX spike, not assumed.
- The ML side delivers to the game: output names, `models/preproc.json`, test vectors, and an early toy ONNX.
- Game styles (4, osu-inspired): build after the single-style pipeline works end-to-end. Do not attempt all 4 upfront.

---

## Global kill conditions / fallbacks
- Kaggle Dataset nearing 20GB → drop sample rate 22050→16000Hz, or shorten clips to 30s segments.
- Kaggle 30h/week insufficient → shrink model further or reduce dataset before assuming more compute is available (there isn't).
- Data source rate-limits/dies mid-scrape → fallback to manual curated batch, uploaded directly to Kaggle Dataset.
- Data licensing: the model trains on scraped osu! audio and maps. Keep raw data private. Publishing the weights in a public repo is a gray area (not legal advice).
- Any stage: if val metric looks good but human playtest feels wrong → treat as failure, metric doesn't capture "fun," add/adjust human-in-loop check before proceeding.

---

## Immediate next action
1. Scrape real 4K data on a Kaggle CPU session (small batch first, watch for 429s, then scale), filtering per `.osu` difficulty (`Mode == 3`, `CircleSize == 4`).
2. Re-verify holds/chords visually on a few real songs in `verify_song.py`, rendering the label arrays training uses.
3. Confirm every frame↔ms conversion goes through `config.FPS` helpers, then start Stage 1.
4. In parallel, export a toy ONNX (with `onset_logits`, `active_logits`, `count_logits`) plus `preproc.json` and test vectors so the game's browser-inference spike can start.