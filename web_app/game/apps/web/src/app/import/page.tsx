"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { canonicalizeBeatmap } from "@airhythm/shared";
import { importChartWithAudio, sha256Hex, type AudioMeta } from "../../library/db.js";
import { canonicalizeGeneratedChart } from "./generate-boundary.js";
import { decideGenerateUi, GENERATE_TIMEOUT_MS, GENERATOR_ID, type GenerateUiDecision } from "./generate-q10.js";
import { runFluxV1 } from "./generate-run.js";

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

// W3 T25b fix r1 — the e2e seam (same NEXT_PUBLIC_E2E gate as `__lib` / `__w2`).
declare global {
  interface Window {
    __importTest?: {
      /** Set the Q10 budget the NEXT generation run uses (ms). */
      setTimeoutMs(ms: number): void;
      /** The highest progress percentage reported so far (0 when no run started). */
      progressPeak(): number;
      /** How many generation runs have been STARTED on this page. */
      generationCount(): number;
    };
  }
}

export default function ImportPage() {
  const [audio, setAudio] = useState<AudioPick | null>(null);
  const [chart, setChart] = useState<ChartPick | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ chartId: string; source: "import" | "generate" } | null>(null);
  // W3 T25 (B8b) — Generate-with-flux-v1 state. `generating` gates the button, `progress`
  // is the 0..100 percentage the generator reports, `genDecision` is the Q10 failure surface
  // (Retry / Cancel), and `abortRef` holds the AbortController for the in-flight run.
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  // W3 T25b fix r1 — the Q10 decision is stored WHOLE, not just its message: the
  // pure `decideGenerateUi` table decides whether the error block, Retry and Cancel
  // are shown, so the decision module is load-bearing rather than advisory.
  const [genDecision, setGenDecision] = useState<GenerateUiDecision | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // W3 T25b fix r1 — the CURRENTLY selected audio (the same object the `audio`
  // state holds). A generation run captures the pick it started with and checks
  // this ref before it stores its chart: if the user re-picked the audio in the
  // meantime, the chart belongs to a selection that no longer exists and is
  // discarded instead of landing in the library.
  const audioRef = useRef<AudioPick | null>(null);
  // W3 T25b fix r1 — the Q10 budget the NEXT run uses. It lives in a REF, not in
  // state, so the e2e seam can set it SYNCHRONOUSLY: a state update would need a
  // re-render before the next run could read it, and the run could start first.
  const timeoutMsRef = useRef(GENERATE_TIMEOUT_MS);
  // The generator's progress is reported in percentages; the seam records the
  // HIGHEST value seen so a fast run cannot be missed by a polling observer.
  const progressPeakRef = useRef(0);
  // How many generation runs have been STARTED — the e2e seam reads it to prove
  // that Retry really starts ANOTHER run.
  const generationCountRef = useRef(0);
  // .osz archives with >1 difficulty stay in pending state; the user picks one, then parses.
  const [difficulties, setDifficulties] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState("");
  const [pending, setPending] = useState<{ entries: Map<string, Uint8Array> | null; text: string | null }>({
    entries: null,
    text: null,
  });

  // W3 T25 (B8b): unmounting mid-generation aborts the run — the Worker is terminated
  // by the generator's own cleanup path, so no orphan keeps streaming chunks.
  useEffect(() => () => abortRef.current?.abort(), []);

  // W3 T25b fix r1 — the e2e seam. Same NEXT_PUBLIC_E2E gate as the library
  // page's `__lib` and the play page's `__w2` (inlined at build by the
  // Playwright webServer's NEXT_PUBLIC_E2E=1). It lets the journey drive the
  // Q10 over-budget path with a TINY budget — the only honest way to observe
  // Retry / Cancel in a browser, since a real 240 s track finishes inside the
  // 20 s budget. Production builds leave it unset → the seam is absent.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_E2E === "1") {
      window.__importTest = {
        setTimeoutMs: (ms: number) => {
          timeoutMsRef.current = ms;
        },
        progressPeak: () => progressPeakRef.current,
        generationCount: () => generationCountRef.current,
      };
    }
  }, []);

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
    // W3 T25b fix r1: a NEW pick ABORTS the in-flight run. Without this the old
    // run kept going and its `setDone` fired against the new selection — the
    // user would be handed a chart built from the file they just replaced.
    abortRef.current?.abort();
    setError(null);
    setAudio(null);
    audioRef.current = null;
    setDone(null);
    setGenDecision(null); // W3 T25b fix r1: a fresh pick clears the previous generation failure
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
      const pick: AudioPick = {
        file,
        durationMs,
        meta: { durationMs, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels },
      };
      audioRef.current = pick;
      setAudio(pick);
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
      setDone({ chartId, source: "import" });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ---- W3 T25 (B8b) — Generate with flux-v1: audio only, no chart file needed.
  //
  // The selected `File` is RE-DECODED here in a FRESH AudioContext: `onAudioChange`
  // closes its own context and keeps only the metadata, and a decoded AudioBuffer is
  // never held in React state. The audioHash is computed over the SAME ArrayBuffer
  // bytes that `importChartWithAudio` hashes, so the chart's songKey/audioHash agree.
  const runGenerate = async (): Promise<void> => {
    // The ref is the guard, not the state: `generating` in this closure is the value
    // from the render that produced the handler, so two rapid clicks could both pass
    // a state check. `abortRef.current` is set synchronously, before any await, and
    // it is CLEARED by the `finally` below — so it marks "a run is in flight".
    if (!audio || abortRef.current !== null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    generationCountRef.current++;
    setGenerating(true);
    setGenDecision(null);
    setProgress(0);
    progressPeakRef.current = 0;
    let ctx: AudioContext | null = null;
    // The pick this run belongs to. If the user re-picks the audio while the run
    // is in flight, `audioRef.current` no longer points at this object and the
    // run's result is discarded instead of being published for the new pick.
    const pick = audio;
    try {
      const audioBytes = await pick.file.arrayBuffer();
      // `decodeAudioData` DETACHES the ArrayBuffer it is handed — so it gets a COPY.
      // The original `audioBytes` must survive intact: it is what gets hashed (here and
      // again inside `importChartWithAudio`) and what the library stores.
      const audioHash = await sha256Hex(audioBytes);
      ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(audioBytes.slice(0));
      const candidate = await runFluxV1(buffer, {
        audioHash,
        timeoutMs: timeoutMsRef.current,
        signal: controller.signal,
        onProgress: (pct) => {
          progressPeakRef.current = Math.max(progressPeakRef.current, pct);
          setProgress(pct);
        },
      });
      // Persist through the SAME boundary as an imported chart — one validation
      // boundary, one atomic store write, one Play link.
      //
      // W3 T25b fix r1: the chart is CANONICALIZED first. `assembleChart` emits
      // notes with no `tier`; every imported row carries `tier: "primary"`. Without
      // this the two origins had different chartJson shapes (and so different
      // chartHash conventions). The canonicalization belongs HERE — at the store
      // boundary — and not in the pure package (R24).
      // The user re-picked the audio while this run was in flight → the chart
      // belongs to a selection that no longer exists. Discard it BEFORE it is
      // stored, so no orphan library row is created for a replaced file. (The
      // abort in `onAudioChange` already stopped the generation; this covers the
      // window where it had already finished generating.)
      if (audioRef.current !== pick) return;
      const { chartId } = await importChartWithAudio({
        chart: canonicalizeGeneratedChart(candidate.chart),
        audioBytes,
        audioMeta: pick.meta,
      });
      setDone({ chartId, source: "generate" });
    } catch (err) {
      // Q10: a failure (or the budget) is a VISIBLE state with Retry / Cancel —
      // never a silent generator switch. flux-v1 stays the only generator.
      // The DECISION is the pure `decideGenerateUi` table (unit-tested); this is
      // only the wiring. A USER-initiated cancel is not a failure: the run simply
      // stops (the progress block disappears and Generate re-enables). The
      // generator's own budget timeout does NOT set the abort flag, so it
      // surfaces here as a failure with a `timeout` code.
      const decision = decideGenerateUi({ cancelled: controller.signal.aborted, error: err });
      setGenDecision(decision.showError ? decision : null);
    } finally {
      abortRef.current = null;
      if (ctx && ctx.state !== "closed") void ctx.close();
      setGenerating(false);
    }
  };

  // Cancel: aborts the AbortController of the in-flight run (the generator's own
  // cleanup terminates the Worker) and dismisses a surfaced failure. The two Cancel
  // buttons share the testid but never coexist — a run clears `genDecision` before it
  // sets `generating`, and the failure block only renders when no run is in flight.
  const cancelGenerate = (): void => {
    abortRef.current?.abort();
    setGenDecision(null);
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

      {/* W3 T25 (B8b): Generate with flux-v1 — a REAL run of the fallback generator.
          Audio only: a chart file is NOT required (journey 6 uploads audio alone). */}
      <button
        type="button"
        data-testid="generate-button"
        onClick={() => void runGenerate()}
        disabled={!audio || submitting || generating || done !== null}
        className="w-fit cursor-pointer rounded-[6px] border px-6 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        {generating ? "Generating…" : "Generate with flux-v1"}
      </button>

      {generating && (
        <div data-testid="generate-progress" className="flex flex-col gap-1 text-sm">
          <p style={{ color: "var(--text-dim)" }}>Generating… {Math.round(progress)}%</p>
          <progress value={progress} max={100} />
          {/* Cancel aborts the AbortController of the in-flight run. The error block's
              Cancel carries the same testid, but the two never coexist: a run clears
              `genDecision` before it sets `generating`. */}
          <button
            type="button"
            data-testid="generate-cancel"
            onClick={cancelGenerate}
            className="w-fit cursor-pointer rounded-[6px] border px-6 py-3 text-sm"
            style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
          >
            Cancel
          </button>
        </div>
      )}

      {genDecision?.showError && (
        // Q10: a failed or over-budget generation is a VISIBLE state offering Retry and
        // Cancel. flux-v1 is the only generator and stays the one used — never a silent
        // switch to another generator. `data-generator` names the generator the run
        // actually used, so the "no silent switch" rule is observable in the DOM.
        <div
          data-testid="generate-error"
          data-generator={GENERATOR_ID}
          role="alert"
          className="flex flex-col gap-2 text-sm"
        >
          <p style={{ color: "var(--warn)" }}>{genDecision.message}</p>
          <div className="flex gap-3">
            {genDecision.showRetry && (
              <button
                type="button"
                data-testid="generate-retry"
                onClick={() => void runGenerate()}
                className="w-fit cursor-pointer rounded-[6px] border px-6 py-3 text-sm"
                style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--you)" }}
              >
                Retry
              </button>
            )}
            {genDecision.showCancel && (
              <button
                type="button"
                data-testid="generate-cancel"
                onClick={cancelGenerate}
                className="w-fit cursor-pointer rounded-[6px] border px-6 py-3 text-sm"
                style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {done && (
        <div className="flex flex-col gap-3" data-testid="import-done">
          <p data-testid="import-summary">
            {done.source === "generate" ? "Chart generated." : "Import complete."}
          </p>
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
