// Deterministic 30 s click track: 22050 Hz mono 16-bit, 20 ms 1 kHz click every 500 ms.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 22050, SECONDS = 30, CLICK_MS = 20, PERIOD_MS = 500;
const total = SR * SECONDS;
const pcm = Buffer.alloc(total * 2);
for (let n = 0; n < total; n++) {
  const ms = (n / SR) * 1000;
  const inClick = ms % PERIOD_MS < CLICK_MS;
  if (inClick) {
    const v = Math.round(12000 * Math.sin((2 * Math.PI * 1000 * n) / SR));
    pcm.writeInt16LE(v, n * 2);
  }
}
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(pcm.length, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio", "click-track.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`wrote ${out} (${header.length + pcm.length} bytes)`);
