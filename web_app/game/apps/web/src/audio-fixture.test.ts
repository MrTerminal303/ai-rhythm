import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const WAV = new URL("../public/audio/click-track.wav", import.meta.url);

describe("audio click-track fixture", () => {
  beforeAll(() => {
    // cwd via fileURLToPath — URL.pathname yields "/E:/..." on Windows, which breaks execSync
    const script = fileURLToPath(new URL("../scripts/gen-audio-fixture.mjs", import.meta.url));
    execFileSync(process.execPath, [script], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
  });

  it("exists after generation and parses as 22050 Hz mono 16-bit, ~30 s", () => {
    expect(existsSync(WAV)).toBe(true);
    const b = readFileSync(WAV);
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.toString("ascii", 8, 12)).toBe("WAVE");
    const sampleRate = b.readUInt32LE(24);
    const channels = b.readUInt16LE(22);
    const bits = b.readUInt16LE(34);
    expect({ sampleRate, channels, bits }).toEqual({ sampleRate: 22050, channels: 1, bits: 16 });
    const dataBytes = b.length - 44;
    const seconds = dataBytes / (22050 * 2);
    expect(seconds).toBeGreaterThan(29.5);
    expect(seconds).toBeLessThan(30.5);
  });

  it("has a click (non-silent burst) within the first 25 ms and silence by 40 ms", () => {
    const b = readFileSync(WAV);
    // scan every PCM sample in the window — one-sample-per-ms strobes the 1 kHz tone
    // at a near-constant phase (~3209) and misses the true peak (12000)
    const peak = (fromMs: number, toMs: number) => {
      const from = 44 + Math.floor((fromMs / 1000) * 22050) * 2;
      const to = 44 + Math.floor((toMs / 1000) * 22050) * 2;
      let m = 0;
      for (let o = from; o < to; o += 2) m = Math.max(m, Math.abs(b.readInt16LE(o)));
      return m;
    };
    expect(peak(0, 20)).toBeGreaterThan(8_000);   // click present
    expect(peak(40, 480)).toBeLessThan(100);      // silence between clicks
  });
});
