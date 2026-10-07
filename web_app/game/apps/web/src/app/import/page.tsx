"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { canonicalJson, canonicalizeBeatmap, type Beatmap } from "@airhythm/shared";

type ImportWarning = { code: string; message: string };

const STORE_KEY = "w2-import";
const MISSING_AUDIO_SONG_KEY = "file:missing-audio";

// Size gates (W2 final security review C1): beatmaps are KB-scale, so 10 MB of text
// is already absurd — reject BEFORE file.text()/JSON.parse. The .osz gate mirrors
// DEFAULT_ZIP_LIMITS.maxCompressedBytes (100 MB); extractOsz re-checks internally.
// play/page.tsx mirrors MAX_TEXT_FILE_BYTES as MAX_IMPORT_JSON_CHARS (see comment there).
const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OSZ_FILE_BYTES = 100 * 1024 * 1024;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes); // ArrayBuffer-backed copy — satisfies BufferSource typing
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** W2 contract: archive audio is hashed for songKey only — never stored, never played. */
async function songKeyFor(
  audioFilename: string | null,
  entries: Map<string, Uint8Array> | null,
): Promise<string> {
  if (!audioFilename || !entries) return MISSING_AUDIO_SONG_KEY;
  const target = audioFilename.toLowerCase();
  for (const [name, bytes] of entries) {
    if (name.endsWith("/")) continue; // directory entry
    if (name.toLowerCase().endsWith(".osu")) continue;
    const base = name.split("/").pop()?.toLowerCase(); // archives often prefix paths
    if (base === target) return `file:${await sha256Hex(bytes)}`;
  }
  return MISSING_AUDIO_SONG_KEY;
}

export default function ImportPage() {
  const router = useRouter();
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);
  const [difficulty, setDifficulty] = useState("");
  const [difficulties, setDifficulties] = useState<string[]>([]);
  const [pending, setPending] = useState<{ entries: Map<string, Uint8Array> | null; text: string | null }>({
    entries: null,
    text: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [chart, setChart] = useState<Beatmap | null>(null); // non-null → import succeeded → Play available

  const fail = (err: unknown): void => {
    setError(err instanceof Error ? err.message : String(err));
    setChart(null);
    setWarnings([]);
  };

  const storeChart = (beatmap: Beatmap): void => {
    sessionStorage.setItem(STORE_KEY, canonicalJson(beatmap));
    setChart(beatmap);
  };

  // Relative dynamic import: @airhythm/beatmap-formats is a sibling workspace package
  // not declared in @airhythm/web's dependencies (Files list forbids touching package.json).
  const runParse = async (text: string, entries: Map<string, Uint8Array> | null): Promise<void> => {
    const { parseOsu, candidateFromParsed } = await import("../../../../../packages/beatmap-formats/src/index.js");
    const parsed = parseOsu(text); // throws (mode/4K violations) → caller catches
    const songKey = await songKeyFor(parsed.audioFilename, entries);
    const beatmap = canonicalizeBeatmap(candidateFromParsed(parsed, songKey));
    setWarnings(parsed.warnings);
    storeChart(beatmap);
  };

  const resetForNewFile = (): void => {
    setError(null);
    setChart(null);
    setWarnings([]);
    setDifficulty("");
    setDifficulties([]);
    setPending({ entries: null, text: null });
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    resetForNewFile();
    try {
      const name = file.name.toLowerCase();
      const sizeCap = name.endsWith(".osz") ? MAX_OSZ_FILE_BYTES : MAX_TEXT_FILE_BYTES;
      if (file.size > sizeCap) {
        fail(`file too large — limit is ${Math.round(sizeCap / (1024 * 1024))} MB`);
        return;
      }
      if (name.endsWith(".dbm.json")) {
        // canonical .dbm.json — already canonical, no warnings to derive
        storeChart(canonicalizeBeatmap(JSON.parse(await file.text())));
        return;
      }
      // extractOsz/listOsuDifficulties live in osz-import.ts, which the package index
      // does not re-export — import the source module directly (package.json untouched)
      if (name.endsWith(".osz")) {
        const { extractOsz, listOsuDifficulties } = await import(
          "../../../../../packages/beatmap-formats/src/osz-import.js"
        );
        const { entries } = extractOsz(new Uint8Array(await file.arrayBuffer()));
        const diffs = listOsuDifficulties(entries);
        if (diffs.length === 0) throw new Error("osz: no .osu difficulty inside archive");
        if (diffs.length === 1) {
          const bytes = entries.get(diffs[0]!);
          if (!bytes) throw new Error("osz: difficulty entry missing from archive");
          await runParse(new TextDecoder().decode(bytes), entries);
          return;
        }
        setDifficulties(diffs); // >1 → difficulty select; parse on user pick
        setPending({ entries, text: null });
        setDifficulty("");
        return;
      }
      if (name.endsWith(".osu")) {
        await runParse(await file.text(), null);
        return;
      }
      setError("Unsupported file type — expected .osu, .osz, or .dbm.json");
    } catch (err) {
      fail(err);
    }
  };

  const onDifficultyChange = async (value: string): Promise<void> => {
    setDifficulty(value);
    const bytes = pending.entries?.get(value);
    if (!bytes) return;
    const text = new TextDecoder().decode(bytes);
    setPending({ entries: pending.entries, text });
    try {
      setError(null);
      setChart(null);
      await runParse(text, pending.entries);
    } catch (err) {
      fail(err);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">Import</h1>
      <input
        type="file"
        accept=".osu,.osz,.dbm.json"
        onChange={(e) => void onFileChange(e)}
        data-testid="import-file-input"
        style={{ color: "var(--text)" }}
      />
      {error && (
        <p role="alert" data-testid="import-error" style={{ color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
          {error}
        </p>
      )}
      {difficulties.length > 1 && (
        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--text-dim)" }}>
          Difficulty
          <select
            value={difficulty}
            onChange={(e) => void onDifficultyChange(e.target.value)}
            data-testid="difficulty-select"
            className="rounded-[6px] border px-2 py-1"
            style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text)" }}
          >
            <option value="" disabled>
              Pick a difficulty…
            </option>
            {difficulties.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}
      {chart && (
        <div className="flex flex-col gap-3">
          <p data-testid="import-summary">
            Chart imported: {chart.meta.title} — {chart.meta.artist} [{chart.meta.difficulty}]
          </p>
          <div data-testid="import-warnings">
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-dim)" }}>
              Warnings
            </h2>
            {warnings.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-dim)" }}>
                No warnings.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm" style={{ color: "var(--text-dim)" }}>
                {warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`}>
                    <code style={{ color: "var(--warn)" }}>{w.code}</code> — {w.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => router.push("/play?import=1")}
            className="w-fit cursor-pointer rounded-[6px] border px-6 py-3 text-lg"
            style={{
              borderColor: "var(--line)",
              background: "var(--surface)",
              color: "var(--you)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Play
          </button>
          <p className="text-sm" style={{ color: "var(--text-dim)" }}>
            Playback uses the W2 click-track fixture (archive audio is not stored)
          </p>
        </div>
      )}
      <Link
        href="/"
        className="w-fit rounded-[10px] border px-6 py-3 text-sm"
        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        Back
      </Link>
    </main>
  );
}
