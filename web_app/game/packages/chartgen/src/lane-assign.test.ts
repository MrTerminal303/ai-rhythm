import { describe, expect, it } from "vitest";
import {
  assignLanes,
  computeLaneSeed,
  enforceNoteDensity,
  laneSeedInput,
  mulberry32,
  selectDensity,
  type NoteDraft,
} from "./lane-assign.js";
import type { Onset } from "./flux-v1.js";

/**
 * T25 (B8b) lane assignment — PLAN §13.2 step 7 verbatim + Q27 chord cap.
 *
 * The laneSeed formula is pinned character-for-character: any drift in the
 * canonical JSON (key order, defaults) changes every generated chart, so the
 * test recomputes the digest independently with WebCrypto.
 */

const audioHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const options = { targetNps: 7, density: 0 };

describe("laneSeed — SHA-256(canonical UTF-8 JSON({audioHash, generationOptions, generatorId, generatorVersion}))", () => {
  it("builds the canonical JSON with code-unit-sorted keys and resolved option defaults", () => {
    expect(laneSeedInput(audioHash, options)).toBe(
      `{"audioHash":"${audioHash}","generationOptions":{"density":0,"targetNps":7},"generatorId":"flux-v1","generatorVersion":"1"}`,
    );
  });

  it("derives the PRNG seed from the first 4 digest bytes (big-endian uint32)", async () => {
    const canonical = laneSeedInput(audioHash, options);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
    );
    const expected = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
    await expect(computeLaneSeed(audioHash, options)).resolves.toBe(expected);
  });

  it("is stable across option objects with the same resolved values", async () => {
    const a = await computeLaneSeed(audioHash, { targetNps: 7, density: 0 });
    const b = await computeLaneSeed(audioHash, { targetNps: 7, density: 0 });
    expect(a).toBe(b);
    expect(a).not.toBe(await computeLaneSeed(audioHash, { targetNps: 5, density: 0 }));
  });
});

describe("mulberry32 — the shared seeded PRNG", () => {
  it("is deterministic and stays in [0, 1)", () => {
    const a = mulberry32(123456);
    const b = mulberry32(123456);
    for (let i = 0; i < 32; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("different seeds diverge", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("selectDensity — keep the highest-confidence onsets until targetNps", () => {
  const crowded: Onset[] = Array.from({ length: 40 }, (_, i) => ({ tMs: i * 100, confidence: 0.5 }));

  it("keeps at most targetNps onsets in every rolling 1 s window", () => {
    const kept = selectDensity(crowded, 7);
    for (const o of kept) {
      const inWindow = kept.filter((k) => k.tMs >= o.tMs && k.tMs < o.tMs + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(7);
    }
  });

  it("prefers the higher-confidence onsets when a window is over budget", () => {
    const onsets: Onset[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ tMs: i * 40, confidence: 0.9 })),
      ...Array.from({ length: 13 }, (_, i) => ({ tMs: 400 + i * 40, confidence: 0.1 })),
    ];
    const kept = selectDensity(onsets, 7);
    expect(kept).toHaveLength(7);
    for (const o of kept) expect(o.confidence).toBeCloseTo(0.9, 10);
  });

  it("is deterministic", () => {
    expect(selectDensity(crowded, 7)).toEqual(selectDensity(crowded, 7));
  });
});

describe("assignLanes — jack cap, chord cap (Q27), non-adjacent chord lanes", () => {
  const onsets: Onset[] = Array.from({ length: 400 }, (_, i) => ({ tMs: i * 100, confidence: 0.5 }));
  const seeded = (): NoteDraft[] => assignLanes(onsets, mulberry32(20261019), { chordProbability: 0.2 });

  it("emits only lanes 0..3", () => {
    for (const n of seeded()) expect([0, 1, 2, 3]).toContain(n.lane);
  });

  it("never emits 3 consecutive same-lane single taps", () => {
    const byTime = groupByTime(seeded());
    let lastLane = -1;
    let run = 0;
    for (const group of byTime) {
      if (group.length > 1) {
        run = 0; // a chord breaks the tap run
        lastLane = -1;
        continue;
      }
      const lane = group[0]!.lane;
      if (lane === lastLane) run++;
      else {
        lastLane = lane;
        run = 1;
      }
      expect(run).toBeLessThanOrEqual(2);
    }
  });

  it("clamps chords to 2 notes and never pairs adjacent lanes", () => {
    const chords = groupByTime(seeded()).filter((g) => g.length > 1);
    expect(chords.length).toBeGreaterThan(0); // the cap is meaningful, not vacuous
    for (const chord of chords) {
      expect(chord).toHaveLength(2); // Q27: clamp to 2
      expect(chord[0]!.lane).not.toBe(chord[1]!.lane);
      expect(Math.abs(chord[0]!.lane - chord[1]!.lane)).toBeGreaterThanOrEqual(2);
    }
  });

  it("same onsets + same PRNG seed → identical note list", () => {
    expect(seeded()).toEqual(seeded());
  });

  it("holds are ≥ 250 ms and never overlap on their lane", () => {
    const notes = assignLanes(onsets, mulberry32(4242), { chordProbability: 0, holdProbability: 0.5, holdDurationMs: 300 });
    const holds = notes.filter((n) => n.type === "hold");
    expect(holds.length).toBeGreaterThan(0);
    const byLane = new Map<number, Array<{ t: number; end: number }>>();
    for (const h of holds) {
      expect(h.d!).toBeGreaterThanOrEqual(250);
      const list = byLane.get(h.lane) ?? [];
      for (const other of list) expect(h.t >= other.end || other.t >= h.t + h.d!).toBe(true);
      list.push({ t: h.t, end: h.t + h.d! });
      byLane.set(h.lane, list);
    }
  });
});

describe("enforceNoteDensity — chord partners cannot push a window over the cap", () => {
  it("brings every rolling 1 s window to ≤ targetNps, deterministically", () => {
    const onsets: Onset[] = Array.from({ length: 200 }, (_, i) => ({ tMs: i * 100, confidence: 0.5 }));
    const notes = assignLanes(onsets, mulberry32(9), { chordProbability: 0.4 });
    const dense = enforceNoteDensity(notes, 7);
    for (const n of dense) {
      expect(dense.filter((m) => m.t >= n.t && m.t < n.t + 1000).length).toBeLessThanOrEqual(7);
    }
    expect(enforceNoteDensity(notes, 7)).toEqual(dense);
  });
});

function groupByTime(notes: NoteDraft[]): NoteDraft[][] {
  const groups: NoteDraft[][] = [];
  for (const n of notes) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.t === n.t) last.push(n);
    else groups.push([n]);
  }
  return groups;
}
