# W2 early style check — operator judgment (swap gate)

Plan Task 23 / spec §6.5. Copy this file to the local gitignored `evidence/` directory as
`w2-style-check-report.md` and fill the verdict there. The committed template keeps
`Verdict: PENDING OPERATOR`: only the operator answers the gate question, never the
implementer. A **fail** verdict is what triggers the UI-pack swap (spec §11.1) plus an
appended **D20** — DECISIONS.md is append-only, D19 stays untouched. No swap has happened.

- **Date (capture):** 2026-10-07
- **Screenshot:** `web_app/game/evidence/task-style-check.png` — 1920×1080, gitignored
  (`web_app/game/.gitignore` → `evidence/`), produced by `e2e/w2-style-check.spec.ts`
  (highway + notes + HUD, audio playing, 2.5 s into play)
- **Spec command:** `pnpm --filter @airhythm/web exec playwright test w2-style-check`

## Packs in this capture (D19)

| Role      | Pack                       | Source                          | License |
| --------- | -------------------------- | ------------------------------- | ------- |
| UI (notes/HUD) | Kenney **UI Pack**    | https://kenney.nl/assets/ui-pack           | CC0 |
| Particles | Kenney **Particle Pack**   | https://kenney.nl/assets/particle-pack     | CC0 |
| Patterns  | Kenney **Pattern Pack Lines** | https://kenney.nl/assets/pattern-pack-lines | CC0 |

One UI pack only, never a mix (spec §6.5.1).

## Operator question

Does the screenshot read **"clean minimal", not "cartoon"**?

## Verdict: PENDING OPERATOR

- [ ] **Pass** — record date + packs as captured in the filled copy in `evidence/`. No swap.
- [ ] **Fail** — swap `assets/src/ui/` to the other Kenney UI pack (spec §11.1), update
      `assets/ASSETS.csv` rows, append **D20** (D19 untouched), re-run
      `pnpm build:atlas && pnpm check:assets`, re-run the capture spec, re-judge. Repeat
      until pass — the gate exists so the swap lands **before any W3 UI work**.
