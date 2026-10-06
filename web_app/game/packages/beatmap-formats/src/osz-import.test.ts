import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { extractOsz, listOsuDifficulties, readCentralDirectory, unsafeEntryName, DEFAULT_ZIP_LIMITS, type ZipLimits } from "./osz-import.js";

const textToU8 = (s: string) => new TextEncoder().encode(s);
const u8ToText = (b: Uint8Array) => new TextDecoder().decode(b);

const osuText = "osu file format v14\n[General]\nMode: 3\n";
const small: ZipLimits = { maxCompressedBytes: 1_000_000, maxTotalUncompressed: 10_000, maxEntries: 5, maxEntryBytes: 8_000 };

/** Overwrite every central-directory declared uncompressed size in place. Pair with a readCentralDirectory assert for non-vacuity. */
function lieCdDeclaredSize(zipped: Uint8Array, size: number): void {
  const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  let eocd = -1;
  for (let i = zipped.length - 22; i >= 0 && i >= zipped.length - 22 - 65535; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(off, true)).toBe(0x02014b50);
    view.setUint32(off + 24, size, true);
    off += 46 + view.getUint16(off + 28, true) + view.getUint16(off + 30, true) + view.getUint16(off + 32, true);
  }
}

describe("unsafeEntryName", () => {
  it.each(["../evil.osu", "/abs.osu", "C:\\evil.osu", "a\\b.osu", "dir/../../x.osu"])("rejects %s", (n) => {
    expect(unsafeEntryName(n)).toBe(true);
  });
  it.each(["song/normal.osu", "normal.osu", "a-b_c.d.osu"])("accepts %s", (n) => {
    expect(unsafeEntryName(n)).toBe(false);
  });
});

describe("extractOsz — limits enforced during extraction (Review Focus 3)", () => {
  it("valid small archive passes with entries intact", () => {
    const zipped = zipSync({ "normal.osu": textToU8(osuText), "track.mp3": new Uint8Array(100) });
    const { entries } = extractOsz(zipped, small);
    expect(u8ToText(entries.get("normal.osu")!)).toContain("osu file format");
    expect(listOsuDifficulties(entries)).toEqual(["normal.osu"]);
  });

  it("entry-count limit aborts", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 6; i++) files[`f${i}.osu`] = textToU8(osuText); // 6 > maxEntries 5
    expect(() => extractOsz(zipSync(files), small)).toThrow(/entries/i);
  });

  it("cumulative uncompressed limit aborts (large single entry over total but under per-entry? use two entries)", () => {
    const files = { "a.bin": new Uint8Array(6_000), "b.bin": new Uint8Array(6_000) }; // 12 000 > 10 000 total; each < 8 000 per-entry
    expect(() => extractOsz(zipSync(files), small)).toThrow(/decompressed/i);
  });

  it("lying central-directory sizes pass Phase 1 — cumulative actual bytes caught DURING decompression", () => {
    // Patch CD uncompressedSize fields down to 1 000 each (Phase 1 sees 2 000 < 10 000 total),
    // while real inflated output stays 12 000 — only during-inflation byte counting can catch this.
    const zipped = zipSync({ "a.bin": new Uint8Array(6_000), "b.bin": new Uint8Array(6_000) });
    lieCdDeclaredSize(zipped, 1_000);
    // prove Phase 1 sees only 2 000 declared bytes — the throw below must come from Phase 2
    expect(readCentralDirectory(zipped).map((e) => e.uncompressedSize)).toEqual([1_000, 1_000]);
    expect(() => extractOsz(zipped, small)).toThrow(/decompressed/i);
  });

  it("single-entry lying bomb (1 KB declared, 40 KB actual) aborted during inflation", () => {
    const zipped = zipSync({ "bomb.bin": new Uint8Array(40_000) });
    lieCdDeclaredSize(zipped, 1_000);
    expect(readCentralDirectory(zipped).map((e) => e.uncompressedSize)).toEqual([1_000]);
    // maxEntryBytes raised above actual so the per-entry cap cannot mask the cumulative cap
    expect(() => extractOsz(zipped, { ...small, maxEntryBytes: 50_000 })).toThrow(/decompressed/i);
  });

  it("multi-slice feeding: archive larger than one feed slice extracts intact", () => {
    const big = new Uint8Array(200_000);
    for (let o = 0; o < big.length; o += 65_536) crypto.getRandomValues(big.subarray(o, Math.min(o + 65_536, big.length)));
    const zipped = zipSync({ "big.bin": big });
    expect(zipped.length).toBeGreaterThan(64 * 1024); // forces >1 slice through the feed loop
    const { entries } = extractOsz(zipped); // DEFAULT_ZIP_LIMITS
    expect(entries.get("big.bin")).toEqual(big);
  });

  it("feed-slice exact-multiple archive length still delivers final exactly once", () => {
    const zipped = zipSync({ "normal.osu": textToU8(osuText) });
    const pad = (64 * 1024 - (zipped.length % (64 * 1024))) % (64 * 1024);
    const padded = new Uint8Array(zipped.length + pad);
    padded.set(zipped);
    const view = new DataView(padded.buffer);
    const eocd = zipped.length - 22; // zipSync writes no archive comment
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    view.setUint16(eocd + 20, pad, true); // declare appended bytes as EOCD comment
    expect(padded.length % (64 * 1024)).toBe(0);
    const { entries } = extractOsz(padded, small);
    expect(u8ToText(entries.get("normal.osu")!)).toContain("osu file format");
  });

  it("per-entry limit aborts before accepting the entry", () => {
    expect(() => extractOsz(zipSync({ "big.bin": new Uint8Array(9_000) }), small)).toThrow(/entry/i);
  });

  it("compressed-size guard rejects oversized archive input", () => {
    // incompressible data: zeros would deflate below the 1 000-byte cap and never trip the guard
    const random = new Uint8Array(50_000);
    crypto.getRandomValues(random);
    const zipped = zipSync({ "x.bin": random });
    expect(() => extractOsz(zipped, { ...small, maxCompressedBytes: 1_000 })).toThrow(/archive/i);
  });

  it("traversal names rejected", () => {
    expect(() => extractOsz(zipSync({ "../evil.osu": textToU8(osuText) }), small)).toThrow(/path/i);
  });

  it("DEFAULT_ZIP_LIMITS matches spec numbers", () => {
    expect(DEFAULT_ZIP_LIMITS).toEqual({
      maxCompressedBytes: 100 * 1024 * 1024,
      maxTotalUncompressed: 300 * 1024 * 1024,
      maxEntries: 1000,
      maxEntryBytes: 50 * 1024 * 1024,
    });
  });
});
