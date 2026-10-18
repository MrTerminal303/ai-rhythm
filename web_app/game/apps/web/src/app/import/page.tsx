"use client";

import { useState } from "react";
import Link from "next/link";
import { canonicalizeBeatmap } from "@airhythm/shared";
import { importChartWithAudio, type AudioMeta } from "../../library/db.js";

type ImportWarning = { code: string; message: string };

// W3 T20 (B3): durable upload flow. /import validates + decodes audio and chart files, then
// stores through the T18 library store (importChartWithAudio). The W2 sessionStorage hand-off
// is GONE — Play links via /play?libraryChartId=<id>.

// Q18 caps: audio ≤ 10 MB and ≤ 6 min. .osz gate mirrors osz-import's DEFAULT_ZIP_LIMITS
// (100 MB); .osu text files stay at 10 MB (beatmaps are KB-scale).
const AUDIO_EXTENSIONS = [".mp3", ".ogg", ".wav", ".m4a", ".webm"] as const;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_MS = 6 * 60 * 1000;
// DECODED-MEMORY CAP (round 3 P2): the file-size/duration limits do NOT bound PCM — after
// decodeAudioData, reject when decoded.numberOfChannels > 2 OR decoded.length × channels >
// 40_000_000 samples (~160 MB of f32 PCM). The committed 240 s mono fixtures sit far below.
const MAX_DECODED_CHANNELS = 2;
const MAX_DECODED_SAMPLES = 40_000_000;
const MAX_OSU_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OSZ_FILE_BYTES = 100 * 1024 * 1024;

const MISSING_AUDIO_SONG_KEY = "file:missing-audio";

// W2 contract carried over: archive audio is hashed for songKey only — never stored, never played.
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
    if (base === target) {
      const copy = new Uint8Array(bytes); // ArrayBuffer-backed copy — satisfies BufferSource typing
      const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
      return `file:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return MISSING_AUDIO_SONG_KEY;
}

interface AudioPick {
  file: File;
  durationMs: number;
  meta: AudioMeta;
}
interface ChartPick {
  parsed: unknown; // canonicalized Beatmap (or the object the store's parseBeatmap accepts)
  warnings: ImportWarning[];
}

export default function ImportPage() {
  const [audio, setAudio] = useState<AudioPick | null>(null);
  const [chart, setChart] = useState<ChartPick | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ chartId: string } | null>(null);
  // .osz archives with >1 difficulty stay in pending state; the user picks one, then parses.
  const [difficulties, setDifficulties] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState("");
  const [pending, setPending] = useState<{ entries: Map<string, Uint8Array> | null; text: string | null }>({
    entries: null,
    text: null,
  });

  const fail = (msg: string): void => {
    setError(msg);
    setChart(null);
    setDone(null);
  };

  // ---- audio: extension + size gates, then decode in a THROWAWAY AudioContext (Q18 caps +
  // the authoritative decoded-memory cap live at this decoder boundary — see module caps).
  const onAudioChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setError(null);
    setAudio(null);
    setDone(null);
    const name = file.name.toLowerCase();
    const ext = name.slice(name.lastIndexOf("."));
    if (!(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
      fail(`Unsupported audio type "${ext}" — expected .mp3, .ogg, .wav, .m4a, or .webm`);
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      fail(`Audio too large (${(file.size / (1024 * 1024)).toFixed(1)} MB) — limit is ${MAX_AUDIO_BYTES / (1024 * 1024)} MB`);
      return;
    }
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      const durationMs = decoded.duration * 1000;
      if (durationMs > MAX_AUDIO_MS) {
        fail(`Audio longer than 6:00 (Q18) — got ${Math.ceil(durationMs / 1000)}s`);
        return;
      }
      // DECODED-MEMORY CAP: authoritative at this decoder boundary (round 3 P2).
      if (decoded.numberOfChannels > MAX_DECODED_CHANNELS) {
        fail(`Audio has ${decoded.numberOfChannels} channels — only ${MAX_DECODED_CHANNELS} (mono/stereo) are supported`);
        return;
      }
      if (decoded.length * decoded.numberOfChannels > MAX_DECODED_SAMPLES) {
        fail(`Audio exceeds the decoded-memory cap (~160 MB of PCM) — ${decoded.length} samples × ${decoded.numberOfChannels} ch > ${MAX_DECODED_SAMPLES}`);
        return;
      }
      setAudio({
        file,
        durationMs,
        meta: { durationMs, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels },
      });
    } catch (err) {
      fail(`Could not decode audio: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (ctx && ctx.state !== "closed") void ctx.close();
    }
  };

  // ---- chart: .osu → parseOsu (A8 line-number messages flow through verbatim); .osz →
  // extractOsz + listOsuDifficulties (>1 → pick one); canonicalize → the object importChartWithAudio stores.
  const runParse = async (text: string, entries: Map<string, Uint8Array> | null): Promise<void> => {
    // Relative dynamic import: @airhythm/beatmap-formats is a sibling workspace package not
    // declared in @airhythm/web's dependencies (Files list forbids touching package.json).
    const { parseOsu, candidateFromParsed } = await import("../../../../../packages/beatmap-formats/src/index.js");
    const parsed = parseOsu(text); // throws (mode/4K violations) → caller catches
    const songKey = await songKeyFor(parsed.audioFilename, entries);
    const beatmap = canonicalizeBeatmap(candidateFromParsed(parsed, songKey));
    setChart({ parsed: beatmap, warnings: parsed.warnings });
  };

  const resetChartState = (): void => {
    setChart(null);
    setDifficulties([]);
    setDifficulty("");
    setPending({ entries: null, text: null });
    setDone(null);
    setError(null);
  };

  const onChartChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    resetChartState();
    const name = file.name.toLowerCase();
    const sizeCap = name.endsWith(".osz") ? MAX_OSZ_FILE_BYTES : MAX_OSU_FILE_BYTES;
    try {
      if (file.size > sizeCap) {
        fail(`file too large — limit is ${Math.round(sizeCap / (1024 * 1024))} MB`);
        return;
      }
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
      fail(`Unsupported chart type "${name.slice(name.lastIndexOf("."))}" — expected .osu or .osz`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
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
      setDone(null);
      await runParse(text, pending.entries);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- submit: both selected → importChartWithAudio (single-transaction atomic store write)
  const onSubmit = async (): Promise<void> => {
    if (!audio || !chart || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const audioBytes = await audio.file.arrayBuffer();
      const { chartId } = await importChartWithAudio({
        chart: chart.parsed,
        audioBytes,
        audioMeta: audio.meta, // decode already happened for the Q18 caps (T18 metadata contract)
      });
      setDone({ chartId });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">Import</h1>

      <label className="flex flex-col gap-1 text-sm" style={{ color: "var(--text-dim)" }}>
        Audio file (.mp3 / .ogg / .wav / .m4a / .webm, ≤ 10 MB, ≤ 6:00)
        <input
          type="file"
          accept={AUDIO_EXTENSIONS.join(",")}
          onChange={(e) => void onAudioChange(e)}
          data-testid="import-audio-input"
          style={{ color: "var(--text)" }}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm" style={{ color: "var(--text-dim)" }}>
        Chart file (.osu / .osz)
        <input
          type="file"
          accept=".osu,.osz"
          onChange={(e) => void onChartChange(e)}
          data-testid="import-file-input"
          style={{ color: "var(--text)" }}
        />
      </label>

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

      {audio && !done && (
        <p data-testid="audio-selected" className="text-sm" style={{ color: "var(--text-dim)" }}>
          Audio: {audio.file.name} ({(audio.durationMs / 1000).toFixed(1)} s)
        </p>
      )}
      {chart && (
        <div data-testid="import-warnings">
          {chart.warnings.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-dim)" }}>
              Chart: {String((chart.parsed as { meta?: { title?: string } }).meta?.title ?? "parsed")} — no warnings
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm" style={{ color: "var(--text-dim)" }}>
              {chart.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`}>
                  <code style={{ color: "var(--warn)" }}>{w.code}</code> — {w.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {audio && chart && !done && (
        <button
          type="button"
          onClick={() => void onSubmit()}
          disabled={submitting}
          data-testid="import-submit"
          className="w-fit cursor-pointer rounded-[6px] border px-6 py-3 text-lg disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface)",
            color: "var(--you)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {submitting ? "Importing…" : "Import"}
        </button>
      )}

      {/* T25 NotAvailableGenerator affordance (PLAN §13.2): disabled stub until the flux-v1
          convert backend exists. */}
      <button
        type="button"
        data-testid="generate-disabled"
        disabled
        title="AI convert not available yet"
        className="w-fit cursor-not-allowed rounded-[6px] border px-6 py-3 text-sm opacity-40"
        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        Generate with flux-v1
      </button>

      {done && (
        <div className="flex flex-col gap-3" data-testid="import-done">
          <p data-testid="import-summary">Import complete.</p>
          <div className="flex gap-3">
            <Link
              href={`/play?libraryChartId=${done.chartId}`}
              className="rounded-[6px] border px-6 py-3 text-lg"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface)",
                color: "var(--you)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Play
            </Link>
            <Link
              href="/library"
              className="rounded-[6px] border px-6 py-3 text-lg"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface)",
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Library
            </Link>
          </div>
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
