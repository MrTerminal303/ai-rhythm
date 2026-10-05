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
      <p className="text-sm" style={{ color: "var(--text-dim)" }}>
        4-key rhythm game — D F J K
      </p>
    </main>
  );
}
