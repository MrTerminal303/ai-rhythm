// One-time encoder: WAV → mono Opus .webm via chromium MediaRecorder (real-time, ~6 min total).
// Rationale: Node has no built-in Opus encoder; Playwright chromium is already a pinned dep (D9).
// Determinism note: encoded BYTES are not bit-stable across runs — regeneration requires
// re-pinning checksums in song-fixtures.test.ts (that is the intentional contract).
// Mono contract (verified by probe, 2026-10-16): an <audio> element playing a mono WAV,
// captured via el.captureStream(), records a GENUINELY MONO (1-channel) Opus webm
// (probe: decodeAudioData → numberOfChannels 1; the track's channelCount setting is
// undefined on data:/blob: URL tracks, so the post-encode decode check is the guard).
// Rejected alternative: a MediaStreamAudioDestinationNode (createMediaStreamDestination)
// is stereo BY DEFAULT (track channelCount 2 → decodeAudioData reports 2 channels), but it
// CAN be made mono with `dest.channelCount = 1; dest.channelCountMode = "explicit"`.
// The captureStream() route was chosen instead because it records the element's own output
// (no context/stream wiring to keep in sync) and needs no channel-count override to obey.
// (Earlier wording here claimed MediaStreamDestination "provably cannot produce mono" — that
// was wrong.)
// C2 ($0): no new dependency — uses @playwright/test's already-installed chromium.
// Round 11 P1-5: .mjs is plain JavaScript — no TypeScript annotations allowed.
// review P0: explicit autoplay permission — a muted element is the recording source, so
// no user gesture is needed, but the flag keeps play() from stalling on policy.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SONGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "songs");
const songs = [["short", 30], ["medium", 90], ["long", 240]];
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
for (const [name] of songs) {
  const wav = readFileSync(join(SONGS_DIR, `${name}.wav`)).toString("base64");
  const webmB64 = await page.evaluate(async (b64) => {   // no TS annotation — .mjs is plain JS
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ab = bytes.buffer;
    const blob = new Blob([ab], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("audio");
    el.src = url;
    await new Promise((res, rej) => { el.oncanplaythrough = res; el.onerror = () => rej(new Error("wav load failed")); el.load(); });
    const stream = el.captureStream ? el.captureStream() : el.mozCaptureStream();
    const trackCh = stream.getAudioTracks()[0].getSettings().channelCount;
    // channelCount is undefined on data:/blob: URL captureStream tracks in this chromium
    // build; the post-encode decode check below (numberOfChannels === 1) is the real guard.
    if (typeof trackCh === "number" && trackCh !== 1) throw new Error(`captureStream not mono (channelCount=${trackCh})`);
    el.volume = 1;
    el.muted = false;
    const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 48000 });
    const chunks = [];   // no TS annotation — plain JS array
    rec.ondataavailable = (e) => chunks.push(e.data);
    const recDone = new Promise((resolve) => { rec.onstop = () => resolve(); });   // no TS generic
    const playbackDone = new Promise((resolve) => { el.onended = () => resolve(); });
    rec.start(1000);
    el.play().catch((err) => { throw new Error("audio element play() failed: " + err); });
    await playbackDone;                       // wait for END of playback (review P0: not duration+1 —
    await new Promise((r) => setTimeout(r, 500)); // +1 s trailing silence pushed duration over the <1.0 s e2e bound)
    rec.stop();                               // 500 ms flush so the final Opus frames land in the container
    await recDone;
    el.pause();
    URL.revokeObjectURL(url);
    const out = await new Blob(chunks, { type: "audio/webm" }).arrayBuffer();
    // Sanity: decode back and verify the contract before returning the bytes.
    const ctx = new AudioContext();
    const dec = await ctx.decodeAudioData(out.slice(0));
    await ctx.close();
    if (dec.numberOfChannels !== 1) throw new Error(`encoded webm decoded as ${dec.numberOfChannels} channels, expected 1`);
    const u8 = new Uint8Array(out);
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }, wav);
  writeFileSync(join(SONGS_DIR, `${name}.webm`), Buffer.from(webmB64, "base64"));
  console.log(`encoded ${name}.webm (mono verified)`);
}
await browser.close();
// .wav intermediates are transient (gitignored) — remove them so check:assets
// (which walks apps/web/public on disk) sees only the committed .webm + .osu fixtures.
for (const [name] of songs) {
  try { rmSync(join(SONGS_DIR, `${name}.wav`)); } catch {}
}
console.log("cleaned .wav intermediates");
