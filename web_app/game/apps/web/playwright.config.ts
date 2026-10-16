import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "../../e2e", // apps/web → web_app/game/e2e (NOT "../e2e", which would resolve to apps/e2e)
  globalSetup: "../../e2e/global-setup.ts", // regenerate gitignored click-track.wav if missing (resolved from config dir, same as testDir)
  // Weak-PC tuning: 5 parallel Chromium workers starve the CPU (software WebGL →
  // multi-second frames; the 60-frame sampling loop and the 1920x1080 capture blew
  // the old 60s budget). 2 workers + 180s keeps every assertion, just fits a weak machine.
  timeout: 180_000,
  workers: 2,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000", // spec calls page.goto("/play") — relative URLs need a baseURL
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm start",
    // Weak-PC note (W3 T7): the Next build can OOM on <4 GB heaps — run with
    // NODE_OPTIONS=--max-old-space-size=4096 set in the calling shell if the
    // webServer times out. No in-tree env knob; CI/operator memory is the lever.
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 120_000,
    // I3: production webServer build must keep window.__w2 for the specs; Next.js
    // inlines NEXT_PUBLIC_* at build time, so set it on the build+start command env
    // (Playwright merges this over process.env).
    env: { NEXT_PUBLIC_E2E: "1" },
  },
  // W3 T15 (A5): the default chromium project runs EVERYTHING (unchanged behavior — verified by
  // `playwright test --list`, whose count for the non-grep specs is unaffected).
  // Firefox and webkit run ONLY the multi-engine evidence specs (grep matches the spec FILE PATH):
  // the claim-2 timing suite, T14's decode gate, and T2's D21 conversion invariant — the D21
  // invariant is claim-1 evidence on all three engines. The rest of the suite stays chromium-only
  // so CI time does not multiply by three.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, grep: /w3-timing|w3-fixture-decode|w3-clock-invariant/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /w3-timing|w3-fixture-decode|w3-clock-invariant/ },
  ],
});
