// apps/web/src/app/import/generate-q10.test.ts
// W3 T25b fix r1: the Q10 decision table, unit-tested.
//
// Before this, the Retry/Cancel surface in page.tsx had ZERO coverage — the
// whole block could be deleted with every gate still green. These rows pin the
// DECISION (pure), and `w3-flux-journey.spec.ts` pins the OBSERVABLE surface
// in a real browser.
import { describe, expect, it } from "vitest";
import { FluxGenerateError } from "@airhythm/chartgen";
import { GENERATOR_ID, decideGenerateUi } from "./generate-q10.js";

describe("Q10 decision table", () => {
  it("a successful run shows no error, no Retry and no Cancel", () => {
    const d = decideGenerateUi({ cancelled: false });
    expect(d).toMatchObject({ showError: false, showRetry: false, showCancel: false, message: null, code: null });
  });

  it("a USER cancel is not a failure: no error block, no Retry, no Cancel", () => {
    // The generator's own budget timeout does NOT set the abort flag, so an
    // over-budget run never arrives here — it arrives as a `timeout` error.
    const d = decideGenerateUi({ cancelled: true, error: new FluxGenerateError("cancelled", "aborted") });
    expect(d.showError).toBe(false);
    expect(d.showRetry).toBe(false);
    expect(d.showCancel).toBe(false);
  });

  it("an over-budget run (timeout) shows Retry AND Cancel, and names the code", () => {
    const d = decideGenerateUi({ cancelled: false, error: new FluxGenerateError("timeout", "generation exceeded 20000 ms") });
    expect(d.showError).toBe(true);
    expect(d.showRetry).toBe(true);
    expect(d.showCancel).toBe(true);
    expect(d.code).toBe("timeout");
    expect(d.message).toContain("timeout");
    expect(d.message).toContain("exceeded");
  });

  it("a validation failure shows Retry AND Cancel, and names the code", () => {
    const d = decideGenerateUi({ cancelled: false, error: new FluxGenerateError("validation", "malformed candidate") });
    expect(d.showError).toBe(true);
    expect(d.showRetry).toBe(true);
    expect(d.showCancel).toBe(true);
    expect(d.code).toBe("validation");
  });

  it("an internal failure shows Retry AND Cancel", () => {
    const d = decideGenerateUi({ cancelled: false, error: new FluxGenerateError("internal", "worker died") });
    expect(d.showError).toBe(true);
    expect(d.showRetry).toBe(true);
    expect(d.showCancel).toBe(true);
    expect(d.code).toBe("internal");
  });

  it("an unstructured failure still shows Retry AND Cancel, with no code", () => {
    const d = decideGenerateUi({ cancelled: false, error: new Error("boom") });
    expect(d.showError).toBe(true);
    expect(d.showRetry).toBe(true);
    expect(d.showCancel).toBe(true);
    expect(d.code).toBeNull();
    expect(d.message).toContain("boom");
  });

  it("NO decision ever switches the generator (Q10: flux-v1 stays the one used)", () => {
    const outcomes = [
      { cancelled: false },
      { cancelled: true },
      { cancelled: false, error: new FluxGenerateError("timeout", "x") },
      { cancelled: false, error: new FluxGenerateError("internal", "x") },
      { cancelled: false, error: new Error("x") },
    ];
    for (const o of outcomes) {
      expect(decideGenerateUi(o).generatorId).toBe(GENERATOR_ID);
    }
    expect(GENERATOR_ID).toBe("flux-v1");
  });
});
