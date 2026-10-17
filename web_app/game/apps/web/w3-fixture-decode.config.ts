// Committed runner config for the §7 fixture-decode gate (W3 T14): the spec must be exercised on
// chromium + firefox + webkit — this config declares all THREE projects so the decode gate runs on
// every engine in one command, including the standalone `e2e:fixture-decode` script.
//
// The main apps/web/playwright.config.ts ALSO declares projects (chromium runs everything; firefox
// and webkit are grep-scoped to the evidence specs, which includes w3-fixture-decode), so the gate
// does run there too — this config is kept so the decode gate has a dedicated 3-engine runner whose
// project list is NOT coupled to the main config's grep scoping.
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
