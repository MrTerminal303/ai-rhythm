import { canonicalizeBeatmap, canonicalJson, type Beatmap } from "@airhythm/shared";

/** canonical bytes are the `.dbm.json` format */
export function exportDbm(b: Beatmap): string {
  return canonicalJson(b);
}

export function importDbm(text: string): Beatmap {
  return canonicalizeBeatmap(JSON.parse(text));
}

/**
 * v14 mania export (Mode 3 — spec §5.2 "Mode:4" is a recorded typo).
 * Known gaps: no SV export, no hitsounds — spec §5.2.
 */
export function exportOsu(b: Beatmap, audioFilename: string): string {
  const lines: string[] = [];
  lines.push("osu file format v14", "", "[General]");
  lines.push(`AudioFilename: ${audioFilename}`, "Mode: 3", "", "[Metadata]");
  lines.push(
    `Title:${b.meta.title}`,
    `Artist:${b.meta.artist}`,
    `Creator:${b.meta.creator}`,
    `Version:${b.meta.difficulty}`,
    `Tags:${b.meta.tags.join(" ")}`,
    `PreviewTime:${b.meta.previewMs}`,
    "",
    "[Difficulty]",
  );
  lines.push(
    "HPDrainRate:5",
    "CircleSize:4",
    "OverallDifficulty:8",
    "ApproachRate:9",
    "SliderMultiplier:1.4",
    "SliderTickRate:1",
    "",
    "[TimingPoints]",
  );
  for (const t of b.timing) lines.push(`${t.t},${60_000 / t.bpm},${t.meter},2,0,60,1,0`); // full float precision — no quantization
  lines.push("", "[HitObjects]");
  for (const n of b.notes) {
    const x = Math.round(((n.lane + 0.5) * 512) / 4);
    if (n.type === "hold") lines.push(`${x},192,${n.t},128,0,${n.t + (n.d ?? 0)}:0:0:0:0:`);
    else lines.push(`${x},192,${n.t},1,0,0:0:0:0:`);
  }
  return lines.join("\n") + "\n";
}
