import { Unzip, UnzipInflate } from "fflate";
import { DEFAULT_ZIP_LIMITS, type ZipLimits } from "./zip-limits.js";

export { DEFAULT_ZIP_LIMITS };
export type { ZipLimits };

export function unsafeEntryName(name: string): boolean {
  if (name.includes("\\")) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  if (name.startsWith("/")) return true;
  return name.split("/").some((seg) => seg === "..");
}

interface CdEntry {
  name: string;
  uncompressedSize: number;
}

/** PHASE 1 helper — parse central directory (EOCD → entries) WITHOUT decompressing anything. */
export function readCentralDirectory(bytes: Uint8Array): CdEntry[] {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("osz: not a zip archive (no EOCD)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const entries: CdEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > view.byteLength) throw new Error("osz: corrupt central directory");
    if (view.getUint32(off, true) !== 0x02014b50) throw new Error("osz: corrupt central directory");
    const uncompressedSize = view.getUint32(off + 24, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    if (off + 46 + nameLen > view.byteLength) throw new Error("osz: corrupt central directory");
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, uncompressedSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Two-phase .osz extraction (Review Focus 3):
 * Phase 1 — central-directory metadata scan BEFORE any inflation (entry count, names, declared sizes).
 * Phase 2 — streaming Unzip where ACTUAL output bytes are counted INSIDE the ondata callback,
 * aborting the moment a cap crosses. Whole-archive `unzipSync()` on untrusted input is prohibited.
 */
export function extractOsz(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): { entries: Map<string, Uint8Array> } {
  if (bytes.byteLength > limits.maxCompressedBytes) throw new Error("osz: archive exceeds compressed-size limit");

  // PHASE 1 — PRE-INFLATE enforcement from central-directory metadata (nothing decompressed yet)
  const cd = readCentralDirectory(bytes);
  if (cd.length > limits.maxEntries) throw new Error(`osz: too many entries (limit ${limits.maxEntries})`);
  let declaredTotal = 0;
  for (const e of cd) {
    if (unsafeEntryName(e.name)) throw new Error(`osz: unsafe path rejected: ${e.name}`);
    if (e.uncompressedSize > limits.maxEntryBytes) throw new Error(`osz: entry exceeds per-entry limit: ${e.name}`);
    declaredTotal += e.uncompressedSize;
    if (declaredTotal > limits.maxTotalUncompressed) throw new Error("osz: cumulative decompressed limit exceeded");
  }

  // PHASE 2 — STREAMING inflation: accumulate ACTUAL output bytes INSIDE file.ondata
  // (during decompression — aborts mid-stream; a lying header that understated Phase 1 sizes
  //  is caught here, before the archive finishes inflating)
  const entries = new Map<string, Uint8Array>();
  let actualTotal = 0;
  let seen = 0;
  const uz = new Unzip((file) => {
    seen += 1; // CD count can lie — re-check against local headers as they stream in
    if (seen > limits.maxEntries) throw new Error(`osz: too many entries (limit ${limits.maxEntries})`);
    if (unsafeEntryName(file.name)) throw new Error(`osz: unsafe path rejected: ${file.name}`);
    if (file.name.endsWith("/")) return; // directory entry — nothing to extract
    const name = file.name;
    let chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (err, data, final) => {
      if (err) throw new Error(`osz: extraction failed: ${err.message}`);
      if (data) {
        entryBytes += data.byteLength;
        actualTotal += data.byteLength; // DURING decompression
        if (entryBytes > limits.maxEntryBytes) throw new Error(`osz: entry exceeds per-entry limit: ${name}`);
        if (actualTotal > limits.maxTotalUncompressed) throw new Error("osz: cumulative decompressed limit exceeded");
        chunks.push(data);
      }
      if (final) {
        entries.set(name, concatUint8(chunks));
        chunks = [];
      }
    };
    file.start(); // decompression begins — subsequent ondata calls happen during push()
  });
  uz.register(UnzipInflate); // compression 0 (stored) is registered by default; 8 = deflate
  uz.push(bytes, true);
  return { entries };
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function listOsuDifficulties(entries: Map<string, Uint8Array>): string[] {
  return [...entries.keys()].filter((n) => /\.osu$/i.test(n)).sort();
}
