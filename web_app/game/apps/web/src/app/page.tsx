import { GAME_NAME } from "@airhythm/shared";
import Link from "next/link";

export default function Landing() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-semibold tracking-tight">{GAME_NAME}</h1>
      <Link
        href="/play"
        className="rounded-[10px] border px-6 py-3 text-sm"
        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--you)" }}
      >
        Play solo
      </Link>
      <Link
        href="/calibrate"
        className="rounded-[10px] border px-6 py-3 text-sm"
        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        Calibrate
      </Link>
      <Link
        href="/import"
        className="rounded-[10px] border px-6 py-3 text-sm"
        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        Import
      </Link>
      <Link
        href="/library"
        className="rounded-[10px] border px-6 py-3 text-sm"
        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        Library
      </Link>
      <Link
        href="/settings"
        className="rounded-[10px] border px-6 py-3 text-sm"
        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        Settings
      </Link>
      <p className="text-sm" style={{ color: "var(--text-dim)" }}>
        4-key rhythm game — D F J K
      </p>
    </main>
  );
}
