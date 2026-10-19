import { parseBeatmap, type Beatmap } from "./beatmap.js";

/**
 * Code-unit-sorted JSON with `undefined` object values dropped — the stable key
 * ordering every hash/seed path needs. Exported (T25a) because the lane-seed
 * input is a different record that requires the same semantics.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(); // code-unit sort (default <), never localeCompare
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/** Code-unit string compare — locale-independent, required on canonical/hash paths. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const noteKey = (n: Beatmap["notes"][number], sourceId: number) =>
  [n.t, n.lane, n.type, n.tier ?? "primary", sourceId] as const;

/**
 * Normalize → validate → order → re-id (§12.1). Accepts any schema-valid candidate
 * INCLUDING valid-but-unsorted notes: input is defensively pre-sorted by (t, id)
 * before schema validation (the schema's superRefine requires t-sorted input),
 * then fully canonically sorted after. Full canonical order happens here, never
 * in the caller.
 */
export function canonicalizeBeatmap(candidate: unknown): Beatmap {
  // Stage 1: MINIMAL structural validation before any normalization (externally supplied
  // .dbm.json must fail with the promised "Invalid beatmap: …", never a TypeError):
  const c = candidate as { notes?: unknown } | null;
  const notesSafe =
    !!c && typeof c === "object" && Array.isArray(c.notes) &&
    c.notes.every((n) => !!n && typeof n === "object" && Number.isFinite((n as { t?: unknown }).t));
  if (notesSafe) {
    const notes = [...(c as { notes: { t: number; id?: number }[] }).notes];
    notes.sort((a, b) => a.t - b.t || (a.id ?? 0) - (b.id ?? 0)); // Stage 2: normalize ordering
    candidate = { ...(c as object), notes };
  }
  // Stage 3: full schema validation (superRefine, ranges, dup ids) — malformed input lands HERE
  const parsed = parseBeatmap(candidate);
  // snapshot source ids BEFORE reassignment (§12.1 step 3)
  const withSource = parsed.notes.map((n) => ({ note: { ...n, tier: n.tier ?? "primary" }, sourceId: n.id }));
  withSource.sort((a, b) => {
    const ka = noteKey(a.note, a.sourceId), kb = noteKey(b.note, b.sourceId);
    for (let i = 0; i < ka.length; i++) {
      // ruling §12.1: t/lane/sourceId numeric (string compare misorders mixed digit counts);
      // type/tier code-unit strings
      const va = ka[i], vb = kb[i];
      const r = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : cmpStr(String(va), String(vb));
      if (r !== 0) return r;
    }
    return 0;
  });
  const notes = withSource.map((x, i) => ({ ...x.note, id: i })); // step 4
  const timing = [...parsed.timing].sort((a, b) => a.t - b.t || a.bpm - b.bpm || a.meter - b.meter);
  const pulses = parsed.pulses
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) =>
      a.p.t - b.p.t || a.p.s - b.p.s ||
      cmpStr(a.p.k ?? "", b.p.k ?? "") || a.idx - b.idx, // code-unit compare + source-index tie-break (step 5)
    )
    .map((x) => x.p);
  return { ...parsed, notes, timing, pulses };
}

export function canonicalJson(b: Beatmap): string {
  return stableJson(b);
}

export async function hashBeatmap(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
