// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Hud } from "./hud.js";
import type { GameSnapshot } from "../engine/types.js";

// RTL auto-cleanup only registers when a global `afterEach` exists; vitest runs
// without `globals: true`, so DOM from earlier renders would leak into later tests
afterEach(cleanup);

const snap: GameSnapshot = {
  chartTimeMs: 1000,
  score: 123_456,
  combo: 7,
  accuracy: 0.95,
  frozen: false,
  endTimeMs: 60_000,
  noteStates: [],
  events: [{ type: "hit", grade: "perfect", lane: 0, dt: 5, noteId: 3 }],
};

describe("Hud (B4: engine event → HUD text)", () => {
  it("renders score, combo, accuracy, popup, key labels", () => {
    render(<Hud snapshot={snap} activeLanes={[]} />);
    expect(screen.getByText("123,456")).toBeTruthy();
    expect(screen.getByText(/COMBO 7/)).toBeTruthy();
    expect(screen.getByText("95.00%")).toBeTruthy();
    expect(screen.getByText("PERFECT")).toBeTruthy();
    for (const k of ["D", "F", "J", "K"]) expect(screen.getByText(k)).toBeTruthy();
  });

  it("miss event renders MISS popup, combo 0 shown", () => {
    render(
      <Hud
        snapshot={{ ...snap, combo: 0, events: [{ type: "miss", lane: 2, chartTime: 900 }] }}
        activeLanes={[]}
      />,
    );
    expect(screen.getByText("MISS")).toBeTruthy();
    expect(screen.getByText(/COMBO 0/)).toBeTruthy();
  });

  it("null snapshot renders zeroed HUD with keys", () => {
    render(<Hud snapshot={null} activeLanes={[]} />);
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText("0.00%")).toBeTruthy();
    expect(screen.getByText(/COMBO 0/)).toBeTruthy();
    expect(screen.queryByText(/PERFECT/)).toBeNull();
  });

  it("popup survives the next frame's empty events (HUD-state retention)", () => {
    const { rerender } = render(<Hud snapshot={snap} activeLanes={[]} />);
    expect(screen.getByText("PERFECT")).toBeTruthy();
    rerender(<Hud snapshot={{ ...snap, chartTimeMs: 1016, events: [] }} activeLanes={[]} />);
    expect(screen.getByText("PERFECT")).toBeTruthy(); // still within POPUP_MS
  });

  it("chord: two lanes lit simultaneously (J+K both styled active)", () => {
    render(<Hud snapshot={snap} activeLanes={[1, 2]} />);
    const styleOf = (k: string) => screen.getByText(k).getAttribute("style") ?? "";
    expect(styleOf("F")).toContain("var(--you)"); // lane 1
    expect(styleOf("J")).toContain("var(--you)"); // lane 2 — second keydown not overwritten
    expect(styleOf("D")).toContain("var(--surface)"); // lane 0 idle
    expect(styleOf("K")).toContain("var(--surface)"); // lane 3 idle
  });
});
