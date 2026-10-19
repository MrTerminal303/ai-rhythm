"use client";

// W3 T23 (B6): arms the auth session listener and both sync channels for the WHOLE app.
//
// It lives in the root layout rather than on /auth because the settings triggers are not
// /auth-scoped: a user who restored a session last visit and lands straight on /settings (or
// finishes a run on /play) must still get the login-merge and the debounced local-edit sync.
// Renders nothing; `initAuthAndAutomation` is idempotent, so Strict Mode's double mount is safe.
import { useEffect } from "react";
import { initAuthAndAutomation } from "./auth.js";

export default function AuthBootstrap() {
  useEffect(() => {
    initAuthAndAutomation();
  }, []);
  return null;
}
