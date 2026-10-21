import { expect, test } from "@playwright/test";

// The app's `isSupabaseConfigured()` (apps/web/src/auth/auth.ts:99-101) requires BOTH the URL
// AND the publishable key to be non-empty (each trimmed). The spec's precondition must mirror
// that EXACTLY: a shell that exports only the URL still builds a GUEST-ONLY app, so the
// unconfigured notice IS expected there.
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const SUPABASE_KEY = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
const SUPABASE_CONFIGURED = SUPABASE_URL !== "" && SUPABASE_KEY !== "";

test("production CSP: play, import, and Worker/WASM probe run with zero violations", async ({ page }) => {
  // Violations aggregate in NODE across navigations (review P0: window.__cspViolations is
  // per-document — a goto wipes it; exposeFunction survives every navigation).
  const violations: string[] = [];
  await page.exposeFunction("__cspReport", (v: string) => { violations.push(v); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      void (window as never as { __cspReport?: (v: string) => void }).__cspReport?.(
        `${e.violatedDirective}: ${e.blockedURI} (sample ${e.sample ?? ""})`,
      );
    });
  });

  const header = await page.request.get("/");
  const csp = header.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  // W3 T23 (B6): connect-src is `'self'` for a guest-only build and gains EXACTLY ONE bare
  // project origin when Supabase is configured — never a wildcard, never a path. Asserted off
  // the observed header so the same check holds whether or not this shell exports the env.
  const connectSrc = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("connect-src "));
  expect(connectSrc, "connect-src present").toBeTruthy();
  const connectTokens = connectSrc!.slice("connect-src ".length).split(/\s+/);
  expect(connectTokens).toContain("'self'");
  expect(connectSrc).not.toContain("*"); // a wildcard here would defeat the guest-only build
  expect(connectTokens.length === 1 || connectTokens.length === 2).toBe(true);
  if (connectTokens.length === 2) {
    expect(connectTokens[1]).toMatch(/^https:\/\/[a-z0-9.-]+$/i); // bare origin: no path, no trailing slash
  }
  // Token-level script-src check (review P0: substring check would false-fail on 'wasm-unsafe-eval')
  const scriptSrc = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src "));
  expect(scriptSrc, "script-src present").toBeTruthy();
  const tokens = scriptSrc!.slice("script-src ".length).split(/\s+/);
  expect(tokens).not.toContain("'unsafe-eval'"); // bare unsafe-eval banned in prod
  expect(tokens).toContain("'wasm-unsafe-eval'"); // narrowly added, D23
  expect(tokens).toContain("'self'");

  await page.goto("/play");
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing");
  await page.waitForTimeout(1500);

  await page.goto("/import");
  // T20 (B3): /import has TWO file inputs (audio + chart) — pin both by testid so the check
  // survives the uploader's shape without a strict-mode collision.
  await expect(page.getByTestId("import-audio-input")).toBeVisible();
  await expect(page.getByTestId("import-file-input")).toBeVisible();

  // W3 T23 (B6): the /auth journey renders under the production CSP (the client is
  // constructed lazily and this build has no Supabase env → guest-only, no network).
  //
  // PRECONDITION (final review F15): `auth-unconfigured` renders ONLY in a build where
  // Supabase is NOT configured — and the app's own `isSupabaseConfigured()`
  // (apps/web/src/auth/auth.ts:99-101) requires the URL **AND** the publishable key to be
  // non-empty. The build inlines those envs (Next inlines NEXT_PUBLIC_* at build time, and
  // the webServer inherits this runner's process env), so an operator shell that exports
  // only the URL still builds a GUEST-ONLY app and the unconfigured notice IS expected.
  // The gate below mirrors that AND-condition exactly. The CSP assertions above and below
  // are NOT gated and always run.
  await page.goto("/");
  await page.getByTestId("landing-account").click();
  await expect(page.getByTestId("auth-email")).toBeVisible();
  if (!SUPABASE_CONFIGURED) {
    await expect(page.getByTestId("auth-unconfigured")).toBeVisible(); // no env in the e2e build
  } else {
    // The operator shell exports a Supabase project (URL AND key) → this build is CONFIGURED,
    // so the unconfigured notice is (correctly) absent. Not a CSP failure.
    console.log("[w3-csp] Supabase is configured (URL AND key) — skipping the guest-only auth-unconfigured assertion");
  }
  await expect(page.getByTestId("settings-sync-now")).toHaveCount(0); // this is /auth, not /settings
  await page.goto("/settings");
  await expect(page.getByTestId("settings-account-state")).toBeVisible();

  await page.goto("/spike-probe");
  await expect(page.getByTestId("probe-ok")).toBeVisible(); // worker+wasm ran

  // B7 (T17): the /spike Worker + ORT-web WASM instantiation is the real exercise of
  // 'wasm-unsafe-eval' + worker-src under the production CSP (D23).
  await page.goto("/spike");
  await page.getByRole("button", { name: /run spike/i }).click();
  await expect(page.getByTestId("spike-done")).toBeVisible({ timeout: 120_000 });

  expect(violations).toEqual([]); // aggregated across ALL routes
});
