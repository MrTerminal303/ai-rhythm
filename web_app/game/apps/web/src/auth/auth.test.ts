// @vitest-environment jsdom
// W3 T23 (B6): the auth POLICY contract — the jsdom side of the Supabase channel.
//
// The Supabase client is mocked at the MODULE boundary, so every assertion here is about
// OUR policy (who talks to the cloud, when, with what payload, and what is never queued),
// never about supabase-js internals. ONE test delegates to the REAL createClient with a
// fetch spy, because "a fresh guest issues zero requests" is a claim about the real client.
//
// Cases (brief Step 1 + round-3/round-4 additions):
//   (a) fresh guest → startup + a completed run make ZERO requests
//   (b) persisted session restored → signed in, settings sync armed
//   (c) onAuthStateChange drives UI + sync eligibility (sign-out)
//   (d) guest-era runs are never queued (nor uploaded later)
//   (e) idempotent upload: same runId twice → one row
//   (f) bounded SAME-run retry (1 s / 4 s, 3 attempts) then a visible run-sync-error
//   (g) a later run never retries the old one
//   (h) playedAt range validation rejects future/epoch stamps
//   (i) invalid non-NULL remote settings → invalid-remote, local untouched
//   (j) NULL remote → treated as {}, local merges in, row ends initialized (first login)
//   (k) sync triggers: login, debounced local edit while authenticated, manual "Sync now"
//   (l) the /settings deferred notice clears on the next ok:true
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../ui/last-run.js";

type AuthUser = { id: string; email: string | null };
type UpsertCall = { table: string; payload: Record<string, unknown>; opts: Record<string, unknown> | undefined };

const profiles = new Map<string, { id: string; settings: unknown }>();
const runs = new Map<string, Record<string, unknown>>();
const calls = { selects: [] as string[], upserts: [] as UpsertCall[], signIn: 0, signUp: 0, signOut: 0 };
/** fault injection: fail the next N selects / upserts with a PostgREST-style error */
const failures = { selectOnce: false, upsertTimes: 0 };
let authUser: AuthUser | null = null;
let authListeners: Array<(event: string, session: unknown) => void> = [];
/** "mock" = policy tests; "real" = delegate to the actual supabase-js createClient */
let mode: "mock" | "real" = "mock";

function session(): { user: AuthUser } | null {
  return authUser ? { user: authUser } : null;
}

function emit(event: string): void {
  for (const l of [...authListeners]) l(event, session());
}

function makeMockClient() {
  return {
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
      signUp: async ({ email }: { email: string }) => {
        calls.signUp += 1;
        authUser = { id: `user-${email}`, email };
        return { data: { user: authUser }, error: null };
      },
      signInWithPassword: async ({ email }: { email: string }) => {
        calls.signIn += 1;
        authUser = { id: `user-${email}`, email };
        return { data: { user: authUser }, error: null };
      },
      signOut: async () => {
        calls.signOut += 1;
        authUser = null;
        return { error: null };
      },
      onAuthStateChange: (cb: (event: string, s: unknown) => void) => {
        authListeners.push(cb);
        // supabase-js replays INITIAL_SESSION asynchronously — the mock must too, or the
        // restore test would pass on an ordering the real client never produces.
        void Promise.resolve().then(() => cb("INITIAL_SESSION", session()));
        return { data: { subscription: { unsubscribe: () => { authListeners = authListeners.filter((l) => l !== cb); } } } };
      },
    },
    from(table: string) {
      return {
        select: (_cols: string) => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => {
              calls.selects.push(table);
              if (failures.selectOnce) {
                failures.selectOnce = false;
                return { data: null, error: { message: "select failed" } };
              }
              if (table !== "profiles") return { data: null, error: null };
              const row = profiles.get(val);
              return { data: row ? { settings: row.settings } : null, error: null };
            },
          }),
        }),
        upsert: async (payload: Record<string, unknown>, opts?: Record<string, unknown>) => {
          calls.upserts.push({ table, payload, opts });
          if (failures.upsertTimes > 0) {
            failures.upsertTimes -= 1;
            return { error: { message: "upsert failed" } };
          }
          if (table === "profiles") {
            profiles.set(String(payload.id), { id: String(payload.id), settings: payload.settings });
            return { error: null };
          }
          // runs: the unique(user_id, run_id) guard + ignoreDuplicates → an ambiguous retry no-ops
          const key = `${String(payload.user_id)}:${String(payload.run_id)}`;
          if (!runs.has(key) || opts?.ignoreDuplicates !== true) runs.set(key, payload);
          return { error: null };
        },
      };
    },
  };
}

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: (...args: unknown[]) =>
      mode === "real"
        ? (actual.createClient as unknown as (...a: unknown[]) => unknown)(...args)
        : makeMockClient(),
  };
});

/** dynamic import AFTER vi.resetModules() so each test gets one fresh module registry */
async function load() {
  const auth = await import("./auth.js");
  const settings = await import("../settings/settings.js");
  const store = await import("../ui/last-run.js");
  return { auth, settings, store };
}

/** microtask drain that also works while fake timers are installed */
async function flush(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    chartId: null,
    chartHash: "chart-hash",
    audioHash: null,
    score: 1000,
    maxCombo: 10,
    accuracy: 0.95,
    counts: { perfect: 9, great: 1, good: 0, miss: 0 },
    totalTargets: 10,
    rank: "A",
    playedAt: Date.now() - 1000,
    sessionOnly: false,
    ...over,
  };
}

const CONFIGURED: Array<[string, string]> = [
  ["NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co"],
  ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test"],
];

/** A test may not call `syncSettingsNow` before the session exists — establish one first.
 *  Uses the app shell's entry point so the write hook + run subscription are attached too. */
async function startSignedIn(userId: string): Promise<void> {
  const { auth } = await load();
  auth.initAuthAndAutomation();
  authUser = { id: userId, email: userId };
  emit("SIGNED_IN");
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  cleanup();
  localStorage.clear();
  profiles.clear();
  runs.clear();
  calls.selects = [];
  calls.upserts = [];
  calls.signIn = 0;
  calls.signUp = 0;
  calls.signOut = 0;
  failures.selectOnce = false;
  failures.upsertTimes = 0;
  authUser = null;
  authListeners = [];
  mode = "mock";
  for (const [k, v] of CONFIGURED) vi.stubEnv(k, v);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("guest zero-touch — the load-bearing invariant (Review Focus 4)", () => {
  it("a fresh guest build with the REAL client makes zero requests at startup and after a completed run", async () => {
    mode = "real";
    const fetchSpy = vi.fn(async () => {
      throw new Error("the guest path must not touch the network at all");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { auth, store } = await load();
    auth.initAuth(); // client construction is local-only; getSession on an empty store is a storage read
    await flush();
    expect(auth.isAuthenticated()).toBe(false);

    const stop = auth.startRunSync();
    store.lastRunStore.set(run({ sessionOnly: true })); // what the play page publishes for a guest
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    stop();
  });

  it("an unconfigured build creates no client at all and still runs the guest path", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const { auth, store } = await load();
    expect(auth.isSupabaseConfigured()).toBe(false);
    auth.initAuth();
    const stop = auth.startRunSync();
    store.lastRunStore.set(run({ sessionOnly: true }));
    await flush();
    expect(auth.settingsSyncClient()).toBeNull();
    expect(calls.upserts).toEqual([]);
    expect(auth.isAuthenticated()).toBe(false);
    stop();
  });

  it("a sessionOnly run published while signed in is still never uploaded (guest-era run)", async () => {
    const { auth, store } = await load();
    auth.initAuth();
    authUser = { id: "user-a@example.com", email: "a@example.com" };
    emit("SIGNED_IN");
    await flush();
    calls.upserts = [];
    store.lastRunStore.set(run({ sessionOnly: true }));
    await flush();
    expect(calls.upserts.filter((c) => c.table === "runs")).toEqual([]);
  });

  it("a guest's local settings edit makes no cloud call", async () => {
    const { auth, settings } = await load();
    auth.initAuth();
    await flush();
    calls.selects = [];
    calls.upserts = [];
    settings.setSetting("masterVolume", 0.5);
    await flush();
    expect(calls.selects).toEqual([]);
    expect(calls.upserts).toEqual([]);
  });
});

describe("session lifecycle (onAuthStateChange drives UI + sync eligibility)", () => {
  it("a persisted session is restored at startup and the settings channel is armed", async () => {
    authUser = { id: "user-a@example.com", email: "a@example.com" };
    const { auth } = await load();
    auth.initAuth();
    await flush();
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.currentUserId()).toBe("user-a@example.com");
    expect(auth.settingsSyncClient()).not.toBeNull();
    // the login trigger fired the merge: the profiles row was created from local settings
    expect(calls.upserts.some((c) => c.table === "profiles")).toBe(true);
    expect(profiles.get("user-a@example.com")).toBeTruthy();
  });

  it("sign-out clears auth state and sync eligibility, and later local edits stay local", async () => {
    authUser = { id: "user-a@example.com", email: "a@example.com" };
    const { auth, settings } = await load();
    auth.initAuth();
    await flush();

    await auth.signOut();
    emit("SIGNED_OUT");
    await flush();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.settingsSyncClient()).toBeNull();

    calls.selects = [];
    calls.upserts = [];
    settings.setSetting("musicVolume", 0.25);
    await flush();
    expect(calls.selects).toEqual([]);
    expect(calls.upserts).toEqual([]);
    expect(settings.getSetting("musicVolume")).toBe(0.25); // local-first: the edit survives sign-out
  });
});

describe("run upload — idempotent, bounded same-run retry, visible failure", () => {
  async function signedIn() {
    const loaded = await load();
    loaded.auth.initAuth();
    authUser = { id: "user-a@example.com", email: "a@example.com" };
    emit("SIGNED_IN");
    await flush();
    calls.upserts = [];
    const stop = loaded.auth.startRunSync();
    return { ...loaded, stop };
  }

  it("uploads once, with run_id/played_at from the RunResult and on-conflict no-op", async () => {
    const { auth, store } = await signedIn();
    const r = run();
    store.lastRunStore.set(r);
    await flush();
    const upload = calls.upserts.find((c) => c.table === "runs");
    expect(upload).toBeTruthy();
    expect(upload!.payload).toMatchObject({
      run_id: r.runId,
      user_id: "user-a@example.com",
      chart_hash: "chart-hash",
      score: 1000,
      played_at: new Date(r.playedAt).toISOString(),
    });
    expect(upload!.opts).toEqual({ onConflict: "user_id,run_id", ignoreDuplicates: true });
    expect(auth.getRunSyncError()).toBeNull();
  });

  it("the same runId published twice leaves ONE row (ambiguous retry is a no-op)", async () => {
    const { store } = await signedIn();
    const r = run();
    store.lastRunStore.set(r);
    await flush();
    store.lastRunStore.set(r);
    await flush();
    expect(runs.size).toBe(1);
  });

  it("a failing upload retries the SAME runId (1 s / 4 s, 3 attempts) then surfaces run-sync-error", async () => {
    const { auth, store } = await signedIn();
    failures.upsertTimes = 3; // all three attempts fail
    const r = run({ runId: "22222222-2222-4222-8222-222222222222" });
    vi.useFakeTimers();
    store.lastRunStore.set(r);
    await flush();
    expect(calls.upserts.filter((c) => c.table === "runs")).toHaveLength(1); // attempt 1, no backoff yet

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.upserts.filter((c) => c.table === "runs")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4000);
    const attempts = calls.upserts.filter((c) => c.table === "runs");
    expect(attempts).toHaveLength(3);
    // every attempt targets THIS runId — a resend can never duplicate or substitute a run
    expect(new Set(attempts.map((c) => c.payload.run_id))).toEqual(new Set([r.runId]));
    await flush();
    expect(auth.getRunSyncError()).toEqual({ runId: r.runId, message: expect.stringContaining("Score sync failed") });
    expect(runs.has(`user-a@example.com:${r.runId}`)).toBe(false);
  });

  it("recovers within the retry window and clears the error", async () => {
    const { auth, store } = await signedIn();
    failures.upsertTimes = 2;
    const r = run({ runId: "33333333-3333-4333-8333-333333333333" });
    vi.useFakeTimers();
    store.lastRunStore.set(r);
    await flush();
    await vi.advanceTimersByTimeAsync(1000); // attempt 2 fails
    await vi.advanceTimersByTimeAsync(4000); // attempt 3 succeeds
    await flush();
    expect(runs.has(`user-a@example.com:${r.runId}`)).toBe(true);
    expect(auth.getRunSyncError()).toBeNull();
  });

  it("a LATER run never retries the old one, and clears the stale notice", async () => {
    const { auth, store } = await signedIn();
    failures.upsertTimes = 3;
    const failed = run({ runId: "44444444-4444-4444-8444-444444444444" });
    vi.useFakeTimers();
    store.lastRunStore.set(failed);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(auth.getRunSyncError()?.runId).toBe(failed.runId);

    const later = run({ runId: "55555555-5555-4555-8555-555555555555" });
    store.lastRunStore.set(later);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(runs.has(`user-a@example.com:${later.runId}`)).toBe(true);
    expect(runs.has(`user-a@example.com:${failed.runId}`)).toBe(false); // the old run is not resurrected
    expect(auth.getRunSyncError()).toBeNull(); // a new run supersedes the stale notice
  });

  it("rejects a playedAt in the future and an epoch timestamp without uploading", async () => {
    const { auth, store } = await signedIn();
    expect(auth.isValidPlayedAt(Date.now() + 10 * 60 * 1000)).toBe(false);
    expect(auth.isValidPlayedAt(0)).toBe(false);
    expect(auth.isValidPlayedAt(Date.now() - 1000)).toBe(true);

    const future = run({ runId: "66666666-6666-4666-8666-666666666666", playedAt: Date.now() + 10 * 60 * 1000 });
    store.lastRunStore.set(future);
    await flush();
    expect(calls.upserts.filter((c) => c.table === "runs")).toEqual([]);
    expect(auth.getRunSyncError()?.runId).toBe(future.runId);

    const epoch = run({ runId: "77777777-7777-4777-8777-777777777777", playedAt: 0 });
    store.lastRunStore.set(epoch);
    await flush();
    expect(calls.upserts.filter((c) => c.table === "runs")).toEqual([]);
  });

  it("stops retrying if the user signs out mid-flight", async () => {
    const { auth, store } = await signedIn();
    failures.upsertTimes = 3;
    const r = run({ runId: "88888888-8888-4888-8888-888888888888" });
    vi.useFakeTimers();
    store.lastRunStore.set(r);
    await flush();
    authUser = null;
    emit("SIGNED_OUT");
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(calls.upserts.filter((c) => c.table === "runs")).toHaveLength(1); // no signed-out retry
  });
});

describe("settings sync — remote payload handling", () => {
  it("a malformed non-NULL remote document reports invalid-remote and leaves local untouched", async () => {
    authUser = { id: "user-a@example.com", email: "a@example.com" };
    profiles.set("user-a@example.com", { id: "user-a@example.com", settings: { nonsense: { value: 1 } } });
    const { auth, settings } = await load();
    auth.initAuth();
    await flush();
    const before = localStorage.getItem(settings.SETTINGS_KEY);
    calls.upserts = [];
    const outcome = await auth.syncSettingsNow();
    expect(outcome).toEqual({ ok: false, reason: "invalid-remote" });
    expect(localStorage.getItem(settings.SETTINGS_KEY)).toBe(before); // never overwritten
    expect(calls.upserts.filter((c) => c.table === "profiles")).toEqual([]);
    expect(profiles.get("user-a@example.com")!.settings).toEqual({ nonsense: { value: 1 } });
  });

  it("treats settings IS NULL as an empty remote document and initializes the row (first login)", async () => {
    const { auth, settings } = await load();
    settings.setSetting("masterVolume", 0.42); // local edit before the first sync
    profiles.set("user-new@example.com", { id: "user-new@example.com", settings: null });
    await startSignedIn("user-new@example.com");
    calls.upserts = [];
    const outcome = await auth.syncSettingsNow();
    expect(outcome.ok).toBe(true);
    const stored = profiles.get("user-new@example.com")!.settings as Record<string, { value: unknown }>;
    expect(stored.masterVolume?.value).toBe(0.42); // local merged in and persisted
  });

  it("creates the profiles row when it does not exist yet (first login, no row)", async () => {
    const { auth } = await load();
    expect(profiles.has("user-none@example.com")).toBe(false); // nothing on the server yet
    await startSignedIn("user-none@example.com"); // login sync upserts create-or-merge
    expect(profiles.has("user-none@example.com")).toBe(true);
    const outcome = await auth.syncSettingsNow();
    expect(outcome.ok).toBe(true);
  });

  it("a remote-won deviceCalibrationOffsetMs reaches the gameplay read path", async () => {
    const remoteDoc = {
      deviceCalibrationOffsetMs: { value: -120, rev: 99, deviceId: "other-device", writeId: "w-1" },
    };
    profiles.set("user-b@example.com", { id: "user-b@example.com", settings: remoteDoc });
    const { auth } = await load();
    await startSignedIn("user-b@example.com");
    const outcome = await auth.syncSettingsNow();
    expect(outcome.ok).toBe(true);
    // loadCalibration (judgeDt's read path) sees the remote-won value without a /settings edit
    const { loadCalibration } = await import("../calibration-store.js");
    expect(loadCalibration()).toBe(-120);
  });

  it("fire the sync on login, on a debounced local edit while signed in, and manually", async () => {
    const { auth, settings } = await load();
    vi.useFakeTimers();
    await startSignedIn("user-c@example.com");
    expect(calls.upserts.some((c) => c.table === "profiles")).toBe(true); // (1) login/session-restore

    calls.selects = [];
    settings.setSetting("sfxVolume", 0.3); // (2) debounced local edit
    await flush();
    expect(calls.selects).toEqual([]); // not immediate
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(calls.selects.filter((t) => t === "profiles").length).toBeGreaterThan(0);

    calls.selects = [];
    await auth.syncSettingsNow(); // (3) manual
    expect(calls.selects.filter((t) => t === "profiles").length).toBeGreaterThan(0);
  });

  it("does not debounce-sync a local edit while signed out", async () => {
    const { auth, settings } = await load();
    vi.useFakeTimers();
    auth.initAuthAndAutomation(); // the hook IS attached, exactly as the app shell attaches it
    await flush();
    calls.selects = [];
    calls.upserts = [];
    settings.setSetting("sfxVolume", 0.3);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(calls.selects).toEqual([]);
    expect(calls.upserts).toEqual([]);
  });
});

describe("/settings deferred notice", () => {
  it("clears on the next ok:true sync and is shown for every non-ok outcome", async () => {
    const { auth } = await load();
    await startSignedIn("user-d@example.com");
    const SettingsPage = (await import("../app/settings/page.js")).default;
    render(createElement(SettingsPage));

    const syncBtn = await screen.findByTestId("settings-sync-now");
    expect(screen.queryByTestId("settings-sync-deferred")).toBeNull();

    failures.selectOnce = true; // the channel itself fails
    fireEvent.click(syncBtn);
    expect(await screen.findByTestId("settings-sync-deferred")).toBeTruthy();

    fireEvent.click(syncBtn);
    await waitFor(() => expect(screen.queryByTestId("settings-sync-deferred")).toBeNull());
    await expect(auth.syncSettingsNow()).resolves.toMatchObject({ ok: true });
  });
});
