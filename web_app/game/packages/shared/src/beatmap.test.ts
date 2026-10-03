import { describe, expect, it } from "vitest";
import { parseBeatmap } from "./beatmap.js";
import type { Beatmap } from "./beatmap.js";
import { PULSE_DURATION_MS } from "./constants.js";

const base = (): Beatmap => ({
  version: 1,
  meta: { title: "T", artist: "A", creator: "C", difficulty: "D", tags: [], previewMs: 0 },
  song: { songKey: "file:test", durationMs: 60_000, audioOffsetMs: 0 },
  timing: [{ t: 0, bpm: 120, meter: 4 }],
  keys: 4,
  notes: [
    { id: 0, t: 500, lane: 0, type: "tap" },
    { id: 1, t: 1000, lane: 3, type: "tap", tier: "secondary" },
  ],
  pulses: [{ t: 0, s: 1, durationMs: 80 }],
  gen: { source: "manual", timingSource: "manual" },
});

describe("beatmap schema", () => {
  it("accepts a minimal valid chart", () => {
    const b = parseBeatmap(base());
    expect(b.notes).toHaveLength(2);
    expect(b.keys).toBe(4);
    // durationMs default applied to pulses (D4)
    expect(b.pulses[0]?.durationMs).toBe(80);
    // tier defaults to primary when omitted
    expect(b.notes[0]?.tier).toBeUndefined(); // schema leaves absent; canonicalization (W2) applies default
  });

  it("fills pulse durationMs from PULSE_DURATION_MS when omitted (D4)", () => {
    // input must lack durationMs — the fill can only fire when the field is absent
    const input: unknown = { ...base(), pulses: [{ t: 0, s: 1 }] };
    const b = parseBeatmap(input);
    expect(b.pulses[0]?.durationMs).toBe(PULSE_DURATION_MS);
  });

  it("rejects out-of-range lane", () => {
    const b = base();
    b.notes = [{ id: 0, t: 500, lane: 4, type: "tap" }];
    expect(() => parseBeatmap(b)).toThrow(/lane/i);
  });

  it("rejects duplicate note ids", () => {
    const b = base();
    b.notes = [
      { id: 7, t: 500, lane: 0, type: "tap" },
      { id: 7, t: 600, lane: 1, type: "tap" },
    ];
    expect(() => parseBeatmap(b)).toThrow(/duplicate|unique|id/i);
  });

  it("rejects keys !== 4", () => {
    const b = base();
    (b as { keys: number }).keys = 7;
    expect(() => parseBeatmap(b)).toThrow();
  });

  it("rejects tap after durationMs", () => {
    const b = base();
    b.notes = [{ id: 0, t: 60_001, lane: 0, type: "tap" }];
    expect(() => parseBeatmap(b)).toThrow(/duration|after/i);
  });

  it("rejects hold without d and overlapping holds in one lane", () => {
    const b = base();
    b.notes = [{ id: 0, t: 500, lane: 0, type: "hold" }];
    expect(() => parseBeatmap(b)).toThrow(/hold|duration/i);
    b.notes = [
      { id: 0, t: 500, lane: 0, type: "hold", d: 1000 },
      { id: 1, t: 1000, lane: 0, type: "hold", d: 500 },
    ];
    expect(() => parseBeatmap(b)).toThrow(/overlap/i);
  });

  it("rejects notes not sorted by t", () => {
    const b = base();
    b.notes = [
      { id: 0, t: 1000, lane: 0, type: "tap" },
      { id: 1, t: 500, lane: 1, type: "tap" },
    ];
    expect(() => parseBeatmap(b)).toThrow(/sort|order/i);
  });

  // duration-boundary invariants (schema implements them; pin each so a future edit can't drop one silently)
  it("rejects timing.t after song durationMs", () => {
    const b = base();
    b.timing = [{ t: 60_001, bpm: 120, meter: 4 }];
    expect(() => parseBeatmap(b)).toThrow(/timing|duration/i);
  });

  it("rejects pulse.t after song durationMs", () => {
    const b = base();
    b.pulses = [{ t: 60_001, s: 1, durationMs: 80 }];
    expect(() => parseBeatmap(b)).toThrow(/pulse|duration/i);
  });

  it("rejects hold ending after song durationMs", () => {
    const b = base();
    b.notes = [{ id: 0, t: 59_500, lane: 0, type: "hold", d: 1000 }]; // 59500 + 1000 > 60000
    expect(() => parseBeatmap(b)).toThrow(/duration|after/i);
  });

  it("rejects hold with non-positive d", () => {
    const b = base();
    b.notes = [{ id: 0, t: 500, lane: 0, type: "hold", d: 0 }];
    expect(() => parseBeatmap(b)).toThrow(/hold|d\b|positive/i);
  });
});
