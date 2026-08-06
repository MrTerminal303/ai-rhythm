# Hold + Chord Labels End-to-End (Stage 0.6)

## Goal

Close Stage 0.6: extract hold-duration and chord-size labels alongside existing onset labels, save them with each preprocessed chunk, render them in `verify_song.py`, and visually confirm on real songs. Also stop using Griffin-Lim for playback — play the original audio instead, saved during scrape, debug-only.

## Status

In progress (Stage 0.6). Parser restored + verified (25 tests pass, extracts `end_time`/lane/key-mode). Labels + rendering + visual verify remain.

## Context

- `audio_preproc.extract_onset_labels` builds binary `onset[t]` only. `preprocess_osz` saves one `(400,)` `_labels.npy` per chunk.
- `verify_song` reads `_labels.npy` → `onsets (T,)`, renders red onset lines; plays audio via Griffin-Lim inversion (~3 min/song, low quality).
- Data dir: 6 songs, each with `{i:04d}.npy` + `{i:04d}_labels.npy`. Hit-object source was discarded after preprocessing; `.osz` deleted. Existing labels are onset-only `(400,)`.
- Restored `osu_parser` exports `HitObject(time, end_time, lane, type_bitmask)` and `find_audio_file(osz_bytes, audio_filename)`.

## Label format (locked — Option A)

One `(3, 400)` `_labels.npy` per chunk. Rows:

| Row | Name | Content |
|-----|------|---------|
| 0 | `active` | 1 for every frame inside a hold's `[time, end_time)` span, else 0 |
| 1 | `onset` | 1 at frame where a note starts (existing binary, moved to row 1) |
| 2 | `count` | int, number of notes whose start frame == this frame (chord size; 0 = silence) |

- Filename unchanged: `{chunk_idx:04d}_labels.npy`. Naming contract preserved; only width grows `(400,) → (3,400)`.
- Row order puts the two per-head continuous heads first (active, onset); `count` is categorical, last. Matches PLAN.md multi-head split.
- Taps: `end_time == time` → one active frame at onset.
- Chord = group hit objects by `int(round(time/1000*100))` start frame; `count = len(group)`.

`extract_onset_labels(hit_objects, chunk_start_frame, n_frames)` → replaced by `extract_chunk_labels(hit_objects, chunk_start_frame, n_frames)` returning `(3, 400)`. `config.LABEL_SHAPE` → `(3, 400)`.

## Original audio for playback (not Griffin-Lim)

`preprocess_osz` already has the decoded audio bytes. After loading, also write them to `{output_dir}/{bid}/original.audio` via `find_audio_file(osz_bytes, audio_filename)`. Debug-only: not in `metadata.json` `files`, lives under gitignored `data/`. Extension-agnostic (`librosa.load` decodes by content).

`verify_song.Song.load()`:
1. If `original.audio` exists → `librosa.load(io.BytesIO(bytes), sr=22050, mono=True)` → `waveform`. No inversion, no wait.
2. Else fallback → existing `mel_to_audio` Griffin-Lim path (keeps pre-re-scrape songs working).

Playback, duration, seek/cursor alignment unchanged. Spectrogram built from the same audio, so mp3 timeline matches the frame grid; ~83 ms STFT edge offset, negligible for visual verify.

## verify_song rendering

`Song._load_spec_and_onsets` concatenates `(3,400)` chunks → exposes `active`, `onsets`, `count` views. `check()` reports all three sums.

`_draw_chunk`:
- **onset** → red vertical line (unchanged, now reads row 1)
- **active** → horizontal colored span from `time`→`end_time` near the plot bottom (green) — hold length visible
- **count** → onset-marker tint by chord size; multi-note frames distinct color (orange) so a chord reads as stacked notes at one time

## Re-scrape

Delete the 6 old `.npy` songs (stale `(400,)` labels, no `original.audio`). Re-run `download_minimal.py` → 3 fresh songs each with `(3,400)` labels + `original.audio`. Verify holds/chords + playback on real songs in GUI.

## Testing

- `test_osu_parser`: unaffected (parser untouched).
- Label-build tests: synthetic `HitObject` list with a tap, a hold, a 2-note chord → assert `(3,400)` rows correct (`active` spans, `onset` at starts, `count` == 2 at chord frame).
- Visual: real song shows holds as spans and chords as tinted markers; playback plays original mp3.

## Out of scope

- Hit-object JSON retention (deferred — only needed if lane/beat-grid modeling arises, Stage 5).
- Griffin-Lim quality tuning (playback now original audio).
- Reconstructing labels for the 6 old songs (re-scrape replaces them).
