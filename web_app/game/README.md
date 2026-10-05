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
pnpm --filter @airhythm/worker run deploy   # wrangler login first time
$env:WORKER_URL="https://airhythm-worker.trung-nt235444.workers.dev"; node scripts/smoke.mjs  # post-deploy smoke (PowerShell; Git Bash: WORKER_URL=https://airhythm-worker.trung-nt235444.workers.dev node scripts/smoke.mjs)

## Vercel (web production)
- Root Directory: `apps/web` (relative to upload root `web_app/game`), framework nextjs
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `cd ../.. && pnpm --filter @airhythm/web build`
- Deploy: from `web_app/game` run `./apps/web/node_modules/.bin/vercel --prod` (pinned CLI 62.2.0; run the binary directly so cwd stays the workspace root — `pnpm --filter … exec` chdirs back to `apps/web` and breaks the upload root)
- Live: https://dualbeat-trungfa30-gmailcoms-projects.vercel.app
