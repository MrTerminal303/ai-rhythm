// W3 T22 (B5): settings v1 — local-first per-key envelopes with a DETERMINISTIC version
// merge rule (no wall clock; see DECISIONS D36).
//
// C10 reconciliation — settings change PRESENTATION, never gameplay. Two deliberate
// exceptions, both scoped by the W3 spec (round 11 P1-12 / P2-22):
//   1. `keybinds` — input-ROUTING configuration, not a gameplay mechanic change. The play
//      page reads the map at run start and routes lane keys through it.
//   2. `deviceCalibrationOffsetMs` — a device-domain CALIBRATION value, not a setting in the
//      C10 sense; stored here for portability, applied only in `judgeDt` (input path).
import { SCROLL_PX_PER_MS } from "../engine/renderer-webgl.js";

export const SETTINGS_KEY = "duelbeat.settings";
/** highest `rev` observed at the last sync — local edits rebase from it (§4 B5) */
export const BASELINE_KEY = "duelbeat.settings.baseline";
export const DEVICE_KEY = "duelbeat.deviceId";

/** ±500 ms plausible human-device range — mirrors calibration-store's guard (A2/D21). */
export const DEVICE_OFFSET_RANGE_MS = 500;

export interface Keybinds {
  lanes: string[]; // exactly 4
  // W3 deferral (R5, D36): no `skills` field — W3 ships no skill input path, so a skill bind
  // would have no gameplay effect (the C10 sentence). Re-add with the W4 skill input path.
}

export interface DefaultSettings {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  deviceCalibrationOffsetMs: number;
  scrollSpeed: number;
  downscroll: boolean;
  keybinds: Keybinds;
}

export interface SettingEnvelope<T> {
  value: T;
  rev: number;
  deviceId: string;
  writeId: string;
}

export type SettingsMap = { [K in keyof DefaultSettings]: SettingEnvelope<DefaultSettings[K]> };

/** §18 minimum set + the two documented C10 exceptions. `scrollSpeed` defaults to the
 *  renderer's live constant, never a copy of it. */
export const DEFAULT_SETTINGS: DefaultSettings = {
  masterVolume: 1,
  musicVolume: 1,
  sfxVolume: 1,
  deviceCalibrationOffsetMs: 0,
  scrollSpeed: SCROLL_PX_PER_MS,
  downscroll: false,
  keybinds: { lanes: ["d", "f", "j", "k"] },
};

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function deviceId(): string {
  const store = storage();
  if (!store) return "";
  const existing = store.getItem(DEVICE_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID(); // persisted per installation (§4 B5)
  store.setItem(DEVICE_KEY, fresh);
  return fresh;
}

function readBaseline(): number {
  const raw = storage()?.getItem(BASELINE_KEY);
  const n = raw === null || raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/** The raw envelope map as persisted; an unreadable/absent document reads as empty. */
function loadEnvelopes(): SettingsMap {
  const raw = storage()?.getItem(SETTINGS_KEY);
  if (!raw) return {} as SettingsMap;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as SettingsMap) : ({} as SettingsMap);
  } catch {
    return {} as SettingsMap; // corrupt document degrades to defaults, never throws at play time
  }
}

function persist(next: SettingsMap): void {
  storage()?.setItem(SETTINGS_KEY, JSON.stringify(next));
}

/** Unwrap one key's value; absent envelope → the documented default. */
export function getSetting<K extends keyof DefaultSettings>(key: K): DefaultSettings[K] {
  return loadEnvelopes()[key]?.value ?? DEFAULT_SETTINGS[key];
}

/**
 * Write one key: a fresh `writeId` per edit, and `rev = max(syncBaseline, localRev) + 1` so
 * local edits stay globally comparable with revisions observed at the last sync.
 */
export function setSetting<K extends keyof DefaultSettings>(key: K, value: DefaultSettings[K]): void {
  // heterogeneous mapped values cannot be written through the generic index (collapses to
  // `never`); the uniform envelope view is the same object at runtime
  const map = loadEnvelopes() as Record<string, SettingEnvelope<unknown>>;
  const localRev = map[key]?.rev ?? 0;
  map[key] = {
    value,
    rev: Math.max(readBaseline(), localRev) + 1,
    deviceId: deviceId(),
    writeId: crypto.randomUUID(),
  };
  persist(map as SettingsMap);
}

/** Replace the whole document (sync write-back) and advance the local rev baseline. */
export function saveSettings(merged: SettingsMap, baselineRev: number): void {
  persist(merged);
  storage()?.setItem(BASELINE_KEY, String(baselineRev));
}

/**
 * Per-key deterministic priority: higher `rev` wins; equal rev → higher `deviceId`;
 * equal deviceId (two tabs, one device) → higher `writeId`. Pure and order-independent —
 * concurrent offline edits resolve by version priority, NOT by chronological "latest"
 * (there is no reliable way to know which disconnected edit happened later).
 */
function wins(a: SettingEnvelope<unknown>, b: SettingEnvelope<unknown>): "a" | "b" {
  if (a.rev !== b.rev) return a.rev > b.rev ? "a" : "b";
  if (a.deviceId !== b.deviceId) return a.deviceId > b.deviceId ? "a" : "b";
  return a.writeId > b.writeId ? "a" : "b";
}

/**
 * Merge two documents, one key at a time. Idempotent: merging the winner with itself (or
 * with any document it already won against) changes nothing, in either argument order.
 * `baselineRev` is the highest revision observed anywhere in the result — it advances the
 * local counter base so later local edits stay comparable with the synced document.
 */
export function mergeSettings(local: SettingsMap, remote: SettingsMap): { merged: SettingsMap; baselineRev: number } {
  // heterogeneous mapped values cannot be written through the generic index (collapses to
  // `never`); the uniform envelope view is the same object at runtime (setSetting uses it too)
  const merged = {} as Record<string, SettingEnvelope<unknown>>;
  let baselineRev = 0;
  for (const k of Object.keys({ ...local, ...remote }) as (keyof SettingsMap)[]) {
    const l = local[k] as SettingEnvelope<unknown> | undefined;
    const r = remote[k] as SettingEnvelope<unknown> | undefined;
    const winner = (!l ? r : !r ? l : wins(l, r) === "a" ? l : r)!;
    merged[k] = winner;
    baselineRev = Math.max(baselineRev, winner.rev);
  }
  return { merged: merged as SettingsMap, baselineRev };
}

/** no duplicate binds across the 4 lanes; case-insensitive ('D' and 'd' are one bind) */
export function validateKeybinds(kb: Keybinds): { ok: true } | { ok: false; conflict: string } {
  const seen = new Set<string>();
  for (const bind of kb.lanes) {
    const key = bind.toLowerCase();
    if (seen.has(key)) return { ok: false, conflict: key };
    seen.add(key);
  }
  return { ok: true };
}

export type SettingsSyncOutcome =
  | { ok: true; mergedRev: number }
  | { ok: false; reason: "not-converged" | "network" };

/**
 * The cloud channel's transport (T23 supplies the real Supabase implementation).
 * `read` resolving null = row uninitialized; it throws to signal a network failure.
 */
export interface SettingsSyncClient {
  read(): Promise<SettingsMap | null>;
  write(settings: SettingsMap): Promise<void>;
}

/** stable-key JSON — the sync loop compares documents structurally, never by identity */
function canonicalDoc(map: SettingsMap): string {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k as keyof SettingsMap]]),
  );
}

/**
 * read → merge → write → RE-READ, up to 3 attempts. Only a re-read that MATCHES what was
 * written claims synchronization; exhausted retries report `not-converged` and leave the
 * local document untouched (never a silent divergence — the caller shows the deferred
 * notice and a later sync re-runs the whole loop).
 */
export async function syncSettings(client?: SettingsSyncClient | null): Promise<SettingsSyncOutcome> {
  if (!client) return { ok: false, reason: "network" }; // no cloud channel wired yet (T23)
  const local = loadEnvelopes();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const remote = await client.read();
      const { merged, baselineRev } = mergeSettings(local, remote ?? ({} as SettingsMap));
      await client.write(merged);
      const reread = await client.read();
      if (reread && canonicalDoc(reread) === canonicalDoc(merged)) {
        saveSettings(merged, baselineRev); // local wins nothing back — it IS the merged document
        return { ok: true, mergedRev: baselineRev };
      }
      // a concurrent writer interleaved — loop: the next read sees its revision too
    } catch {
      return { ok: false, reason: "network" };
    }
  }
  return { ok: false, reason: "not-converged" };
}
