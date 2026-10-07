// scripts/check-assets.mjs — PLAN §6.5.4 license gate
//
// Walks <root>/assets and <root>/public; every file must have a row in
// <root>/assets/ASSETS.csv whose license is in the allow-list:
//   CC0, CC-BY-4.0, CC-BY-3.0, ISC, MIT, OFL, owned
// and any CC-BY* row must carry non-empty attribution_text.
//
// Infrastructure exemptions (no CSV row required), matched against the
// repo-root-relative POSIX path of each file:
//   public/**/favicon*     — /favicon/i          (favicon.ico, favicon.png, ...)
//   public/robots.txt      — /robots\.txt$/i
//   public/manifest*       — /manifest/i         (manifest.json, .webmanifest, ...)
//   public/*.html          — /\.html$/i          (generated HTML/RSC metadata)
//   assets/ASSETS.csv      — /^assets\/ASSETS\.csv$/i — the manifest itself
//                            (never demands a row for itself: self-referential)
//
// CSV parsing is a naive split(",") — a field containing a comma would
// mis-parse. The current row shape (paths, URLs, CC0 with empty
// attribution_text) contains no commas, so this is accepted deliberately;
// do not "upgrade" to a quoted-CSV parser without a concrete need.
//
// Usage: node scripts/check-assets.mjs [--root <dir>]   (default root: ".")
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ALLOW = new Set(["CC0", "CC-BY-4.0", "CC-BY-3.0", "ISC", "MIT", "OFL", "owned"]);
const EXEMPT = [/favicon/i, /robots\.txt$/i, /manifest/i, /\.html$/i, /^assets\/ASSETS\.csv$/i]; // see header: infrastructure + THE CSV ITSELF
const args = process.argv.slice(2);
const rootArgIndex = args.indexOf("--root");
const root = rootArgIndex >= 0 ? args[rootArgIndex + 1] ?? "." : ".";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const csvPath = join(root, "assets", "ASSETS.csv");
if (!existsSync(csvPath)) { console.error("check-assets: assets/ASSETS.csv missing"); process.exit(1); }
const rows = new Map();
for (const line of readFileSync(csvPath, "utf8").split(/\r?\n/).slice(1)) {
  if (!line.trim()) continue;
  const [file, source, author, license, retrieved, attribution, modified] = line.split(",");
  rows.set(file, { license: (license ?? "").trim(), attribution: (attribution ?? "").trim() });
}

const files = [...walk(join(root, "assets")), ...walk(join(root, "public"))];
const offenders = [];
for (const abs of files) {
  const rel = relative(root, abs).split(sep).join("/");
  if (EXEMPT.some((r) => r.test(rel))) continue;
  const row = rows.get(rel);
  if (!row) { offenders.push(`missing CSV row: ${rel}`); continue; }
  if (!ALLOW.has(row.license)) { offenders.push(`license not allowed (${row.license}): ${rel}`); continue; }
  if (row.license.startsWith("CC-BY") && !row.attribution) { offenders.push(`CC BY without attribution_text: ${rel}`); }
}
if (offenders.length) { console.error(offenders.join("\n")); process.exit(1); }
console.log(`check-assets: ${files.length} files OK`);
