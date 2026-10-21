"use client";

// W3 T23 (B6): /auth — sign in, sign up, sign out. Guest stays the DEFAULT path: nothing here
// runs until the user acts, and the landing page is unchanged for a visitor who never comes here.
//
// The session is read through useSyncExternalStore so the page follows onAuthStateChange —
// one store, one subscription, no per-page auth polling.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  getAuthSnapshot,
  getServerAuthSnapshot,
  initAuthAndAutomation,
  isSupabaseConfigured,
  signIn,
  signOut,
  signUp,
  subscribeAuth,
} from "../../auth/auth.js";

const CARD = { borderColor: "var(--line)", background: "var(--surface)" } as const;
const FIELD_CLASS =
  "w-full rounded-[6px] border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--you)]";

export default function AuthPage() {
  const auth = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getServerAuthSnapshot);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    initAuthAndAutomation(); // idempotent; arms the session listener + the sync channels
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setNotice(null);
      setBusy(true);
      const result = mode === "signin" ? await signIn(email, password) : await signUp(email, password);
      if (!mountedRef.current) return;
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      setPassword("");
      // A confirmation-email project returns no session on sign-up; say so rather than
      // pretending the user is signed in.
      if (mode === "signup" && !getAuthSnapshot().userId) {
        setNotice("Check your email to confirm your account, then sign in.");
        setMode("signin");
      } else {
        setNotice("Signed in — settings will sync on this device.");
      }
    },
    [email, mode, password],
  );

  const doSignOut = useCallback(async () => {
    setError(null);
    setNotice(null);
    await signOut();
    if (mountedRef.current) setNotice("Signed out. Local settings are kept.");
  }, []);

  const configured = isSupabaseConfigured();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <h1 className="text-4xl font-semibold tracking-tight">Account</h1>

      {!configured && (
        <p
          data-testid="auth-unconfigured"
          className="max-w-md rounded-[10px] border px-4 py-3 text-center text-sm"
          style={{ ...CARD, color: "var(--text-dim)" }}
        >
          Accounts are not configured in this build — you can play as a guest. Your settings and runs
          stay on this device.
        </p>
      )}

      {auth.userId ? (
        <section className="flex w-full max-w-sm flex-col items-center gap-4" aria-label="Signed in">
          <p data-testid="auth-signed-in" className="text-sm" style={{ color: "var(--text)" }}>
            Signed in as <span style={{ fontFamily: "var(--font-mono)" }}>{auth.email ?? auth.userId}</span>
          </p>
          <button
            type="button"
            data-testid="auth-sign-out"
            onClick={() => void doSignOut()}
            className="cursor-pointer rounded-[10px] border px-6 py-3 text-sm"
            style={{ ...CARD, color: "var(--text)" }}
          >
            Sign out
          </button>
          <Link href="/settings" className="text-sm" style={{ color: "var(--text-dim)" }}>
            Settings and sync
          </Link>
        </section>
      ) : (
        <form
          onSubmit={(e) => void submit(e)}
          className="flex w-full max-w-sm flex-col gap-4 rounded-[10px] border p-6"
          style={CARD}
          aria-label={mode === "signin" ? "Sign in" : "Sign up"}
        >
          <h2 className="text-lg">{mode === "signin" ? "Sign in" : "Create an account"}</h2>

          <label className="flex flex-col gap-1 text-sm" htmlFor="auth-email">
            Email
            <input
              id="auth-email"
              type="email"
              data-testid="auth-email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={FIELD_CLASS}
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm" htmlFor="auth-password">
            Password
            <input
              id="auth-password"
              type="password"
              data-testid="auth-password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={FIELD_CLASS}
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
            />
          </label>

          {error && (
            <p role="alert" data-testid="auth-error" className="text-sm" style={{ color: "var(--warn)" }}>
              {error}
            </p>
          )}
          {notice && (
            <p role="status" data-testid="auth-notice" className="text-sm" style={{ color: "var(--text-dim)" }}>
              {notice}
            </p>
          )}

          <button
            type="submit"
            data-testid="auth-submit"
            disabled={busy || !configured}
            className="cursor-pointer rounded-[10px] border px-6 py-3 text-sm disabled:opacity-50"
            style={{ ...CARD, color: "var(--you)" }}
          >
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>

          <button
            type="button"
            data-testid="auth-toggle-mode"
            onClick={() => {
              setError(null);
              setNotice(null);
              setMode((m) => (m === "signin" ? "signup" : "signin"));
            }}
            className="cursor-pointer text-sm underline"
            style={{ color: "var(--text-dim)" }}
          >
            {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </form>
      )}

      <p className="text-center text-sm" style={{ color: "var(--text-dim)" }}>
        Playing as a guest always works — nothing is uploaded from a guest session.
      </p>
      <Link href="/" className="text-sm" style={{ color: "var(--text-dim)" }}>
        Back
      </Link>
    </main>
  );
}
