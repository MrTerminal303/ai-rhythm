"use client";

// W3 T22 (B5): /settings — local-first (every control writes its envelope immediately).
// Groups per the §18 minimum; keybinds + device offset are the two documented C10
// exceptions. W3 T23 (B6) wires the real cloud channel: "Sync now" runs the merge against
// `profiles.settings` and the deferred notice reflects the outcome.
import { useState } from "react";
import Link from "next/link";
import {
  DEFAULT_SETTINGS,
  DEVICE_OFFSET_RANGE_MS,
  getSetting,
  setSetting,
  validateKeybinds,
  type Keybinds,
} from "../../settings/settings.js";
import { saveCalibration } from "../../calibration-store.js";
import { isAuthenticated, syncSettingsNow } from "../../auth/auth.js";

const LANE_LABELS = ["Lane 1", "Lane 2", "Lane 3", "Lane 4"];

export default function SettingsPage() {
  const [settings, setSettings] = useState(() => ({
    masterVolume: getSetting("masterVolume"),
    musicVolume: getSetting("musicVolume"),
    sfxVolume: getSetting("sfxVolume"),
    deviceCalibrationOffsetMs: getSetting("deviceCalibrationOffsetMs"),
    scrollSpeed: getSetting("scrollSpeed"),
    downscroll: getSetting("downscroll"),
    keybinds: getSetting("keybinds"),
  }));
  const [conflict, setConflict] = useState<string | null>(null);
  const [syncDeferred, setSyncDeferred] = useState(false);
  const [syncing, setSyncing] = useState(false);

  /** every control writes its own envelope immediately — the local-first contract */
  const write = <K extends keyof typeof settings>(key: K, value: (typeof settings)[K]): void => {
    setSetting(key, value);
    setSettings((cur) => ({ ...cur, [key]: value }));
  };

  const rebind = (kind: keyof Keybinds, index: number, key: string): void => {
    const next: Keybinds = { ...settings.keybinds, [kind]: [...settings.keybinds[kind]] };
    next[kind][index] = key.toLowerCase();
    const verdict = validateKeybinds(next);
    if (!verdict.ok) {
      setConflict(verdict.conflict); // rejected — nothing is persisted
      return;
    }
    setConflict(null);
    write("keybinds", next);
  };

  const runSync = async (): Promise<void> => {
    setSyncing(true);
    // B6 (T23): the real channel — read/merge/write/re-read against profiles.settings, and a
    // confirmed sync adopts a remote-won calibration offset into the gameplay read path.
    const result = await syncSettingsNow();
    if (result.ok) {
      // the sync may have rewritten the document (or adopted a remote offset) — re-read it so
      // the controls show what is now stored, rather than the pre-sync values
      setSettings({
        masterVolume: getSetting("masterVolume"),
        musicVolume: getSetting("musicVolume"),
        sfxVolume: getSetting("sfxVolume"),
        deviceCalibrationOffsetMs: getSetting("deviceCalibrationOffsetMs"),
        scrollSpeed: getSetting("scrollSpeed"),
        downscroll: getSetting("downscroll"),
        keybinds: getSetting("keybinds"),
      });
    }
    setSyncDeferred(!result.ok); // only ok:true clears the notice
    setSyncing(false);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-semibold tracking-tight">Settings</h1>

      <section className="flex flex-col items-center gap-3" aria-label="Audio">
        <h2 className="text-lg">Audio</h2>
        {(
          [
            ["masterVolume", "Master volume"],
            ["musicVolume", "Music volume"],
            ["sfxVolume", "SFX volume"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-3 text-sm">
            {label}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              data-testid={`setting-${key}`}
              value={settings[key]}
              onChange={(e) => write(key, Number.parseFloat(e.target.value))}
            />
            <span style={{ fontFamily: "var(--font-mono)" }}>{settings[key].toFixed(2)}</span>
          </label>
        ))}
      </section>

      <section className="flex flex-col items-center gap-3" aria-label="Calibration">
        <h2 className="text-lg">Calibration</h2>
        <label className="flex items-center gap-3 text-sm">
          Device offset (ms)
          <input
            type="number"
            min={-DEVICE_OFFSET_RANGE_MS}
            max={DEVICE_OFFSET_RANGE_MS}
            step={1}
            data-testid="setting-deviceCalibrationOffsetMs"
            value={settings.deviceCalibrationOffsetMs}
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              if (!Number.isFinite(v) || Math.abs(v) > DEVICE_OFFSET_RANGE_MS) return;
              // R6: write through saveCalibration so BOTH stores carry the value — it writes the
              // legacy key (the gameplay read path via loadCalibration) AND mirrors into the
              // envelope. Writing the envelope alone would leave judgeDt ignoring the offset.
              saveCalibration(v);
              setSettings((cur) => ({ ...cur, deviceCalibrationOffsetMs: v }));
            }}
          />
        </label>
        <Link href="/calibrate" className="text-sm" style={{ color: "var(--text-dim)" }}>
          Measure it with the calibration metronome
        </Link>
      </section>

      <section className="flex flex-col items-center gap-3" aria-label="Playfield">
        <h2 className="text-lg">Playfield</h2>
        <label className="flex items-center gap-3 text-sm">
          Scroll speed
          <input
            type="range"
            min={0.1}
            max={2}
            step={0.05}
            data-testid="setting-scrollSpeed"
            value={settings.scrollSpeed}
            onChange={(e) => write("scrollSpeed", Number.parseFloat(e.target.value))}
          />
          <span style={{ fontFamily: "var(--font-mono)" }}>{settings.scrollSpeed.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-3 text-sm">
          Downscroll
          <input
            type="checkbox"
            data-testid="setting-downscroll"
            checked={settings.downscroll}
            onChange={(e) => write("downscroll", e.target.checked)}
          />
        </label>
      </section>

      <section className="flex flex-col items-center gap-3" aria-label="Controls">
        <h2 className="text-lg">Controls</h2>
        {LANE_LABELS.map((label, i) => (
          <label key={label} className="flex items-center gap-3 text-sm">
            {label}
            <input
              readOnly
              data-testid={`keybind-lane-${i}`}
              value={settings.keybinds.lanes[i]}
              onKeyDown={(e) => {
                e.preventDefault(); // capture the next key — never let it scroll or submit
                rebind("lanes", i, e.key);
              }}
            />
          </label>
        ))}
        {conflict && (
          <p role="alert" data-testid="keybind-conflict" style={{ color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
            &quot;{conflict}&quot; is already bound — pick a different key.
          </p>
        )}
        <button
          type="button"
          data-testid="keybind-reset"
          onClick={() => {
            setConflict(null);
            write("keybinds", DEFAULT_SETTINGS.keybinds);
          }}
          className="cursor-pointer rounded-[6px] border px-4 py-2 text-sm"
          style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
        >
          Reset to defaults
        </button>
      </section>

      <section className="flex flex-col items-center gap-3" aria-label="Sync">
        <h2 className="text-lg">Cloud</h2>
        <p data-testid="settings-account-state" className="text-sm" style={{ color: "var(--text-dim)" }}>
          {isAuthenticated() ? "Signed in — settings sync to your account." : "Guest — settings stay on this device."}
        </p>
        <button
          type="button"
          data-testid="settings-sync-now"
          onClick={() => void runSync()}
          disabled={syncing}
          className="cursor-pointer rounded-[6px] border px-4 py-2 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--text-dim)" }}
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        {syncDeferred && (
          <p data-testid="settings-sync-deferred" role="status" style={{ color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
            settings sync deferred — will retry
          </p>
        )}
        <Link href="/auth" className="text-sm" style={{ color: "var(--text-dim)" }}>
          {isAuthenticated() ? "Account" : "Sign in to sync"}
        </Link>
      </section>

      <Link href="/" className="text-sm" style={{ color: "var(--text-dim)" }}>
        Back
      </Link>
    </main>
  );
}
