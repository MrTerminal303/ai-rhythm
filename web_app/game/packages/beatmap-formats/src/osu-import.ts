export interface ImportWarning {
  code: string;
  message: string;
}

export interface ParsedOsu {
  meta: { title: string; artist: string; creator: string; difficulty: string; tags: string[]; previewMs: number };
  keys: number;
  timing: { t: number; bpm: number; meter: number }[];
  notes: { id: number; t: number; lane: number; type: "tap" | "hold"; d?: number }[];
  warnings: ImportWarning[];
  audioFilename: string | null;
  mode: number;
  circleSize: number;
}

/** Core mania type bits: 1 = tap, 128 = hold. Spec §5.2: any other bit must warn. */
const CORE_TYPE_BITS = 0x1 | 0x80;

/** osu!mania Mode = 3 (0=osu!, 1=taiko, 2=catch, 3=mania) — Spec §5.2's "Mode: 4" is a recorded typo. */

// Security caps (W2 final security review): spec has no explicit caps — these are
// deliberately generous DoS guards; real mania charts sit far below them (notes are
// KB-scale, timing points are dozens, tags are a handful).
const MAX_NOTES = 10_000;
const MAX_TIMING_POINTS = 10_000;
const MAX_TAGS = 64;
// C2 compound (pulse derivation): sub-ms beatLength or huge note times make the
// nested beat loop iterate span/beatLength — or spin forever once float64 absorbs
// the increment. Real charts derive <20k pulses; 100k is a generous DoS ceiling.
const MAX_PULSES = 100_000;

export function parseOsu(text: string): ParsedOsu {
  const warnings: ImportWarning[] = [];
  const sections: Record<string, string[]> = {};
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1);
      sections[current] = [];
      continue;
    }
    if (line && current) sections[current]!.push(line);
  }

  // Warning contract: no unsupported content disappears silently
  const events = (sections.Events ?? []).filter((l) => !l.startsWith("//"));
  if (events.length > 0) {
    warnings.push({
      code: "storyboard-dropped",
      message: `${events.length} [Events] line(s) dropped (background/storyboard/animation unsupported)`,
    });
  }

  const kv = (name: string) =>
    sections.General?.find((l) => l.startsWith(name + ":"))?.slice(name.length + 1).trim() ?? null;

  const mode = Number(kv("Mode") ?? "0");
  if (mode !== 3) throw new Error(`osu: only osu!mania (Mode 3) is supported, got Mode ${mode}`);
  const diff = sections.Difficulty ?? [];
  const circleSize = Number(
    diff.find((l) => l.startsWith("CircleSize:"))?.slice("CircleSize:".length).trim() ?? "0",
  );
  if (circleSize !== 4) throw new Error(`osu: only 4K (CircleSize 4) is supported, got CircleSize ${circleSize}`);

  const meta = (k: string, fallback = "") =>
    sections.Metadata?.find((l) => l.startsWith(k + ":"))?.slice(k.length + 1).trim() ?? fallback;
  const allTags = meta("Tags").split(/\s+/).filter(Boolean);
  const tags = allTags.slice(0, MAX_TAGS); // I4: cap — unbounded Tags field is attacker-controlled
  if (allTags.length > MAX_TAGS) {
    warnings.push({
      code: "feature-dropped",
      message: `Tags truncated to ${MAX_TAGS} entries (${allTags.length - MAX_TAGS} dropped)`,
    });
  }
  const previewMs = Math.max(0, Math.round(Number(meta("PreviewTime", "0")) || 0));

  // timing: fields are time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
  const timing: ParsedOsu["timing"] = [];
  for (const [i, line] of (sections.TimingPoints ?? []).entries()) {
    const [msStr, beatMsStr, meterStr, , , , uninheritedStr] = line.split(",");
    const t = Math.round(Number(msStr));
    if (!Number.isFinite(t)) {
      warnings.push({ code: "invalid-line", message: `malformed timing point at [TimingPoints] line ${i + 1} dropped` });
      continue;
    }
    if (Number(uninheritedStr) !== 1) {
      // 7TH field (index 6) — NOT index 5 (that is volume)
      warnings.push({ code: "sv-dropped", message: `inherited timing point at ${t} ms dropped (scroll-velocity changes unsupported)` });
      continue;
    }
    const bpm = 60_000 / Number(beatMsStr); // full float precision — no 2-decimal quantization (T16 round-trip)
    // reject beatLength 0/negative/NaN — non-finite bpm would hang pulse derivation
    if (!Number.isFinite(bpm) || bpm <= 0) {
      warnings.push({ code: "invalid-line", message: `invalid beatLength at [TimingPoints] line ${i + 1} dropped` });
      continue;
    }
    timing.push({ t, bpm, meter: Number(meterStr) || 4 });
    if (timing.length > MAX_TIMING_POINTS) throw new Error(`osu: too many timing points (limit ${MAX_TIMING_POINTS})`);
  }
  if (timing.length === 0) {
    // I1 (round-2 sweep): fabricated default must never be silent — never-silent contract
    warnings.push({
      code: "feature-dropped",
      message: "no usable timing points in [TimingPoints] (absent or empty) — default 120 BPM timing synthesized",
    });
    timing.push({ t: 0, bpm: 120, meter: 4 });
  }

  // hit objects — mania: x,y,time,type,hitSound,endTime:hitSample (hold payload is parts[5])
  const notes: ParsedOsu["notes"] = [];
  let id = 0;
  for (const [i, line] of (sections.HitObjects ?? []).entries()) {
    const parts = line.split(",");
    const x = Number(parts[0]);
    const t = Math.round(Number(parts[2]));
    const typeFlags = Number(parts[3]);
    const hitSound = Number(parts[4] ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(t)) {
      warnings.push({ code: "invalid-line", message: `malformed hit object at [HitObjects] line ${i + 1} dropped` });
      continue;
    }
    if (hitSound !== 0) {
      warnings.push({ code: "feature-dropped", message: `hitsound data at ${t} ms dropped` });
    }
    const isHold = (typeFlags & 128) !== 0;
    const isTap = (typeFlags & 1) !== 0;
    // Spec §5.2 warning contract: unsupported type bits warn even when co-occurring
    // with core bits (flags 3/130); flags 1/128/129 are valid and warn nothing.
    if ((typeFlags & ~CORE_TYPE_BITS) !== 0) {
      warnings.push({ code: "feature-dropped", message: `unsupported type bits (${typeFlags}) at ${t} ms dropped` });
    }
    // hitSample check: taps → payload fields 0..2; holds → payload is endTime:sample, fields 1..3
    const payload = parts[5] ?? "";
    const sampleFields = (isHold ? payload.split(":").slice(1, 4) : payload.split(":").slice(0, 3)).map(Number);
    if (sampleFields.some((v) => Number.isFinite(v) && v !== 0)) {
      warnings.push({ code: "feature-dropped", message: `hitSample data at ${t} ms dropped` });
    }
    const lane = Math.max(0, Math.min(3, Math.floor((x * 4) / 512)));
    if (isHold) {
      const end = Number(payload.split(":")[0]); // endTime precedes hitSample
      if (!Number.isFinite(end) || end <= t) {
        warnings.push({ code: "feature-dropped", message: `invalid hold at ${t} ms dropped` });
        continue;
      }
      notes.push({ id: id++, t, lane, type: "hold", d: end - t });
    } else if (isTap) {
      notes.push({ id: id++, t, lane, type: "tap" });
    } else {
      warnings.push({ code: "feature-dropped", message: `unsupported hit object flags (${typeFlags}) at ${t} ms dropped` });
    }
    // C2: abort mid-parse — millions of lines must not reach pulses/sessionStorage
    if (notes.length > MAX_NOTES) throw new Error(`osu: too many hit objects (limit ${MAX_NOTES})`);
  }
  notes.sort((a, b) => a.t - b.t || a.lane - b.lane);

  return {
    meta: { title: meta("Title"), artist: meta("Artist"), creator: meta("Creator"), difficulty: meta("Version"), tags, previewMs },
    keys: 4,
    timing,
    notes,
    warnings,
    audioFilename: kv("AudioFilename"),
    mode,
    circleSize,
  };
}

/**
 * Assemble §12.1 candidate shape for canonicalizeBeatmap. Pulses are derived
 * from timing points: one per beat until the next point, s = 1.0 on the
 * bar-first beat else 0.5 (PLAN §12.1 permits recompute with strength default).
 */
export function candidateFromParsed(p: ParsedOsu, songKey: string): unknown {
  const durationMs = Math.max(0, ...p.notes.map((n) => n.t + (n.d ?? 0)), ...p.timing.map((tm) => tm.t)) + 1;
  const pulses: { t: number; s: number }[] = [];
  for (let i = 0; i < p.timing.length; i++) {
    const tp = p.timing[i]!;
    const nextT = p.timing[i + 1]?.t ?? durationMs;
    const beatMs = 60_000 / tp.bpm;
    for (let t = tp.t, beat = 0; t < nextT && t <= durationMs; t += beatMs, beat++) {
      if (pulses.length >= MAX_PULSES) throw new Error(`osu: too many pulses (limit ${MAX_PULSES})`);
      pulses.push({ t: Math.round(t), s: beat % tp.meter === 0 ? 1.0 : 0.5 });
    }
  }
  return {
    version: 1,
    meta: p.meta,
    song: { songKey, durationMs, audioOffsetMs: 0 },
    timing: p.timing,
    keys: 4,
    notes: p.notes,
    pulses,
    gen: { source: "import", importedFrom: "osu", timingSource: "imported" },
  };
}
