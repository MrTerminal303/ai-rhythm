// W3 T23 (B6): the Supabase auth + sync channel.
//
// THE LOAD-BEARING INVARIANT (spec §4 guest policy, Review Focus 4): a guest performs ZERO
// cloud reads/writes. Instantiating the client is NOT a network act — `createClient` is
// local-only and `getSession()` on an empty storage is a localStorage read — so the client
// may exist at startup. Every call that could touch the network is gated on a session that
// actually exists, or on an explicit user action. Guest-era runs are never queued: only a run
// completed WHILE authenticated ever enters the upload path, so nothing can be uploaded later.
//
// Auth is a singleton BY DESIGN: there is exactly one session for the page, and every other
// module reads it through this one. `initAuth` is idempotent, so React Strict Mode's double
// effect cannot create a second subscription.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { lastRunStore, type RunResult } from "../ui/last-run.js";
import {
  InvalidRemoteSettingsError,
  getSetting,
  setSettingsWriteHook,
  settingsDocIsEnvelopeMap,
  syncSettings,
  type SettingsMap,
  type SettingsSyncClient,
  type SettingsSyncOutcome,
} from "../settings/settings.js";
import { adoptRemoteCalibration } from "../calibration-store.js";

export interface RunSyncError {
  runId: string;
  message: string;
}

/** The UI-facing slice of auth state. One cached object, rebuilt only on a real change, so
 *  `useSyncExternalStore` gets a stable identity between renders. */
export interface AuthSnapshot {
  userId: string | null;
  email: string | null;
  runSyncError: RunSyncError | null;
}

/** Winner-first out-of-order guard: an older run's failure must not undo a newer run's notice. */
interface StampedError extends RunSyncError {
  playedAt: number;
}

export const RUN_SYNC_FAILED_MESSAGE = "Score sync failed — will not retry this run. Saved locally only.";
const RETRY_DELAYS_MS = [1000, 4000]; // bounded SAME-run retry: 3 attempts total
const SETTINGS_SYNC_DEBOUNCE_MS = 2000;
/** playedAt sanity window (brief round 4): not in the future, not before 2000-01-01 */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const EPOCH_FLOOR_MS = Date.UTC(2000, 0, 1);

let client: SupabaseClient | null = null;
let clientBuilt = false;
let initialized = false;
let currentUser: { id: string; email: string | null } | null = null;
let sessionPresent = false;
let authListenerAttached = false;
let runSyncStop: (() => void) | null = null;
let runSyncError: StampedError | null = null;
let settingsSyncTimer: ReturnType<typeof setTimeout> | null = null;
const EMPTY_SNAPSHOT: AuthSnapshot = { userId: null, email: null, runSyncError: null };
let snapshot: AuthSnapshot = EMPTY_SNAPSHOT;
const stateListeners = new Set<() => void>();

export function subscribeAuth(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export function getAuthSnapshot(): AuthSnapshot {
  return snapshot;
}

/** The server-side snapshot for useSyncExternalStore's hydration argument. */
export function getServerAuthSnapshot(): AuthSnapshot {
  return EMPTY_SNAPSHOT;
}

function notify(): void {
  snapshot = {
    userId: currentUser?.id ?? null,
    email: currentUser?.email ?? null,
    runSyncError: runSyncError === null ? null : { runId: runSyncError.runId, message: runSyncError.message },
  };
  for (const l of [...stateListeners]) l();
}

function env(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/** A build with no Supabase project configured is a valid GUEST-ONLY build (see next.config.ts). */
export function isSupabaseConfigured(): boolean {
  return env("NEXT_PUBLIC_SUPABASE_URL") !== "" && env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") !== "";
}

/**
 * The one place a client is built. Returns null when unconfigured (guest-only build) — callers
 * must treat that as "no cloud channel", never as an error. Never throws at module scope: a
 * page load must not depend on the cloud being configured.
 */
export function getClient(): SupabaseClient | null {
  if (clientBuilt) return client;
  clientBuilt = true; // only one construction attempt, success or failure
  if (!isSupabaseConfigured()) return null;
  try {
    client = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } catch (err) {
    console.error("[auth] Supabase client construction failed — continuing guest-only:", err);
    client = null;
  }
  return client;
}

export function isAuthenticated(): boolean {
  return currentUser !== null;
}

export function currentUserId(): string | null {
  return currentUser?.id ?? null;
}

export function getRunSyncError(): RunSyncError | null {
  return runSyncError === null ? null : { runId: runSyncError.runId, message: runSyncError.message };
}

function setRunSyncError(next: StampedError | null): void {
  runSyncError = next;
  notify();
}

/**
 * The one auth-state transition. `SIGNED_OUT` is the only thing that clears `currentUser` for
 * good — a token refresh re-fires with the same user and must not disturb sync eligibility.
 */
function applySession(user: { id: string; email?: string | null } | null): void {
  const wasAuthenticated = currentUser !== null;
  currentUser = user === null ? null : { id: user.id, email: user.email ?? null };
  if (currentUser === null) setRunSyncError(null); // a signed-out user has nothing to be told about
  else notify();
  // Login / session-restore is settings trigger (1). Sign-out is local-first: no cloud write.
  if (currentUser !== null && !wasAuthenticated) void syncSettingsNow();
}

/** Startup. Safe to call twice (Strict Mode) — the subscription and listeners attach once. */
export function initAuth(): void {
  if (initialized) return;
  initialized = true;
  const supabase = getClient();
  if (!supabase) return; // guest-only build: no session, no cloud channel, nothing to arm
  if (!authListenerAttached) {
    authListenerAttached = true;
    // (b) a persisted session is restored here and may refresh its token — the one startup
    // request a signed-in reload is allowed to make. (c) refresh/sign-out both land here.
    supabase.auth.onAuthStateChange((_event, session) => {
      sessionPresent = session !== null;
      applySession(session?.user ? { id: session.user.id, email: session.user.email } : null);
    });
  }
}

/** A session EXISTS (may still be refreshing). Used only by the sync client's guard. */
function hasSession(): boolean {
  return sessionPresent || currentUser !== null;
}

export async function signUp(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getClient();
  if (!supabase) return { ok: false, error: "Accounts are unavailable in this build." };
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return { ok: false, error: friendlyAuthError(error.message) };
  applySession({ id: (await supabase.auth.getUser()).data.user?.id ?? "", email });
  return { ok: true };
}

export async function signIn(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getClient();
  if (!supabase) return { ok: false, error: "Accounts are unavailable in this build." };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: friendlyAuthError(error.message) };
  applySession({ id: data.user?.id ?? "", email: data.user?.email ?? email });
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;
  await supabase.auth.signOut();
  sessionPresent = false;
  applySession(null);
}

/** Never surface a raw provider string: it can carry stack-ish detail and is not actionable. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return "Email or password is incorrect.";
  if (m.includes("already registered")) return "That email is already registered — try signing in.";
  if (m.includes("password")) return "Password must be at least 6 characters.";
  if (m.includes("email")) return "Enter a valid email address.";
  if (m.includes("rate") || m.includes("too many")) return "Too many attempts — wait a moment and try again.";
  return "Sign-in failed. Check your connection and try again.";
}

/**
 * `played_at` is sent EXPLICITLY from RunResult.playedAt so a delayed or retried upload keeps
 * the real play time (the column default is a fallback only) — which means it must be
 * validated, or a clock-skewed client could write nonsense history. Rejects a timestamp more
 * than 5 minutes in the future and anything before 2000-01-01 (0 = "unset", not "1970").
 */
export function isValidPlayedAt(playedAt: number): boolean {
  return (
    Number.isFinite(playedAt) && playedAt >= EPOCH_FLOOR_MS && playedAt <= Date.now() + MAX_FUTURE_SKEW_MS
  );
}

/**
 * One insert attempt. `onConflict: "user_id,run_id"` + `ignoreDuplicates: true` makes ANY
 * resend of the same run (ambiguous timeout, retry, double delivery) a no-op instead of a
 * duplicate row — the whole reason runId is minted once at completion.
 */
async function uploadRun(run: RunResult, userId: string): Promise<string | null> {
  const supabase = getClient();
  if (!supabase || !hasSession()) return "sync channel unavailable";
  const { error } = await supabase.from("runs").upsert(
    {
      run_id: run.runId,
      user_id: userId,
      chart_hash: run.chartHash,
      audio_hash: run.audioHash,
      score: run.score,
      accuracy: run.accuracy,
      max_combo: run.maxCombo,
      judgements: run.counts,
      played_at: new Date(run.playedAt).toISOString(),
    },
    { onConflict: "user_id,run_id", ignoreDuplicates: true },
  );
  return error ? error.message : null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function syncRun(run: RunResult): Promise<void> {
  const userId = currentUser?.id;
  if (!userId) return; // signed out mid-flight — never upload as nobody
  if (!isValidPlayedAt(run.playedAt)) {
    // A rejected timestamp is not retried: the same payload would be rejected again.
    console.error("[runs] refusing upload — implausible playedAt:", run.playedAt);
    setRunSyncError({ runId: run.runId, message: RUN_SYNC_FAILED_MESSAGE, playedAt: run.playedAt });
    return;
  }
  let failure = await uploadRun(run, userId);
  if (failure === null) {
    // A sync that succeeds supersedes a stale failure notice for an EARLIER run.
    if (runSyncError !== null && runSyncError.runId !== run.runId) setRunSyncError(null);
    return;
  }
  console.error("[runs] sync failed:", failure);
  for (const delayMs of RETRY_DELAYS_MS) {
    await sleep(delayMs);
    if (!isAuthenticated()) return; // a retry must not run on a signed-out page
    failure = await uploadRun(run, userId);
    if (failure === null) {
      // Recovered on the SAME runId — no duplicate was possible, so clear any stale notice.
      if (runSyncError !== null && runSyncError.runId !== run.runId) setRunSyncError(null);
      return;
    }
    console.error("[runs] retry failed:", failure);
  }
  // Out of attempts for THIS run. The notice is a real error state, not a console line; it is
  // keyed to this runId so a later, different completion can never be mistaken for its retry.
  setRunSyncError({ runId: run.runId, message: RUN_SYNC_FAILED_MESSAGE, playedAt: run.playedAt });
  console.error("[runs] giving up on run", run.runId);
}

/**
 * Subscribe to completed runs. Returns an unsubscribe function.
 *
 * The guest gate is here and it is absolute: `run.sessionOnly` is true for every run completed
 * while signed out, and those runs are dropped — never queued, never uploaded later (Review
 * Focus 4). A FAILED upload is not queued either: only the failed run's own bounded retry runs,
 * and a later run with a different runId never substitutes for it.
 */
export function startRunSync(): () => void {
  if (runSyncStop) return runSyncStop; // one subscription per page, not one per effect run
  runSyncStop = lastRunStore.subscribe((run) => {
    if (!run || run.sessionOnly || !isAuthenticated()) return;
    void syncRun(run);
  });
  return runSyncStop;
}

// ── settings channel (separate from the score channel) ──────────────────────────────────────

/** Remote profile document for one user, or null when the row/column is uninitialized. */
async function readRemoteSettings(userId: string): Promise<SettingsMap | null> {
  const supabase = getClient();
  if (!supabase) return null;
  const { data, error } = await supabase.from("profiles").select("settings").eq("id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  const raw = (data as { settings: unknown } | null)?.settings;
  // settings IS NULL = EMPTY/UNINITIALIZED document (first-login row) — the normal first-login
  // path, not an error. The local document merges in and the row ends initialized.
  if (raw === null || raw === undefined) return null;
  // Non-NULL must be a valid envelope map, or the local document is NOT overwritten.
  if (!settingsDocIsEnvelopeMap(raw)) throw new InvalidRemoteSettingsError();
  return raw;
}

/**
 * One `profiles` row per user; upsert with `onConflict: "id"` CREATES it on first login (the
 * RLS `with check` clause, not the client, is what keeps it owner-only).
 */
async function writeRemoteSettings(userId: string, settings: SettingsMap): Promise<void> {
  const supabase = getClient();
  if (!supabase) throw new Error("no client");
  const { error } = await supabase.from("profiles").upsert({ id: userId, settings }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

/** Null when there is no cloud channel for this user — `syncSettings` reports `network`. */
export function settingsSyncClient(): SettingsSyncClient | null {
  const userId = currentUser?.id;
  if (!userId || !hasSession()) return null;
  return {
    read: () => readRemoteSettings(userId),
    write: (settings: SettingsMap) => writeRemoteSettings(userId, settings),
  };
}

/**
 * Settings trigger (3): manual "Sync now" — and the shared body of trigger (1) (login).
 *
 * `syncSettings` owns read → merge → write → re-read; this adds the B6 concern D36 left open:
 * after a CONFIRMED sync, a remote-won `deviceCalibrationOffsetMs` is adopted into the gameplay
 * read path (see `adoptRemoteCalibration`). Deliberately after the sync: mirroring mid-sync would
 * bump the envelope's rev underneath the sync loop.
 */
export async function syncSettingsNow(): Promise<SettingsSyncOutcome> {
  const outcome = await syncSettings(settingsSyncClient());
  if (outcome.ok) adoptRemoteCalibration(getSetting("deviceCalibrationOffsetMs"));
  return outcome;
}

/**
 * Settings trigger (2): a local edit while authenticated debounces (2 s) into a sync. The hook
 * is on `setSetting` — the single funnel every local edit passes through — so no page has to
 * remember to call it. The `isAuthenticated()` gate is what keeps a signed-out page at zero
 * cloud calls: the hook stays attached, but it does nothing until a session exists.
 */
function attachSettingsWriteHook(): void {
  setSettingsWriteHook(() => {
    if (!isAuthenticated()) return;
    if (settingsSyncTimer !== null) clearTimeout(settingsSyncTimer);
    settingsSyncTimer = setTimeout(() => {
      settingsSyncTimer = null;
      void syncSettingsNow();
    }, SETTINGS_SYNC_DEBOUNCE_MS);
  });
}

/** Called once by the app shell when the app mounts (see `auth-bootstrap.tsx`). */
export function attachAuthAutomation(): void {
  attachSettingsWriteHook();
  startRunSync();
}

/** Attach the startup path once the app shell mounts (Strict Mode safe). */
export function initAuthAndAutomation(): void {
  initAuth();
  attachAuthAutomation();
  // A9-style test seam (same NEXT_PUBLIC_E2E gate the calibrate page uses): the run-sync error
  // region can only be reached in a browser with a live Supabase project, so the committed e2e
  // drives it through here to prove the notice really renders — visible, keyed to the runId,
  // and clearable — under the production CSP. Inlined away in production builds.
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_E2E === "1") {
    (window as unknown as { __authTest?: unknown }).__authTest = {
      forceRunSyncError: (err: RunSyncError | null) =>
        setRunSyncError(err === null ? null : { ...err, playedAt: Date.now() }),
    };
  }
}
