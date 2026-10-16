// e2e/w3-fixture-decode.spec.ts
// W3 T14: spec §8 default 1's provisional gate — the .webm/Opus fixture choice is only
// confirmed when decodeAudioData succeeds on ALL THREE engines (chromium/firefox/webkit).
// Per song: load raw bytes, decode in-page, assert mono, non-silent first 2 s, and duration
// within ±1 s of nominal.
//
// RUNNER: this spec needs the three-engine projects declared in the committed
// `apps/web/w3-fixture-decode.config.ts` (chromium/firefox/webkit). The default
// `apps/web/playwright.config.ts` declares no `projects`, so it runs chromium only.
//
// WEBKIT PLATFORM GAP (this environment, 2026-10-16): the Playwright WebKit build here
// exposes NO Web Audio API (AudioContext/webkitAudioContext/MediaSource all undefined) and
// its <audio> element rejects the Opus webm fixtures (MEDIA_ERR_SRC_NOT_SUPPORTED code 4),
// so decodeAudioData cannot run under WebKit at all. When that happens this test THROWS —
// it goes RED (no test.fail()/skip: an inverted expectation would report the gap as a
// passing gate). Chromium + Firefox PASS the decode contract; per spec §8 default 1 the
// .webm/Opus choice stays PROVISIONAL until a WebKit build WITH Web Audio (macOS-attached
// WebKit, or a WebKit with libopus) confirms the third engine — that run turns this green.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const songsDir = path.join(__dirname, "..", "apps", "web", "public", "songs");
const NOMINAL: Record<string, number> = { "short.webm": 30, "medium.webm": 90, "long.webm": 240 };

for (const [file, nominalSec] of Object.entries(NOMINAL)) {
  // Round 11 P1-4: test.info() is only available inside a running test — calling it in
  // the title expression at registration time throws. Use a static title + testInfo param.
  test(`decodeAudioData: ${file}`, async ({ page, browserName }, testInfo) => {
    if (browserName === "webkit") {
      // A WebKit build with Web Audio is a hard requirement for this gate. If it is absent
      // the test MUST go red (bare throw) — a `test.fail()` here would mark "failed" as the
      // EXPECTED status and the run would report the gap as a passing gate.
      const hasAudio = await page.evaluate(() => !!(window.AudioContext ?? (window as { webkitAudioContext?: unknown }).webkitAudioContext));
      if (!hasAudio) {
        throw new Error(
          `[fixture-decode] WEBKIT PLATFORM GAP: no Web Audio API (AudioContext/webkitAudioContext both undefined) in this WebKit build, ` +
          `and <audio> element rejects the Opus webm fixtures (MEDIA_ERR_SRC_NOT_SUPPORTED code 4). ` +
          `Chromium + Firefox PASS the decode contract; .webm choice remains PROVISIONAL per spec §8 default 1. ` +
          `Operator: run on a WebKit build with Web Audio + Opus (macOS-attached WebKit, or a WebKit with libopus) to confirm the third engine.`,
        );
      }
    }
    console.log(`[fixture-decode] browser project: ${testInfo.project.name} — ${file}`);
    await page.goto("/");
    const bytes = readFileSync(path.join(songsDir, file));
    const result = await page.evaluate(async (b64: string) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      // WebKit: AudioContext may exist only as the WebKit-prefixed webkitAudioContext.
      const Ctor = (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctor) throw new Error("no AudioContext in this engine");
      const ctx = new Ctor();
      const decoded = await ctx.decodeAudioData(buf.buffer);
      const ch = decoded.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < Math.min(ch.length, Math.floor(decoded.sampleRate * 2)); i++) peak = Math.max(peak, Math.abs(ch[i]!));
      const out = { duration: decoded.duration, channels: decoded.numberOfChannels, peak };
      await ctx.close();
      return out;
    }, bytes.toString("base64"));
    expect(result.channels).toBe(1);
    expect(result.peak).toBeGreaterThan(0.01);
    expect(Math.abs(result.duration - nominalSec)).toBeLessThan(1.0);
  });
}
