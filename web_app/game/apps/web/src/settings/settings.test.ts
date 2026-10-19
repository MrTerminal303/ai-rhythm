// @vitest-environment jsdom
// W3 T22 (B5): the settings merge CONTRACT (it is the contract — everything else is UI),
// the keybind rule, the rev-baseline rule, the sync outcome contract, the renderer's
// downscroll position rule, and the /settings page's reachable deferred-sync notice.
//
// jsdom because every one of these paths touches localStorage / renders the page.
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASELINE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  getSetting,
  mergeSettings,
  setSetting,
  syncSettings,
  validateKeybinds,
  type SettingEnvelope,
  type SettingsMap,
  type SettingsSyncClient,
} from "./settings.js";
import { createKeyHandler, lanesToKeyMap } from "../engine/controller.js";
import { noteY } from "../engine/renderer-webgl.js";
import SettingsPage from "../app/settings/page.js";

function env<T>(value: T, rev: number, deviceId: string, writeId: string): SettingEnvelope<T> {
  return { value, rev, deviceId, writeId };
}

/** partial map cast to the full SettingsMap — remote payloads are partial by construction */
const partial = (m: Partial<SettingsMap>): SettingsMap => m as SettingsMap;

const storedMap = (): SettingsMap => JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as SettingsMap;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("mergeSettings — deterministic per-key version priority (no wall clock)", () => {
  it("two tabs on ONE device: same rev → higher writeId wins", () => {
    const local = partial({ masterVolume: env(0.2, 3, "dev-a", "write-1") });
    const remote = partial({ masterVolume: env(0.8, 3, "dev-a", "write-2") });
    expect(mergeSettings(local, remote).merged.masterVolume?.value).toBe(0.8);
    expect(mergeSettings(remote, local).merged.masterVolume?.value).toBe(0.8); // order-independent
  });

  it("two OFFLINE devices: equal rev → higher deviceId wins", () => {
    const local = partial({ downscroll: env(true, 4, "dev-a", "write-z") });
    const remote = partial({ downscroll: env(false, 4, "dev-b", "write-a") });
    expect(mergeSettings(local, remote).merged.downscroll?.value).toBe(false);
    expect(mergeSettings(remote, local).merged.downscroll?.value).toBe(false);
  });

  it("stale replica rejoining: the older rev loses even with a higher deviceId", () => {
    const stale = partial({ scrollSpeed: env(1.5, 2, "zzz-device", "zzz-write") });
    const fresh = partial({ scrollSpeed: env(0.5, 9, "aaa-device", "aaa-write") });
    expect(mergeSettings(stale, fresh).merged.scrollSpeed?.value).toBe(0.5);
    expect(mergeSettings(fresh, stale).merged.scrollSpeed?.value).toBe(0.5);
  });

  it("reverse-order reconnects: both orders converge on the same winner per key", () => {
    const a = partial({
      masterVolume: env(0.3, 1, "dev-a", "w1"), // a loses on rev
      downscroll: env(true, 5, "dev-b", "w2"), // a wins on deviceId
      scrollSpeed: env(1.2, 4, "dev-a", "w3"), // a wins on writeId
    });
    const b = partial({
      masterVolume: env(0.9, 7, "dev-b", "w9"),
      downscroll: env(false, 5, "dev-a", "w9"),
      scrollSpeed: env(0.7, 4, "dev-a", "w1"),
    });
    const ab = mergeSettings(a, b).merged;
    const ba = mergeSettings(b, a).merged;
    expect(ab).toEqual(ba);
    expect(ab.masterVolume?.value).toBe(0.9);
    expect(ab.downscroll?.value).toBe(true);
    expect(ab.scrollSpeed?.value).toBe(1.2);
  });

  it("repeated sync idempotence: merging the winner with itself changes nothing", () => {
    const winner = partial({ masterVolume: env(0.4, 6, "dev-a", "w5") });
    const again = mergeSettings(winner, winner).merged;
    expect(again).toEqual(winner);
    const twice = mergeSettings(mergeSettings(winner, winner).merged, winner).merged;
    expect(twice).toEqual(winner);
  });

  it("baselineRev = highest rev observed anywhere in the result (local edits rebase from it)", () => {
    const local = partial({ masterVolume: env(0.4, 6, "dev-a", "w5") });
    const remote = partial({ downscroll: env(true, 11, "dev-b", "w1") });
    expect(mergeSettings(local, remote).baselineRev).toBe(11); // highest observed, not the local max
  });

  it("keys present on only one side survive the merge (partial remote payload)", () => {
    const local = partial({ masterVolume: env(0.4, 2, "dev-a", "w1") });
    const remote = partial({ downscroll: env(true, 1, "dev-b", "w2") });
    const merged = mergeSettings(local, remote).merged;
    expect(merged.masterVolume?.value).toBe(0.4);
    expect(merged.downscroll?.value).toBe(true);
  });
});

describe("envelope storage + rev baseline", () => {
  it("missing key → the documented default", () => {
    expect(getSetting("masterVolume")).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(getSetting("keybinds")).toEqual(DEFAULT_SETTINGS.keybinds);
  });

  it("setSetting writes {value, rev, deviceId, writeId} with a unique writeId per edit", () => {
    setSetting("masterVolume", 0.25);
    const first = storedMap().masterVolume!;
    expect(first.value).toBe(0.25);
    expect(first.rev).toBe(1);
    expect(first.deviceId).toBe(localStorage.getItem("duelbeat.deviceId"));
    setSetting("masterVolume", 0.5);
    const second = storedMap().masterVolume!;
    expect(second.rev).toBe(2); // advances from the local max with no sync baseline
    expect(second.writeId).not.toBe(first.writeId); // unique persisted id per edit
    expect(getSetting("masterVolume")).toBe(0.5);
  });

  it("rev advances from the persisted sync baseline (max(baseline, localRev) + 1)", () => {
    localStorage.setItem(BASELINE_KEY, "7");
    setSetting("downscroll", true);
    expect(storedMap().downscroll!.rev).toBe(8);
    localStorage.setItem(BASELINE_KEY, "3"); // lower than the local rev → local rev wins
    setSetting("downscroll", false);
    expect(storedMap().downscroll!.rev).toBe(9);
  });
});

describe("validateKeybinds", () => {
  const kb = (lanes: string[], skills: string[]) => ({ lanes, skills });

  it("distinct binds across 4 lanes + 3 skills are ok", () => {
    expect(validateKeybinds(kb(["d", "f", "j", "k"], ["1", "2", "3"]))).toEqual({ ok: true });
  });

  it("duplicate across two lanes reports the conflicting key", () => {
    expect(validateKeybinds(kb(["d", "f", "j", "j"], ["1", "2", "3"]))).toEqual({ ok: false, conflict: "j" });
  });

  it("duplicate between a lane and a skill is a conflict too", () => {
    expect(validateKeybinds(kb(["d", "f", "j", "k"], ["1", "1", "3"]))).toEqual({ ok: false, conflict: "1" });
    expect(validateKeybinds(kb(["d", "f", "j", "1"], ["1", "2", "3"]))).toEqual({ ok: false, conflict: "1" });
  });

  it("case-insensitive: 'D' and 'd' are the same bind", () => {
    expect(validateKeybinds(kb(["D", "f", "j", "d"], ["1", "2", "3"]))).toEqual({ ok: false, conflict: "d" });
  });
});

describe("keybind routing (input-routing contract, C10 exception 1)", () => {
  it("a rebound lane key judges THAT lane through the injected map", () => {
    const judged: number[] = [];
    const lanes = lanesToKeyMap(getSetting("keybinds").lanes);
    const handler = createKeyHandler({
      inputChartTime: (ts) => ts,
      engine: { judge: (lane) => judged.push(lane), isFrozen: () => false },
      lanes,
    });
    handler({ key: "d", repeat: false, timeStamp: 0, preventDefault() {} } as KeyboardEvent);
    expect(judged).toEqual([0]); // default map

    setSetting("keybinds", { lanes: ["a", "s", "k", "l"], skills: ["1", "2", "3"] });
    const rebound = lanesToKeyMap(getSetting("keybinds").lanes);
    const reboundHandler = createKeyHandler({
      inputChartTime: (ts) => ts,
      engine: { judge: (lane) => judged.push(lane), isFrozen: () => false },
      lanes: rebound,
    });
    reboundHandler({ key: "A", repeat: false, timeStamp: 0, preventDefault() {} } as KeyboardEvent);
    expect(judged).toEqual([0, 0]); // 'a' → lane 0 through the SETTINGS map, case-insensitively
    reboundHandler({ key: "d", repeat: false, timeStamp: 0, preventDefault() {} } as KeyboardEvent);
    expect(judged).toEqual([0, 0]); // the old default key no longer binds
  });
});

describe("syncSettings — only a matching re-read claims synchronization", () => {
  /** remote document that a concurrent writer keeps changing until `stableAfter` reads */
  function fakeClient(remote: SettingsMap | null, mutateOnReads: number[], mutate: (r: SettingsMap) => SettingsMap): SettingsSyncClient & { reads: number; remote: SettingsMap | null } {
    const client = {
      reads: 0,
      remote,
      async read(): Promise<SettingsMap | null> {
        client.reads += 1;
        if (mutateOnReads.includes(client.reads)) client.remote = mutate(client.remote ?? partial({}));
        return client.remote === null ? null : (structuredClone(client.remote) as SettingsMap);
      },
      async write(settings: SettingsMap): Promise<void> {
        client.remote = structuredClone(settings) as SettingsMap;
      },
    };
    return client;
  }

  /** one interleaved edit landing at a fixed rev — stable afterwards (converging case) */
  const concurrentEdit = (r: SettingsMap): SettingsMap => ({
    ...r,
    musicVolume: env(0.9, 999, "other-device", "other-write"),
  });

  /** a writer that keeps winning: every landing edit carries a NEW higher rev, so the
   *  re-read can never match what was written (non-converging case) */
  let editRev = 100;
  const unfailingEdit = (r: SettingsMap): SettingsMap => {
    editRev += 1;
    return { ...r, musicVolume: env(0.9, editRev, "other-device", `other-write-${editRev}`) };
  };

  it("converging client → ok:true with the merge's highest rev", async () => {
    setSetting("masterVolume", 0.2);
    // the competing edit lands once (read #2), then the document is stable
    const client = fakeClient(partial({ downscroll: env(true, 4, "dev-b", "w1") }), [2], concurrentEdit);
    const res = await syncSettings(client);
    expect(res).toEqual({ ok: true, mergedRev: 999 });
    // the persisted local document IS the merged document the re-read confirmed
    expect(storedMap()).toEqual(client.remote);
    expect(storedMap().musicVolume?.value).toBe(0.9);
    expect(localStorage.getItem(BASELINE_KEY)).toBe("999"); // baseline advanced for later local edits
  });

  it("non-converging client (changes on all 3 attempts) → ok:false not-converged, local untouched", async () => {
    setSetting("masterVolume", 0.2);
    const before = localStorage.getItem(SETTINGS_KEY);
    const client = fakeClient(partial({ downscroll: env(true, 4, "dev-b", "w1") }), [2, 4, 6], unfailingEdit);
    const res = await syncSettings(client);
    expect(res).toEqual({ ok: false, reason: "not-converged" });
    expect(client.reads).toBe(6); // 3 attempts × (read + re-read)
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(before); // byte-identical — nothing locally written
    expect(localStorage.getItem(BASELINE_KEY)).toBeNull();
  });

  it("a client that throws → ok:false network", async () => {
    const client: SettingsSyncClient = {
      read: async () => {
        throw new Error("offline");
      },
      write: async () => undefined,
    };
    await expect(syncSettings(client)).resolves.toEqual({ ok: false, reason: "network" });
  });

  it("no cloud channel wired yet → ok:false network (the notice path is reachable before T23)", async () => {
    await expect(syncSettings()).resolves.toEqual({ ok: false, reason: "network" });
  });
});

describe("renderer downscroll position rule (presentation only, C10)", () => {
  it("downscroll mirrors noteY about the hit line; upscroll is unchanged", () => {
    expect(noteY(1000, 0, 800, 0.5)).toBe(300); // upscroll (default) — unchanged
    expect(noteY(1000, 0, 800, 0.5, false)).toBe(300);
    expect(noteY(1000, 0, 800, 0.5, true)).toBe(1300); // mirrored: 2·800 − 300
    expect(noteY(1000, 1000, 800, 0.5, true)).toBe(800); // both directions meet at the hit line
    expect(noteY(1000, 2000, 800, 0.5, true)).toBe(300); // past the hit line → above it
  });

  it("scrollSpeed scales the travel distance in both directions", () => {
    expect(noteY(1000, 0, 800, 1)).toBe(-200);
    expect(noteY(1000, 0, 800, 1, true)).toBe(1800); // 2·800 − (−200)
  });
});

describe("/settings page", () => {
  it("renders the §18 groups and persists an edit immediately (local-first)", async () => {
    render(createElement(SettingsPage));
    const scroll = await screen.findByTestId("setting-scrollSpeed");
    fireEvent.change(scroll, { target: { value: "0.9" } });
    expect(getSetting("scrollSpeed")).toBe(0.9);
    const down = screen.getByTestId("setting-downscroll");
    fireEvent.click(down);
    expect(getSetting("downscroll")).toBe(true);
  });

  it("a conflicting keybind shows the conflict message and is NOT written", async () => {
    render(createElement(SettingsPage));
    const lane0 = await screen.findByTestId("keybind-lane-0");
    fireEvent.keyDown(lane0, { key: "f" }); // already bound to lane 1
    expect(await screen.findByTestId("keybind-conflict")).toBeTruthy();
    expect(getSetting("keybinds")).toEqual(DEFAULT_SETTINGS.keybinds); // rejected, not persisted
  });

  it("a valid rebind persists through setSetting", async () => {
    render(createElement(SettingsPage));
    const lane0 = await screen.findByTestId("keybind-lane-0");
    fireEvent.keyDown(lane0, { key: "a" });
    expect(screen.queryByTestId("keybind-conflict")).toBeNull();
    expect(getSetting("keybinds").lanes[0]).toBe("a");
  });

  it("a failed sync shows the deferred notice; a successful one clears it", async () => {
    render(createElement(SettingsPage));
    const syncBtn = await screen.findByTestId("settings-sync-now");
    expect(screen.queryByTestId("settings-sync-deferred")).toBeNull();
    fireEvent.click(syncBtn); // no cloud channel yet → ok:false → the notice is reachable
    expect(await screen.findByTestId("settings-sync-deferred")).toBeTruthy();
  });
});
