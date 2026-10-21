// e2e/w3-journey-auth.spec.ts
// W3 T26 — spec §7 journey 4: the AUTH journey (guest policy, §4 / Review Focus 4).
//
//   guest: import + play a run to completion → results shown, ZERO `*.supabase.co`
//   requests recorded, and no `profiles` row exists for the account we later log in as
//   → sign in on /auth → play a NEW run → its score appears in `runs` (read back with
//   the test's OWN authenticated REST call, using the session the browser really holds)
//   → guest-era scores remain absent: query `runs` for the guest run's `chart_hash` in a
//   `played_at` window covering that run → no row beyond a snapshot taken BEFORE the guest
//   play began (Review Focus 4). The chart hash is content-derived and shared with the
//   signed-in run, so an empty result would prove nothing; the pre-guest snapshot subtraction
//   is what makes the window check able to fail.
//
// ENV-GATED, like rls.test.ts: without SUPABASE_TEST=1 (plus the two NEXT_PUBLIC_*
// variables) this suite SKIPS and
// PRINTS the cases that did not run. A skip is not a pass. The operator runs it with a
// real project (`SUPABASE_TEST=1` + the two NEXT_PUBLIC_* variables also makes the app
// build a configured build — the webServer inherits the shell env).
//
// NUMBERS: short.osu's 71 notes end at 29.5 s (engine freeze +110 ms); each play phase is
// roughly 35 s, so both runs together fit inside the config's 180 s per-test budget with
// the import (~5 s) and the auth/settings round trips.
import { expect, test, type Page } from "@playwright/test";
import { importSong, readStore, shot, startRun, waitCompleted } from "./journey-helpers";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const SUPABASE_KEY = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
// Explicit opt-in: the two NEXT_PUBLIC_* variables alone are NOT enough. In any shell where
// they are set (an ordinary configured build) this spec would run — and `ensureAccount()`
// would attempt a SIGNUP with the fixed fallback password. Same rule as rls.test.ts:19.
const ENABLED = process.env.SUPABASE_TEST === "1" && SUPABASE_URL !== "" && SUPABASE_KEY !== "";

/** A dedicated test account — never production user data (same rule as rls.test.ts). */
const TEST_EMAIL = process.env.SUPABASE_TEST_EMAIL ?? "e2e-t26-journey@example.com";
const TEST_PASSWORD = process.env.SUPABASE_TEST_PASSWORD ?? "e2e-t26-journey-password";

/** The cases this file would execute — printed verbatim on a skip so silence is never a pass. */
const CASES = [
  "guest: play a run to completion → results overlay, NO *.supabase.co requests",
  "guest: no row synced from the guest run (authenticated REST read, pre-login snapshot)",
  "login: /auth sign-in → signed-in state visible",
  "signed-in: a NEW completed run appears in `runs` (authenticated REST read-back)",
  "settings: pre-login local edit merged into profiles.settings (login trigger)",
  "guest-era score: 0 rows in `runs` for the guest run's chart_hash in its played_at window",
];

if (!ENABLED) {
  // stderr, not stdout — Playwright captures/quietens console output; a silent skip would
  // be indistinguishable from a pass.
  process.stderr.write(
    [
      "",
      "── w3-journey-auth.spec.ts SKIPPED ─────────────────────────────────────",
      "  Reason: SUPABASE_TEST=1 must be set, and NEXT_PUBLIC_SUPABASE_URL and",
      "  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must both be set (and the build must",
      "  be a configured build). No Supabase project is configured in this shell —",
      "  the operator runs this suite.",
      "  Cases NOT executed:",
      ...CASES.map((c) => `    ✗ ${c}`),
      "  This skip is NOT a pass.",
      "─────────────────────────────────────────────────────────────────────────",
      "",
      "",
    ].join("\n"),
  );
}

/** POST /auth/v1/token with the app's own publishable key — the test's service-agnostic auth. */
async function passwordGrant(email: string, password: string): Promise<{ accessToken: string; userId: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`password grant ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; user: { id: string } };
  return { accessToken: body.access_token, userId: body.user.id };
}

/** Authenticated REST read of the caller's own rows (RLS returns only their rows). */
async function restSelect<T>(accessToken: string, path: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

type RunRow = { run_id: string; chart_hash: string; played_at: string };
/** `profiles.settings` is the T22 envelope map — every key carries a writeId. */
type ProfileRow = {
  settings: Record<string, { value: unknown; rev: number; deviceId: string; writeId: string }> | null;
};

/** Sign up (idempotent — a second call for an existing account is tolerated) + sign in. */
async function ensureAccount(): Promise<{ accessToken: string; userId: string }> {
  const signup = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  // 200/422 both mean "the account is usable (created now / already registered)" for a
  // test project with email confirmation DISABLED. Anything else is a real failure.
  if (!signup.ok && signup.status !== 422) {
    throw new Error(`signup ${signup.status}: ${await signup.text()}`);
  }
  return passwordGrant(TEST_EMAIL, TEST_PASSWORD);
}

/** Count `*.supabase.co` requests the page made — the guest zero-touch assertion. */
function watchSupabase(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(".supabase.co")) seen.push(req.url());
  });
  return seen;
}

test.describe("journey 4: guest → login → new run syncs, guest-era score stays absent", () => {
  test.skip(!ENABLED, "SUPABASE_TEST=1 / NEXT_PUBLIC_SUPABASE_* unset — operator runs this journey (see stderr)");

  test("guest plays, logs in, syncs a new run, and the guest-era score never appears", async ({ page }) => {
    const auth = await ensureAccount();
    // W3 runs are append-only (no DELETE grant), so an earlier run of this spec can leave
    // rows behind. The `played_at` windows below — not a cleanup — are what isolate the
    // guest run from the signed-in run.
    const chartId = await importSong(page);
    const stored = (await readStore(page)).charts.find((c) => c.chartId === chartId);
    if (!stored) throw new Error("import did not persist the chart");
    const chartHash = stored.chartHash;

    // ---- Settings changed PRE-login (guest era), through the REAL /settings control — the
    // login trigger must merge this envelope into `profiles.settings`.
    await page.goto("/settings");
    // The writeId BEFORE the edit: a re-used writeId would let the remote-match poll below
    // pass against a row left by an earlier run, proving nothing about THIS edit.
    const writeIdBefore = await page.evaluate(() => {
      const doc = JSON.parse(localStorage.getItem("duelbeat.settings") ?? "{}") as Record<
        string,
        { value: unknown; rev: number; deviceId: string; writeId: string }
      >;
      return doc.scrollSpeed?.writeId ?? null;
    });
    await page.getByTestId("setting-scrollSpeed").fill("1.7");
    const localEnvelope = await page.evaluate(() => {
      const doc = JSON.parse(localStorage.getItem("duelbeat.settings") ?? "{}") as Record<
        string,
        { value: unknown; rev: number; deviceId: string; writeId: string }
      >;
      return doc.scrollSpeed;
    });
    if (!localEnvelope) throw new Error("the /settings control did not write a scrollSpeed envelope");
    expect(localEnvelope.value).toBeCloseTo(1.7, 5);
    // The edit really produced a NEW envelope (not a no-op on an already-1.7 value).
    expect(localEnvelope.writeId).not.toBe(writeIdBefore);

    // ---- Guest play, part 1: zero cloud touch.
    const guestRequests = watchSupabase(page);
    // The guest phase must really be unauthenticated: a persisted Supabase session would make
    // this run authenticated and the zero-touch assertion below meaningless.
    const authTokenKeys = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token")),
    );
    expect(authTokenKeys).toEqual([]);
    // The chart hash is content-derived, so earlier runs of this spec share it. Snapshot the
    // account's rows BEFORE the guest play so the signed-in run can be asserted to add EXACTLY
    // one, and so the guest-window check below compares against a genuinely pre-guest state.
    // F9 (R27 reversal): this read USED to sit after the guest play, which made the guest-window
    // subtraction empty by construction — any row the guest run could have created was already
    // inside the snapshot. Reading it here is what makes that subtraction able to fail.
    const rowsBefore = await restSelect<RunRow>(
      auth.accessToken,
      `runs?select=run_id,chart_hash,played_at&chart_hash=eq.${chartHash}`,
    );
    const guestPlayedFrom = Date.now();
    await page.goto(`/play?libraryChartId=${chartId}`);
    await startRun(page);
    await waitCompleted(page, 90_000);
    const guestPlayedTo = Date.now();
    await expect(page.getByTestId("results-score")).not.toBeEmpty();
    await expect(page.getByTestId("run-sync-error")).toHaveCount(0);
    await shot(page, "w3-journey-4-guest-results.png");
    // The load-bearing invariant: a guest run touches the cloud ZERO times.
    expect(guestRequests).toEqual([]);

    // ---- Login on /auth (the real form controls).
    await page.goto("/auth");
    await page.getByTestId("auth-email").fill(TEST_EMAIL);
    await page.getByTestId("auth-password").fill(TEST_PASSWORD);
    await page.getByTestId("auth-submit").click();
    await expect(page.getByTestId("auth-signed-in")).toBeVisible({ timeout: 30_000 });
    // The signed-in surface must name the account we signed in as (not just "some user").
    await expect(page.getByTestId("auth-signed-in")).toContainText(TEST_EMAIL);

    // The login-time settings sync lands the guest-era envelope in `profiles.settings` —
    // matched by its writeId, so a leftover value from an earlier run cannot pass this.
    await expect
      .poll(
        async () => {
          const rows = await restSelect<ProfileRow>(auth.accessToken, "profiles?select=settings");
          return rows[0]?.settings?.scrollSpeed?.writeId ?? null;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe(localEnvelope.writeId);

    // ---- A NEW signed-in run syncs its score.
    const authPlayedFrom = Date.now();
    await page.goto(`/play?libraryChartId=${chartId}`);
    await startRun(page);
    await waitCompleted(page, 90_000);
    await expect(page.getByTestId("run-sync-error")).toHaveCount(0);
    const authPlayedTo = Date.now();

    await expect
      .poll(
        async () => {
          const rows = await restSelect<RunRow>(
            auth.accessToken,
            `runs?select=run_id,chart_hash,played_at&chart_hash=eq.${chartHash}`,
          );
          return rows.length;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe(rowsBefore.length + 1);

    const rows = await restSelect<RunRow>(
      auth.accessToken,
      `runs?select=run_id,chart_hash,played_at&chart_hash=eq.${chartHash}`,
    );
    const row = rows.find((r) => !rowsBefore.some((b) => b.run_id === r.run_id));
    if (!row) throw new Error("no NEW run row appeared for the signed-in run");
    const rowTime = Date.parse(row.played_at);
    expect(rowTime).toBeGreaterThanOrEqual(authPlayedFrom - 1000);
    expect(rowTime).toBeLessThanOrEqual(authPlayedTo + 1000);

    // ---- Review Focus 4: the GUEST run's window holds NO row this account could have
    // synced. The chart hash is shared with the signed-in run, so the window plus the
    // pre-login snapshot is what isolates the guest era: no row inside the guest window
    // exists that was not already there (an earlier spec run) before this journey began.
    const guestWindow = await restSelect<RunRow>(
      auth.accessToken,
      `runs?select=run_id,chart_hash,played_at&chart_hash=eq.${chartHash}` +
        `&played_at=gte.${new Date(guestPlayedFrom).toISOString()}` +
        `&played_at=lte.${new Date(guestPlayedTo).toISOString()}`,
    );
    expect(guestWindow.filter((r) => !rowsBefore.some((b) => b.run_id === r.run_id))).toEqual([]);
  });
});
