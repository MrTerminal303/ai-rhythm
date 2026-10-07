// build-atlas.ts — CLI: assets/src/{ui,particles,patterns}/**/*.png →
// apps/web/public/atlas/{sprites.png, atlas.json, frames/**.png}
// Deterministic: sorted inputs, fixed generator string (never a timestamp),
// same inputs → byte-identical outputs. Budget gate: exit 1 with sizes.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { packPlacements } from "./pack.ts";

const COMBINED_MAX = 400 * 1024;
const FRAME_MAX = 32 * 1024;

const root = fileURLToPath(new URL("../../../", import.meta.url)); // web_app/game/
const srcRoot = join(root, "assets", "src");
const outDir = join(root, "apps", "web", "public", "atlas");

// Deterministic input order: recursive readdir + code-unit sort (no localeCompare).
const inputs: { abs: string; name: string }[] = [];
for (const sub of ["ui", "particles", "patterns"]) {
  const base = join(srcRoot, sub);
  for (const e of readdirSync(base, { recursive: true })) {
    const abs = join(base, e);
    if (statSync(abs).isFile() && e.endsWith(".png")) {
      inputs.push({ abs, name: relative(srcRoot, abs).split(sep).join("/").replace(/\.png$/, "") });
    }
  }
}
inputs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const decoded = inputs.map((i) => ({ ...i, png: PNG.sync.read(readFileSync(i.abs)) }));
const packed = packPlacements(
  decoded.map((d) => ({ name: d.name, w: d.png.width, h: d.png.height, slice9: d.name.includes("note") })),
);

// Composite sprites sheet.
const atlas = new PNG({ width: packed.width, height: packed.height });
for (const d of decoded) {
  const f = packed.frames[d.name]!;
  for (let row = 0; row < f.h; row++) {
    const src = row * d.png.width * 4;
    const dst = ((f.y + row) * atlas.width + f.x) * 4;
    atlas.data.set(d.png.data.subarray(src, src + d.png.width * 4), dst);
  }
}
const spritesBuf = PNG.sync.write(atlas);
const jsonBuf = new TextEncoder().encode(
  JSON.stringify(
    { meta: { size: { width: packed.width, height: packed.height }, generator: "atlas/1" }, frames: packed.frames },
    null,
    2,
  ),
);

// Per-frame crops (from the decoded sources — same pixels as the sheet).
const frameBufs = decoded.map((d) => {
  const f = packed.frames[d.name]!;
  const crop = new PNG({ width: f.w, height: f.h });
  for (let row = 0; row < f.h; row++) {
    const src = row * d.png.width * 4;
    const dst = row * f.w * 4;
    crop.data.set(d.png.data.subarray(src, src + f.w * 4), dst);
  }
  return { name: d.name, buf: PNG.sync.write(crop) };
});

mkdirSync(join(outDir, "frames"), { recursive: true });
writeFileSync(join(outDir, "sprites.png"), spritesBuf);
writeFileSync(join(outDir, "atlas.json"), jsonBuf);
for (const f of frameBufs) {
  const p = join(outDir, "frames", `${f.name}.png`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.buf);
}

// Budget gate (per brief: write, then enforce) — sizes printed, exit 1 on breach.
const combined = spritesBuf.length + jsonBuf.length;
const overFrames = frameBufs.filter((f) => f.buf.length > FRAME_MAX);
if (combined > COMBINED_MAX || overFrames.length > 0) {
  if (combined > COMBINED_MAX) {
    console.error(`budget: sprites.png ${spritesBuf.length} + atlas.json ${jsonBuf.length} = ${combined} > ${COMBINED_MAX} (400 KB)`);
  }
  for (const f of overFrames) console.error(`budget: frames/${f.name}.png ${f.buf.length} > ${FRAME_MAX}`);
  process.exit(1);
}

const maxFrame = frameBufs.reduce((m, f) => Math.max(m, f.buf.length), 0);
console.log(`sprites.png: ${spritesBuf.length} B`);
console.log(`atlas.json: ${jsonBuf.length} B`);
console.log(`combined: ${combined} B / ${COMBINED_MAX} B (400 KB budget)`);
console.log(`frames: ${frameBufs.length} files, max ${maxFrame} B / ${FRAME_MAX} B`);
console.log(`atlas: ${packed.width}x${packed.height}, ${frameBufs.length} sprites → ${outDir}`);
