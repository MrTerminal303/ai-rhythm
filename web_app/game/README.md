# duelbeat — game monorepo

## Setup
1. corepack enable
2. cd web_app/game
3. pnpm install
4. pnpm -r typecheck
5. pnpm -r test
6. pnpm --filter @airhythm/web dev      # http://localhost:3000
7. pnpm --filter @airhythm/worker dev   # wrangler dev (worker)

## Deploy
pnpm --filter @airhythm/worker deploy   # wrangler login first time
$env:WORKER_URL="https://airhythm-worker.trung-nt235444.workers.dev"; node scripts/smoke.mjs  # post-deploy smoke (PowerShell; Git Bash: WORKER_URL=https://airhythm-worker.trung-nt235444.workers.dev node scripts/smoke.mjs)
