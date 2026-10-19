// W3 T23 (B6) carry-over fix: building a RunResult must never fail on a non-secure origin.
// On plain-HTTP LAN (`http://192.168.x.x`), `crypto.randomUUID` is undefined — the T21 publish
// sat inside an async IIFE, so a throw there dropped a completed run with no error at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRunResult } from "./last-run.js";
import type { GameSnapshot } from "../engine/types.js";

const snap = {
  score: 100,
  maxCombo: 5,
  accuracy: 0.9,
  judgementCounts: { perfect: 5, great: 0, good: 0, miss: 0 },
} as unknown as GameSnapshot;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildRunResult run identity", () => {
  it("mints a UUID-shaped id and reflects auth state", () => {
    const r = buildRunResult(snap, "hash", { authenticated: true });
    expect(r.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(r.sessionOnly).toBe(false);
    expect(buildRunResult(snap, "hash").sessionOnly).toBe(true); // guest default
  });

  it("still returns a run (with a usable id) where crypto.randomUUID is unavailable", () => {
    // exactly the non-secure-origin shape: the method is gone, not throwing a plain Error
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: undefined });
    const r = buildRunResult(snap, "hash", { authenticated: true });
    expect(r.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(r.score).toBe(100); // the run itself is intact — it is never dropped
  });

  it("two runs never share an id", () => {
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: undefined });
    expect(buildRunResult(snap, "h").runId).not.toBe(buildRunResult(snap, "h").runId);
  });
});
