// Committed runner config for the §7 fixture-decode gate (W3 T14): the spec must be
// exercised on chromium + firefox + webkit — the default apps/web/playwright.config.ts
// declares no `projects`, so it runs chromium only and cannot express the three-engine gate.
//
// Kept as a SEPARATE config (not projects added to playwright.config.ts) so the existing
// e2e specs (w1-*, w2-*, w3-*) keep their current single-engine behaviour unchanged.
// Run: `pnpm --filter @airhythm/web e2e:fixture-decode` (builds+starts its own server, like
// the main config; reuseExistingServer:false so a stale server cannot masquerade as a pass).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../e2e",
  testMatch: "w3-fixture-decode.spec.ts",
  timeout: 180_000,
  retries: 0,
  workers: 2,
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm start",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_E2E: "1" },
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
