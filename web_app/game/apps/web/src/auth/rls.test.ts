// W3 T23 (B6): the RLS + GRANTS contract, proven against a REAL Supabase project.
//
// Grants and RLS policies are SEPARATE controls (review round 2 P0), so the cases below are
// split the same way: the unauthenticated cases prove the GRANT is absent (PostgREST rejects
// before RLS ever runs), the authenticated-other-user cases prove the POLICY filters.
//
// ENV-GATED: without SUPABASE_TEST=1 this suite SKIPS and PRINTS the cases that did NOT run —
// a skip is never a pass. Run it locally with a real project:
//
//   SUPABASE_TEST=1 NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
//     pnpm --filter @airhythm/web test -- rls
//
// A dedicated test account pair is required (see .env.example); never point this at
// production user data.
import { describe, expect, it } from "vitest";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const ENABLED = process.env.SUPABASE_TEST === "1" && URL !== "" && KEY !== "";

/** the cases this file would execute — printed verbatim on a skip so silence is never a pass */
const CASES = [
  "runs: unauthenticated select → non-2xx (no anon SELECT grant) and no rows leaked",
  "runs: unauthenticated insert → non-2xx (no anon INSERT grant)",
  "profiles: unauthenticated select → non-2xx (no anon SELECT grant)",
  "profiles: unauthenticated insert → non-2xx (no anon INSERT grant)",
  "runs: authenticated owner select → 200 with their own row present",
  "runs: authenticated owner insert → 201",
  "runs: authenticated other user select → 200 with zero of the first user's rows",
  "runs: authenticated other user insert with a foreign user_id → non-2xx (with check)",
  "profiles: authenticated owner select → 200 with their own row present",
  "profiles: authenticated other user select → 200 with zero of the first user's rows",
];

if (!ENABLED) {
  // stderr, not console.log: vitest's default reporter swallows captured stdout for a
  // skipped file, and a skip that prints NOTHING is indistinguishable from a pass.
  process.stderr.write(
    [
      "",
      "── rls.test.ts SKIPPED ──────────────────────────────────────────────",
      "  Reason: SUPABASE_TEST=1 plus NEXT_PUBLIC_SUPABASE_URL and",
      "  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must all be set. No Supabase project",
      "  is configured on this machine — the operator runs this suite.",
      "  Cases NOT executed:",
      ...CASES.map((c) => `    ✗ ${c}`),
      "  This skip is NOT a pass. Record evidence in evidence/b6-rls.md when run.",
      "─────────────────────────────────────────────────────────────────────",
      "",
      ""
    ].join("\n"),
  );
}

describe.skipIf(!ENABLED)("RLS + grants against a real Supabase project", () => {
  const rest = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: KEY,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  /** sign up a throwaway user through the public auth endpoint and return its access token */
  async function signUpUser(tag: string): Promise<{ token: string; id: string }> {
    const email = `rls-${tag}-${Date.now()}@example.com`;
    const res = await fetch(`${URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: `pw-${tag}-${Date.now()}` }),
    });
    expect(res.ok, `signup ${tag} failed (${res.status})`).toBe(true);
    const body = (await res.json()) as { access_token?: string; user?: { id: string } };
    expect(body.access_token, "signup returned no access token — disable email confirmation for the test project").toBeTruthy();
    return { token: body.access_token!, id: body.user!.id };
  }

  const row = (userId: string, runId: string): Record<string, unknown> => ({
    run_id: runId,
    user_id: userId,
    chart_hash: "rls-probe",
    audio_hash: null,
    score: 1,
    accuracy: 1,
    max_combo: 1,
    judgements: { perfect: 1, great: 0, good: 0, miss: 0 },
    played_at: new Date().toISOString(),
  });

  it("runs: unauthenticated select is refused and leaks nothing", async () => {
    const res = await rest("runs?select=*");
    expect(res.status).toBeGreaterThanOrEqual(400); // 403 / 42501 — anon holds no SELECT grant
    const text = await res.text();
    expect(text).not.toContain("rls-probe");
  });

  it("runs: unauthenticated insert is refused", async () => {
    // no anon INSERT grant — separate control from the read case above
    const res = await rest("runs", { method: "POST", body: JSON.stringify(row("00000000-0000-4000-8000-000000000000", crypto.randomUUID())) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("profiles: unauthenticated select/insert are refused", async () => {
    expect((await rest("profiles?select=*")).status).toBeGreaterThanOrEqual(400);
    const insert = await rest("profiles", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID() }) });
    expect(insert.status).toBeGreaterThanOrEqual(400);
  });

  it("runs: the owner reads and writes their own history", async () => {
    const a = await signUpUser("owner");
    const runId = crypto.randomUUID();
    const insert = await rest("runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}`, Prefer: "return=representation" },
      body: JSON.stringify(row(a.id, runId)),
    });
    expect(insert.status).toBeGreaterThanOrEqual(200);
    expect(insert.status).toBeLessThan(300);

    const read = await rest(`runs?select=*&run_id=eq.${runId}`, { headers: { Authorization: `Bearer ${a.token}` } });
    expect(read.status).toBe(200);
    const rows = (await read.json()) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("runs: another user sees none of the first user's rows and cannot write as them", async () => {
    const a = await signUpUser("a");
    const b = await signUpUser("b");
    const runId = crypto.randomUUID();
    await rest("runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}`, Prefer: "return=representation" },
      body: JSON.stringify(row(a.id, runId)),
    });

    // the grant exists for `authenticated`, so this 200 proves RLS FILTERING (not a grant gap)
    const filtered = await rest(`runs?select=*&user_id=eq.${a.id}`, { headers: { Authorization: `Bearer ${b.token}` } });
    expect(filtered.status).toBe(200);
    expect((await filtered.json()) as unknown[]).toHaveLength(0);

    // the `with check` clause is the control here
    const forged = await rest("runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${b.token}` },
      body: JSON.stringify(row(a.id, crypto.randomUUID())),
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
  });

  it("profiles: the owner reads their row; another user sees zero rows", async () => {
    const a = await signUpUser("pa");
    const b = await signUpUser("pb");
    await rest("profiles", {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}`, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: a.id, settings: { proof: true } }),
    });

    const own = await rest(`profiles?select=*&id=eq.${a.id}`, { headers: { Authorization: `Bearer ${a.token}` } });
    expect(own.status).toBe(200);
    expect((await own.json()) as unknown[]).toHaveLength(1);

    const other = await rest(`profiles?select=*&id=eq.${a.id}`, { headers: { Authorization: `Bearer ${b.token}` } });
    expect(other.status).toBe(200);
    expect((await other.json()) as unknown[]).toHaveLength(0);
  });
});
