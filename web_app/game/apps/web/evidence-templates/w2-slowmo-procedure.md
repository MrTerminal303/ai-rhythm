# W2 slow-mo latency procedure (PLAN §19, spec §4.7 layer 3)
1. Play /play (click-to-start) with the click-track fixture; record screen + system audio
   (OBS, **240 fps strongly preferred — it gives the most margin around the ±10 ms boundary;
   120 fps is the hard minimum — 60 fps is REJECTED: its 16.67 ms frame period is coarser
   than the threshold) with "record desktop audio" ON for ≥30 s including one pause/resume
   cycle. Record which rate was achieved.
2. Import the recording into any editor with frame + audio waveform view; **document the
   actual recorded frame interval (e.g. 8.33 ms @ 120 fps) at the top of the evidence**.
3. Pick ≥5 clicks. For each: note the frame where the note head crosses the hit line
   (visual) and the sample position of the audible click (waveform).
4. delta_ms = audio_click_time − note_crossing_frame_time per click. PASS = **|delta| ≤ 10 ms
   after accounting for video-frame quantization** (recorded frame interval documented;
   measured delta must exceed half a frame only downward — quote the quantization bound
   alongside each delta).
5. Repeat once on Chrome (wired) and once on Firefox (Bluetooth) → fill
   w2-browser-device-matrix.md rows. Edge = Chrome spot-check (same engine).
6. Save recording + filled matrix under evidence/ (gitignored); link both in the task report.
Desktop Safari: out of scope (C1). Desktop-only scope.

Operator executes; filled matrix + recording land in `evidence/`.
