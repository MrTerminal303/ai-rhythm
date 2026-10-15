import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlayPhaseMachine, PLAY_TRANSITIONS, type PlayPhase } from "./play-phase.js";

const ALL: PlayPhase[] = ["idle", "loading", "countdown", "playing", "paused", "recovering", "completed"];

describe("A12 play-phase machine", () => {
  it("every legal transition applies", () => {
    for (const from of ALL) {
      for (const to of PLAY_TRANSITIONS[from]) {
        const m = new PlayPhaseMachine(from);
        expect(m.to(to)).toBe(to);
        expect(m.current).toBe(to);
      }
    }
  });
  it("every other pair is rejected, state untouched (full 49-pair matrix)", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (PLAY_TRANSITIONS[from].includes(to)) continue;
        const m = new PlayPhaseMachine(from);
        expect(() => m.to(to)).toThrow(new RegExp(`illegal play-phase transition: ${from} → ${to}`));
        expect(m.current).toBe(from);
      }
    }
  });
  it("terminal-ish flow: idle→…→playing→completed→idle", () => {
    const m = new PlayPhaseMachine();
    m.to("loading"); m.to("countdown"); m.to("playing"); m.to("completed"); m.to("idle");
    expect(m.current).toBe("idle");
  });
});

describe("A12 grep gate — no ad-hoc phase sets in play/page.tsx", () => {
  const src = readFileSync(new URL("../app/play/page.tsx", import.meta.url), "utf8");
  it("no local Phase type alias", () => {
    expect(src).not.toMatch(/type\s+Phase\s*=/);
  });
  it("phaseRef is written only inside applyPhase (which delegates to the machine)", () => {
    // `phaseRef.current =` is a write; `===`, `!==`, `==` are comparisons (the trailing
    // `=` char of `===` would otherwise match `\s*=`). Exclude phaseMachineRef (the
    // machine ref is a separate variable) and anchor the right-hand side to be sure.
    const writes = src.replace(/phaseMachineRef\.current\s*=/g, "")
      .match(/phaseRef\.current\s*=[^=]/g) ?? [];
    expect(writes.length).toBe(1); // exactly the one line inside applyPhase
  });
  it("page imports the machine", () => {
    expect(src).toContain("PlayPhaseMachine");
    expect(src).toContain("PLAY_TRANSITIONS");
  });
});
