import { describe, expect, it } from "vitest";
import { DeviceChangeDetector } from "./device-change.js";

it("fires once when latency shifts >5 ms, not again while shifted", () => {
  let latency = 0.010;
  const d = new DeviceChangeDetector(() => latency);
  expect(d.observe()).toBe(false); // baseline
  latency = 0.045;
  expect(d.observe()).toBe(true); // shift
  expect(d.observe()).toBe(false); // still shifted, no repeat
});
it("re-arms after returning near baseline, fires on next shift", () => {
  let latency = 0.010;
  const d = new DeviceChangeDetector(() => latency);
  d.observe();
  latency = 0.045; expect(d.observe()).toBe(true);
  latency = 0.011; expect(d.observe()).toBe(false); // returned → re-arm
  latency = 0.050; expect(d.observe()).toBe(true);
});
it("missing latency never fires", () => {
  const d = new DeviceChangeDetector(() => undefined);
  for (let i = 0; i < 5; i++) expect(d.observe()).toBe(false);
});
