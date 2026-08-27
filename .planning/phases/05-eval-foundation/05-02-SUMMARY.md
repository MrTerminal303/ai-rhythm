---
phase: 05-eval-foundation
plan: 02
subsystem: eval-foundation
tags: [baseline-pin, yardstick, config-option-b, eval-songs]

# Dependency graph
requires:
  - phase: 05-eval-foundation
    provides: [peak_pick_frames public, normalize_envelope public, golden_pre_*.npz fixtures]
provides:
  - pinned baseline F on 5 eval songs under option-b params
  - data/eval_pins.json with per-song F_important/F_filler + aggregate
  - metadata/eval_song_ids.json (5 eval + 1 search held-out)
  - golden_post_*.npz re-captured after config.py option-b overwrite
  - golden regression parametrized default=post (pre preserved as historical)
affects: [08-full-training-salience, 10-postprocess-json]

# Tech tracking
tech-stack:
  added: [airhythm/pin_baseline.py, airhythm/tests/test_eval_pin.py, airhythm/tests/fixtures/golden_post_*.npz]
  patterns: [yardstick-derivation-option-b, pinned-baseline-computation, config-overwrite]

key-files:
  created: [data/eval_pins.json, airhythm/pin_baseline.py, metadata/eval_song_ids.json,
            airhythm/tests/test_eval_pin.py, airhythm/tests/fixtures/golden_post_*.npz (6)]
  modified: [airhythm/config.py (PEAK_PICK_* option-b overwrite), airhythm/tests/test_baseline.py
             (golden regression parametrized default=post)]

key-decisions:
  - "yardstick derivation option (b): deterministic option-b per STATE D-10; research Section 3.1 gives important-F 0.272-0.320 (meaningful, beatable)"
  - "pinned F 0.3205 < 0.9: no gate renegotiation needed"
  - "eval-song set: 5 fixed + 1 search held-out per D-16 and research Section 3.1"
  - "golden regression parametrized default=post: post-derivation fixtures are the regression target"

requirements-completed: [EVL-02]

# Metrics
duration: ~25min
completed: 2026-08-27
---

# Phase 05-02: Pin baseline F (EVL-02)

Yardstick pinned on 5-song eval set under option-b (librosa default) params. Mean important-F 0.3205 — meaningful, beatable, below the 0.9 renegotiation trigger. Decision recorded in pin JSON.

## Yardstick derivation (STATE D-10)

Option-b deterministic: `delta=0.07, pre_max=3, post_max=1, pre_avg=10, post_avg=11, wait=3`. Option-a (delta=0.3) empirically degenerate (important-F ~0.009); option-b gives 0.272-0.320.

## Per-song F table

| Song    | n_est | F_important | F_filler |
|---------|-------|-------------|----------|
| 2255671 | 490   | 0.3442      | 0.1864   |
| 2256944 | 128   | 0.1620      | 0.1714   |
| 2516285 | 215   | 0.3082      | 0.1929   |
| 2527391 | 971   | 0.3469      | 0.3208   |
| 2589624 | 477   | 0.4409      | 0.1996   |

Aggregate: mean_F_important 0.3205, mean_F_filler 0.2142

## Config.py final values (option-b)

`PEAK_PICK_DELTA = 0.07`, `PEAK_PICK_PRE_MAX = 3`, `PEAK_PICK_POST_MAX = 1`, `PEAK_PICK_PRE_AVG = 10`, `PEAK_PICK_POST_AVG = 11`, `PEAK_PICK_WAIT = 3`, all in `__all__`, `PEAK_PICK_PARAMS` dict rebuilt.

## Pin JSON

`data/eval_pins.json` — keys: `derivation_option: "b"`, `params`, `per_song` (5 songs with F_important/F_filler), `aggregate` (mean_F_important 0.3205), `eval_song_ids`, `search_set_ids`, `decision_ref: "D-10, D-16, RESEARCH.md Section 3.1 option b"`, `pinned_at` (ISO-8601). Phase 8 reads `aggregate.mean_F_important` against model output.

## Golden fixture generations

- `golden_pre_*.npz` (6 files): frozen delta=0.3 snapshots (n_est in 1-35 degenerate band). NOT re-captured after config.py change. Preserved as frozen historical proof of bit-identical refactor (05-01).
- `golden_post_*.npz` (6 files): captured AFTER config.py option-b overwrite. n_est in {100..4000}. Default regression target. `pytest -k golden` asserts against these by default.
- Golden regression test parametrized: `@pytest.mark.parametrize("song_id,snapshot,n_est_lo,n_est_hi")`. Pre snapshot reachable but NOT default.

## Test count

94 base → 106 (05-01) → 118 (05-02: +2 from test_eval_pin smoke/no-nan/short-songs/decision/band tests; golden pre parametrize hidden by snapshot=pre skip).

## STATE.md blocker #1 resolved

`Baseline important-bucket F unknown` closed: pinned F 0.3205 (option b). No renegotiation triggered. Gate ready for Phase 8.