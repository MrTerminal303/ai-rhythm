import { expect, test } from "@playwright/test";

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
  await expect(page.locator('input[type="file"]')).toBeVisible();

  await page.goto("/spike-probe");
  await expect(page.getByTestId("probe-ok")).toBeVisible(); // worker+wasm ran

  // B7 (T17): the /spike Worker + ORT-web WASM instantiation is the real exercise of
  // 'wasm-unsafe-eval' + worker-src under the production CSP (D23).
  await page.goto("/spike");
  await page.getByRole("button", { name: /run spike/i }).click();
  await expect(page.getByTestId("spike-done")).toBeVisible({ timeout: 120_000 });

  expect(violations).toEqual([]); // aggregated across ALL routes
});
