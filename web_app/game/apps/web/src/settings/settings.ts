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
  /** W4: visual-only playfield shift in ms. Positive = notes appear LATER. Never judged —
   *  this is the perceptual counterpart of the audio offset, and it must not reach the
   *  input path (C10). */
  visualOffsetMs: number;
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
  visualOffsetMs: 0,
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
 * W3 T23 (B6): the single low-level write hook. `setSetting` is the ONE function every local
 * edit funnels through (the /settings controls, the keybind rebind, and the calibration
 * mirror), so B6's debounced cloud sync hangs off it instead of off each page's handlers.
 * Deliberately NOT fired by `saveSettings`: that is the sync write-back, and triggering from
 * it would make sync → write → sync a feedback loop.
 */
let afterWriteHook: (() => void) | null = null;

export function setSettingsWriteHook(hook: (() => void) | null): void {
  afterWriteHook = hook;
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
  try {
    afterWriteHook?.(); // best-effort: a sync trigger must never break the write just made
  } catch {
    /* the local write above is the contract; the trigger is opportunistic */
  }
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
  // "invalid-remote" (W3 T23 extension, D29): the remote document exists but is not a valid
  // envelope map. Distinct from "network" because the local document is deliberately left
  // untouched and a retry will NOT help until the remote row is fixed — the same class of
  // information as "not-converged", not a transient channel failure.
  | { ok: false; reason: "not-converged" | "network" | "invalid-remote" };

/** Thrown by a `SettingsSyncClient.read` that found a non-NULL, non-envelope-map remote
 *  document. `syncSettings` maps it to `invalid-remote` instead of the generic `network`. */
export class InvalidRemoteSettingsError extends Error {
  constructor(detail = "remote settings document is not a valid envelope map") {
    super(detail);
    this.name = "InvalidRemoteSettingsError";
  }
}

/**
 * The cloud channel's transport (T23 supplies the real Supabase implementation).
 * `read` resolving null = row uninitialized; it throws to signal a network failure, and
 * throws `InvalidRemoteSettingsError` for a malformed remote document.
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
 * W3 T23: is an arbitrary value a well-formed settings envelope map?
 *
 * Structural, not zod: the remote document arrives from our own column, and what actually
 * threatens the local state is a payload that LOOKS like a map but makes `mergeSettings`
 * produce garbage (a non-object, or an envelope missing the fields the merge rule orders by).
 * Every present key must be a known setting with a numeric `rev` and string `deviceId`/`writeId`
 * — an unknown key means the document was not written by this contract, which is exactly the
 * case that must NOT be merged over the local document.
 */
export function settingsDocIsEnvelopeMap(value: unknown): value is SettingsMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const known = new Set(Object.keys(DEFAULT_SETTINGS));
  for (const [key, env] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(key)) return false;
    if (env === null || typeof env !== "object" || Array.isArray(env)) return false;
    const e = env as Record<string, unknown>;
    if (!Number.isFinite(e.rev) || typeof e.deviceId !== "string" || typeof e.writeId !== "string") return false;
    if (!("value" in e)) return false;
  }
  return true;
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
    } catch (err) {
      // a malformed remote document is not a channel failure and a retry cannot fix it
      if (err instanceof InvalidRemoteSettingsError) return { ok: false, reason: "invalid-remote" };
      return { ok: false, reason: "network" };
    }
  }
  return { ok: false, reason: "not-converged" };
}
