// W3 T18 (B1): versioned IndexedDB song library + single-transaction atomic import.
//
// The store is a DEDUP LAYER: audio bytes live in `audioAssets` (keyed by SHA-256),
// charts reference them by hash with a refCount. Import is ATOMIC — one readwrite
// tx over both stores; abort ⇒ neither row commits (no chart-without-audio state).
//
// The store-level sample cap (MAX_ESTIMATED_SAMPLES) validates DECLARED metadata
// (ceil(durationMs × sampleRate / 1000) × channels) only — defense-in-depth. The
// AUTHORITATIVE cap is enforced at every DECODER BOUNDARY (T20 import flow, B3
// upload): the store cannot verify the underlying asset from caller-supplied fields.

import { canonicalJson, parseBeatmap, type Beatmap } from "@airhythm/shared";

export const DB_NAME = "duelbeat-library";
export const SCHEMA_VERSION = 1;

/** Estimated-decoded-PCM guard from DECLARED metadata (round 8 P2-5): ≤ 40 M samples. */
export const MAX_ESTIMATED_SAMPLES = 40_000_000;

export interface AudioMeta {
  durationMs: number;
  sampleRate: number;
  channels: number;
}

export interface AudioAssetRecord {
  audioHash: string;
  bytes: ArrayBuffer;
  durationMs: number;
  sampleRate: number;
  channels: number;
  sizeBytes: number;
  refCount: number;
  addedAt: number;
  schemaVersion: 1;
}

export interface ChartRecord {
  chartId: string;
  title: string;
  difficulty: string;
  audioHash: string;
  chartJson: string;
  chartHash: string;
  nps: number;
  noteCount: number;
  durationMs: number;
  state: "playable" | "damaged";
  addedAt: number;
  schemaVersion: 1;
}

/** Quota failure: surfaced, never swallowed. */
export class LibraryQuotaError extends Error {
  readonly userMessage = "Storage full — delete songs from the library";
}

// W2 canonical hashing pattern (import/page.tsx, canonical.ts): sha256 → lowercase hex.
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted")),
    );
    tx.addEventListener("error", () => reject(tx.error ?? new Error("IndexedDB transaction error")));
  });
}

function req<T>(r: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

export async function openLibraryDb(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, SCHEMA_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("audioAssets")) {
        db.createObjectStore("audioAssets", { keyPath: "audioHash" });
      }
      if (!db.objectStoreNames.contains("charts")) {
        db.createObjectStore("charts", { keyPath: "chartId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function validateAudioMeta(m: AudioMeta): void {
  if (![m.durationMs, m.sampleRate, m.channels].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error("invalid audio metadata: all fields must be finite and > 0");
  }
  if (m.channels > 2) throw new Error("invalid audio metadata: channels must be ≤ 2");
  // DECLARED-metadata guard only (round 8 P2-5) — see module header.
  const estimatedSamples = Math.ceil((m.durationMs * m.sampleRate) / 1000) * m.channels;
  if (estimatedSamples > MAX_ESTIMATED_SAMPLES) {
    throw new Error(
      `audio sample cap exceeded (decoded estimate ${estimatedSamples} > ${MAX_ESTIMATED_SAMPLES})`,
    );
  }
}

export async function importChartWithAudio(
  input: { chart: unknown; audioBytes: ArrayBuffer; audioMeta: AudioMeta },
  db?: IDBDatabase,
): Promise<{ chartId: string; audioHash: string; chartHash: string; dedupedAudio: boolean }> {
  // Exact contract (spec §4 B1): validate + hash BEFORE any transaction opens.
  const beatmap: Beatmap = parseBeatmap(input.chart);
  validateAudioMeta(input.audioMeta);
  const chartJson = canonicalJson(beatmap); // stable canonical string — the hash input
  const [audioHash, chartHash] = await Promise.all([
    sha256Hex(input.audioBytes),
    sha256Hex(new TextEncoder().encode(chartJson) as unknown as ArrayBuffer),
  ]);

  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction(["audioAssets", "charts"], "readwrite");
    const audioStore = tx.objectStore("audioAssets");
    const chartStore = tx.objectStore("charts");

    const chartId = crypto.randomUUID();
    const now = Date.now();
    let dedupedAudio = false;
    try {
      const existing = await req<AudioAssetRecord | undefined>(audioStore.get(audioHash));
      const audio: AudioAssetRecord = existing
        ? { ...existing, refCount: existing.refCount + 1 }
        : {
            audioHash,
            bytes: input.audioBytes,
            durationMs: input.audioMeta.durationMs,
            sampleRate: input.audioMeta.sampleRate,
            channels: input.audioMeta.channels,
            sizeBytes: input.audioBytes.byteLength,
            refCount: 1,
            addedAt: now,
            schemaVersion: 1,
          };
      dedupedAudio = existing !== undefined;
      // Monkey-patched put() throws SYNCHRONOUSLY inside the request handler —
      // caught here so the tx is aborted explicitly (a bare JS throw does not abort).
      await req(audioStore.put(audio));
      await req(
        chartStore.put({
          chartId,
          title: beatmap.meta.title,
          difficulty: beatmap.meta.difficulty,
          audioHash,
          chartJson,
          chartHash,
          nps: beatmap.notes.length / (beatmap.song.durationMs / 1000),
          noteCount: beatmap.notes.length,
          durationMs: beatmap.song.durationMs,
          state: "playable",
          addedAt: now,
          schemaVersion: 1,
        }),
      );
    } catch (e) {
      // If the tx didn't already abort (e.g. a synchronous throw from a patched put),
      // abort it explicitly so BOTH stores roll back — the atomicity contract.
      if (tx.error === null) tx.abort();
      const name = (e as { name?: string })?.name;
      if (name === "QuotaExceededError") throw new LibraryQuotaError(userMessageForQuota());
      throw e;
    }
    await txDone(tx);
    return { chartId, audioHash, chartHash, dedupedAudio };
  } finally {
    if (closeAfter) owner.close();
  }
}

function userMessageForQuota(): string {
  return "Storage full — delete songs from the library";
}

export async function getChart(chartId: string, db?: IDBDatabase): Promise<ChartRecord | undefined> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction("charts", "readonly");
    return await req<ChartRecord | undefined>(tx.objectStore("charts").get(chartId));
  } finally {
    if (closeAfter) owner.close();
  }
}

export async function listCharts(db?: IDBDatabase, opts?: { verifyAudio?: boolean }): Promise<ChartRecord[]> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    // Round-12 API: signature is listCharts(db?, opts?) — call sites pass the
    // isolated connection first. Default verifyAudio = true (small libraries;
    // flips state so badges render from real state).
    const verify = opts?.verifyAudio !== false;
    const tx = owner.transaction(["charts", "audioAssets"], "readwrite");
    const chartStore = tx.objectStore("charts");
    const audioStore = tx.objectStore("audioAssets");
    const all = await req<ChartRecord[]>(chartStore.getAll());
    if (verify) {
      for (const c of all) {
        const asset = await req<AudioAssetRecord | undefined>(audioStore.get(c.audioHash));
        if (asset) {
          const hash = await sha256Hex(asset.bytes);
          if (hash !== c.audioHash) {
            await req(chartStore.put({ ...c, state: "damaged" } as ChartRecord));
            c.state = "damaged";
          }
        } else {
          await req(chartStore.put({ ...c, state: "damaged" } as ChartRecord));
          c.state = "damaged";
        }
      }
    }
    await txDone(tx);
    return all;
  } finally {
    if (closeAfter) owner.close();
  }
}

export async function getAudioBytes(audioHash: string, db?: IDBDatabase): Promise<ArrayBuffer | undefined> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction("audioAssets", "readonly");
    const rec = await req<AudioAssetRecord | undefined>(tx.objectStore("audioAssets").get(audioHash));
    // Copy: callers cannot corrupt the stored record.
    return rec ? rec.bytes.slice(0) : undefined;
  } finally {
    if (closeAfter) owner.close();
  }
}

/** Joins chart → audio bytes; missing bytes ⇒ damaged semantics surfaced to caller. */
export async function getAudioForChart(
  chartId: string,
  db?: IDBDatabase,
): Promise<{ chart: ChartRecord; bytes: ArrayBuffer } | undefined> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction(["charts", "audioAssets"], "readonly");
    const chart = await req<ChartRecord | undefined>(tx.objectStore("charts").get(chartId));
    if (!chart) return undefined;
    const asset = await req<AudioAssetRecord | undefined>(tx.objectStore("audioAssets").get(chart.audioHash));
    if (!asset) return undefined;
    return { chart, bytes: asset.bytes.slice(0) };
  } finally {
    if (closeAfter) owner.close();
  }
}

// Round 11 P2-26: chart-JSON integrity on read.
export async function loadVerifiedChart(
  chartId: string,
  db?: IDBDatabase,
): Promise<{ ok: true; chart: ChartRecord } | { ok: false }> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction("charts", "readwrite");
    const chartStore = tx.objectStore("charts");
    const chart = await req<ChartRecord | undefined>(chartStore.get(chartId));
    if (!chart) return { ok: false };
    // chartJson IS the canonical JSON string that chartHash was computed over —
    // re-hash it directly; unparseable JSON is also a mismatch (corrupt).
    let good = false;
    try {
      JSON.parse(chart.chartJson); // reject unparseable before hashing
      good =
        (await sha256Hex(new TextEncoder().encode(chart.chartJson) as unknown as ArrayBuffer)) ===
        chart.chartHash;
    } catch {
      good = false; // unparseable JSON → corrupt
    }
    if (!good) {
      await req(chartStore.put({ ...chart, state: "damaged" } as ChartRecord));
      await txDone(tx);
      return { ok: false };
    }
    await txDone(tx);
    return { ok: true, chart };
  } finally {
    if (closeAfter) owner.close();
  }
}

// Review P0: audio hash verification on read.
export async function loadVerifiedAudio(
  chartId: string,
  db?: IDBDatabase,
): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false }> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction(["charts", "audioAssets"], "readwrite");
    const chartStore = tx.objectStore("charts");
    const audioStore = tx.objectStore("audioAssets");
    const chart = await req<ChartRecord | undefined>(chartStore.get(chartId));
    if (!chart) return { ok: false };
    const asset = await req<AudioAssetRecord | undefined>(audioStore.get(chart.audioHash));
    if (!asset) {
      await req(chartStore.put({ ...chart, state: "damaged" } as ChartRecord));
      await txDone(tx);
      return { ok: false };
    }
    const hash = await sha256Hex(asset.bytes);
    if (hash !== chart.audioHash) {
      await req(chartStore.put({ ...chart, state: "damaged" } as ChartRecord));
      await txDone(tx);
      return { ok: false };
    }
    await txDone(tx);
    return { ok: true, bytes: asset.bytes.slice(0) };
  } finally {
    if (closeAfter) owner.close();
  }
}

export async function deleteChart(chartId: string, db?: IDBDatabase): Promise<void> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction(["charts", "audioAssets"], "readwrite");
    const chartStore = tx.objectStore("charts");
    const audioStore = tx.objectStore("audioAssets");
    const chart = await req<ChartRecord | undefined>(chartStore.get(chartId));
    if (!chart) {
      await txDone(tx);
      return;
    }
    await req(chartStore.delete(chartId));
    const asset = await req<AudioAssetRecord | undefined>(audioStore.get(chart.audioHash));
    if (asset) {
      const refCount = asset.refCount - 1;
      if (refCount <= 0) {
        await req(audioStore.delete(chart.audioHash)); // shared-audio survival only above 0
      } else {
        await req(audioStore.put({ ...asset, refCount } as AudioAssetRecord));
      }
    }
    await txDone(tx);
  } finally {
    if (closeAfter) owner.close();
  }
}

export async function evictAudio(audioHash: string, db?: IDBDatabase): Promise<void> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction("audioAssets", "readwrite");
    const store = tx.objectStore("audioAssets");
    const asset = await req<AudioAssetRecord | undefined>(store.get(audioHash));
    if (asset && asset.refCount > 0) throw new Error("audio still referenced");
    await req(store.delete(audioHash));
    await txDone(tx);
  } finally {
    if (closeAfter) owner.close();
  }
}

export async function markDamaged(chartId: string, db?: IDBDatabase): Promise<void> {
  const owner = db ?? (await openLibraryDb());
  const closeAfter = db === undefined;
  try {
    const tx = owner.transaction("charts", "readwrite");
    const store = tx.objectStore("charts");
    const chart = await req<ChartRecord | undefined>(store.get(chartId));
    if (chart) await req(store.put({ ...chart, state: "damaged" } as ChartRecord));
    await txDone(tx);
  } finally {
    if (closeAfter) owner.close();
  }
}
