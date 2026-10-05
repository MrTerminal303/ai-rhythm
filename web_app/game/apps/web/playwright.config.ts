import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../e2e", // apps/web → web_app/game/e2e (NOT "../e2e", which would resolve to apps/e2e)
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000", // spec calls page.goto("/play") — relative URLs need a baseURL
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm start",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
