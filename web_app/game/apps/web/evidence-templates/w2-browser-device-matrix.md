# W2 browser/device matrix — output offset acceptance (spec §4.7)

Copy this file to the local gitignored `evidence/` directory as `w2-browser-device-matrix.md`
and fill it during measurement runs. Procedure: `w2-slowmo-procedure.md` (Task 24).
Pass criterion per row: |measured offset| ≤ 10 ms after accounting for video-frame quantization.

| Browser / device            | Slow-mo measured offset (ms) | ≤10 ms pass/fail | Notes                                  |
| --------------------------- | ---------------------------- | ---------------- | -------------------------------------- |
| Chrome (wired)              |                              |                  |                                        |
| Chrome (Bluetooth)          |                              |                  |                                        |
| Edge (wired spot-check)     |                              |                  | Same engine as Chrome — spot-check only |
| Firefox (wired)             |                              |                  | Best-effort tier (C1)                  |
| Firefox (Bluetooth)         |                              |                  | Best-effort tier (C1)                  |

Desktop Safari is excluded by C1 (support scope = Chrome/Edge primary, Firefox best-effort,
desktop-only). Measurement steps: follow the Task 24 slow-mo procedure
(`w2-slowmo-procedure.md`).
