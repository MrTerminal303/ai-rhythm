// @vitest-environment node
// W3 T25b fix r1 — the /import page's Generate wiring, at the PAGE level.
//
// This pins the three behaviours the browser journey could not pin cheaply:
// - the Generate button's enable rule (audio && !submitting && !generating && !done);
// - re-picking the audio ABORTS the in-flight run (review r1 finding 4: the old
//   run used to finish and publish its chart against the NEW selection);
// - the generated chart is STORED through the canonical boundary (review r1
//   finding 1: a stored generated row must carry `tier` like every imported row).
//
// The generator is STUBBED (`vi.mock` on @airhythm/chartgen): the real one drives
// a Worker and an AudioContext, neither of which exists here. The stub still
// exercises the real page code — the abort, the boundary and the store call all
// run for real. The stub's candidate chart has a TIER-LESS note, exactly as
// `assembleChart` emits, so the boundary row fails if the canonicalization is
// skipped.
//
// ENVIRONMENT: the node env + `setup-dom.js` (jsdom DOM for RTL) is the
// repo's established pattern for a page that touches the T18 store — see
// `library/library.test.tsx` for why the store's `crypto.subtle.digest` hashing
// path needs Node's webcrypto and a node-realm ArrayBuffer.
import "../../library/setup-dom.js";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_E2E = "1";

/** The generator stub: records the calls; `holdGenerate` keeps a run in flight. */
type GenerateCall = { audioHash: string; signal?: AbortSignal; timeoutMs?: number };
const generateCalls: GenerateCall[] = [];
let holdGenerate: ((value: unknown) => void) | null = null;

vi.mock("@airhythm/chartgen", async () => {
  const real = await vi.importActual<typeof import("@airhythm/chartgen")>("@airhythm/chartgen");
  const chart = {
    version: 1,
    meta: { title: "Generated chart", artist: "flux-v1", creator: "flux-v1", difficulty: "auto", tags: ["flux-v1"], previewMs: 0 },
    song: { songKey: "file:x", durationMs: 1000, audioOffsetMs: 0 },
    timing: [{ t: 0, bpm: 120, meter: 4 }],
    keys: 4,
    notes: [{ id: 0, t: 0, lane: 0, type: "tap" }],
    pulses: [],
    gen: { source: "ai", model: "flux-v1", timingSource: "manual" },
  };
  return {
    ...real,
    fluxV1: {
      id: "flux-v1",
      generate: (_audio: unknown, opts: GenerateCall) => {
        generateCalls.push(opts);
        if (holdGenerate) return new Promise((resolve) => { holdGenerate = resolve; });
        return Promise.resolve({
          chart,
          generatorId: "flux-v1",
          generatorVersion: "1",
          audioHash: opts.audioHash,
          seed: 1,
          targetNps: 7,
          density: 0,
          timingSource: "manual",
        });
      },
    },
  };
});

/** A minimal AudioContext — the page decodes the picked file in one. */
class FakeAudioContext {
  state = "running";
  async decodeAudioData(): Promise<unknown> {
    return { duration: 1, sampleRate: 44_100, numberOfChannels: 1, length: 44_100 };
  }
  close(): void {
    this.state = "closed";
  }
}
Object.defineProperty(globalThis, "AudioContext", { value: FakeAudioContext, configurable: true });

import ImportPage from "./page.js";

/** A small WAV file — the page only reads its name/size and decodes it. */
function makeAudioFile(name = "song.wav"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "audio/wav" });
}

function pickAudio(input: HTMLInputElement, name = "song.wav"): void {
  Object.defineProperty(input, "files", { value: [makeAudioFile(name)], configurable: true });
  fireEvent.change(input);
}

describe("/import — the Generate button", () => {
  beforeEach(() => {
    generateCalls.length = 0;
    holdGenerate = null;
  });
  afterEach(() => {
    cleanup();
  });

  it("is DISABLED without an audio selection and ENABLED once one is picked", async () => {
    render(<ImportPage />);
    const generate = screen.getByTestId("generate-button") as HTMLButtonElement;
    expect(generate.disabled).toBe(true);

    pickAudio(screen.getByTestId("import-audio-input") as HTMLInputElement);
    await waitFor(() => expect((screen.getByTestId("generate-button") as HTMLButtonElement).disabled).toBe(false));
  });

  it("does NOT require a chart file — Generate runs on audio alone", async () => {
    render(<ImportPage />);
    pickAudio(screen.getByTestId("import-audio-input") as HTMLInputElement);
    await waitFor(() => expect((screen.getByTestId("generate-button") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId("generate-button"));
    await waitFor(() => expect(generateCalls).toHaveLength(1));
    // No chart file was ever set on the form.
    expect((screen.getByTestId("import-file-input") as HTMLInputElement).files).toHaveLength(0);
  });

  it("re-picking the audio ABORTS the in-flight run (review r1 finding 4)", async () => {
    render(<ImportPage />);
    const input = screen.getByTestId("import-audio-input") as HTMLInputElement;
    pickAudio(input);
    await waitFor(() => expect((screen.getByTestId("generate-button") as HTMLButtonElement).disabled).toBe(false));

    // Hold the generator open so the run is genuinely in flight.
    holdGenerate = () => undefined;
    fireEvent.click(screen.getByTestId("generate-button"));
    await waitFor(() => expect(generateCalls).toHaveLength(1));
    const signal = generateCalls[0]!.signal!;
    expect(signal.aborted).toBe(false);

    // Re-pick the audio → the in-flight run is aborted.
    pickAudio(input, "other.wav");
    await waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("STORES the generated chart through the canonical boundary (every note carries `tier`)", async () => {
    // The reviewer's r1 finding 1: the page handed `candidate.chart` straight to the
    // store, so a generated row had NO `tier` on its notes while every imported
    // row had `tier: "primary"` — two chartJson conventions, two chartHash
    // conventions. The stub's candidate chart has a tier-less note (as
    // `assembleChart` emits), so this row fails if the boundary is skipped.
    render(<ImportPage />);
    pickAudio(screen.getByTestId("import-audio-input") as HTMLInputElement);
    await waitFor(() => expect((screen.getByTestId("generate-button") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId("generate-button"));
    await waitFor(() => expect(screen.getByTestId("import-done")).toBeTruthy());

    // Read the stored row back out of the T18 store.
    const { listCharts } = await import("../../library/db.js");
    const rows = await listCharts(undefined, { verifyAudio: false });
    const generated = rows.find((r) => r.title === "Generated chart");
    expect(generated, "the generated chart was stored").toBeTruthy();
    const stored = JSON.parse(generated!.chartJson) as { notes: Array<{ tier?: string }> };
    expect(stored.notes.length).toBeGreaterThan(0);
    for (const n of stored.notes) expect(n.tier).toBe("primary");
  });
});
