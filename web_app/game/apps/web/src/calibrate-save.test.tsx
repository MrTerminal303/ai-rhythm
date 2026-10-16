// @vitest-environment jsdom
// A9 (W3 T13): failed save never reports persisted.
// onSave wraps saveCalibration in try/catch, then READS BACK localStorage.getItem(CALIBRATION_KEY)
// and compares; success → "Saved", any throw/mismatch → save-error message, label stays "Save".
// The unit test forces localStorage.setItem to throw (quota) and asserts NO "Saved" state and the
// save-error testid is present.
//
// The test seam on the calibrate page is gated on NEXT_PUBLIC_E2E (a build-time inline). This
// unit test flips the equivalent dev-process check via process.env BEFORE importing the page.
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// A9 seam gate: the page reads process.env.NEXT_PUBLIC_E2E at render time (dev build).
// In vitest the process env is live, so set it here — no build inlining needed.
process.env.NEXT_PUBLIC_E2E = "1";

import CalibratePage from "./app/calibrate/page.js";

// A9 test seam: the calibrate page exposes window.__calibrateTest.seedResult to drive it to a
// done-with-result state without running the metronome (AudioContext/keydown are inexpressible in
// jsdom). The brief permits "expose a debug seam OR call onSave through a rendered Save button".
function seedResult(v: number | null): void {
  const seam = (window as { __calibrateTest?: { seedResult(x: number | null): void } }).__calibrateTest;
  expect(seam, "window.__calibrateTest seam must exist (A9)").toBeTruthy();
  seam!.seedResult(v);
}

describe("A9 calibrate save never reports persisted on failure", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  // The seam persists on `window` and captures the FIRST mount's setters. To seed the
  // CURRENT mount, re-render AFTER seeding so the button belongs to the instance whose
  // state we just changed. (The seam is a no-op once set, so re-seeding is safe.)
  function mountAndSeed(v: number): void {
    render(<CalibratePage />);
    seedResult(v);
  }

  it("failed save (quota) never reports Saved; save-error shown, label stays Save", () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
    mountAndSeed(12); // a valid calibration value → Save button renders
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(saveBtn);
    // A9 contract: the quota failure must never be reported as persisted.
    expect(setItemSpy).toHaveBeenCalled();
    expect(screen.queryByText(/^Saved$/)).toBeNull(); // NEVER "Saved"
    expect(screen.getByTestId("save-error")).toBeTruthy(); // failure affordance shown
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy(); // label stays "Save"
  });

  it("successful save reports Saved and no save-error", () => {
    mountAndSeed(-8);
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(saveBtn);
    // A9 read-back: localStorage.getItem must confirm the persisted value.
    expect(screen.getByText(/^Saved$/)).toBeTruthy();
    expect(screen.queryByTestId("save-error")).toBeNull();
    const stored = localStorage.getItem("deviceCalibrationOffsetMs");
    expect(stored).toBe("-8"); // read-back compared the stored value to the result
  });
});
