# duelbeat — game monorepo

## Setup
1. corepack enable
2. cd web_app/game
3. pnpm install
4. pnpm -r typecheck
5. pnpm -r test
6. pnpm --filter @airhythm/web dev      # http://localhost:3000
7. pnpm --filter @airhythm/worker dev   # wrangler dev (worker)
