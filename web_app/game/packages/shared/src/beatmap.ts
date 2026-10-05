import { z } from "zod";
import { KEY_COUNT, PULSE_DURATION_MS } from "./constants.js";

const msInt = z.number().int();

const noteSchema = z.object({
  id: z.number().int().nonnegative(),
  t: msInt.nonnegative(),
  lane: z.number().int().min(0).max(3),
  type: z.enum(["tap", "hold"]),
  tier: z.enum(["primary", "secondary"]).optional(),
  d: msInt.positive().optional(),
});

const pulseSchema = z.object({
  t: msInt.nonnegative(),
  s: z.number().min(0).max(1),
  k: z.string().optional(),
  durationMs: msInt.positive().optional().default(PULSE_DURATION_MS), // D4: spec §2.2 — default derives from constants.ts, not a restated 80
});

export const beatmapSchema = z
  .object({
    version: z.literal(1),
    meta: z.object({
      title: z.string(),
      artist: z.string(),
      creator: z.string(),
      difficulty: z.string(),
      tags: z.array(z.string()),
      previewMs: msInt.nonnegative(),
    }),
    song: z.object({
      songKey: z.string().min(1),
      durationMs: msInt.positive(),
      audioOffsetMs: msInt,
    }),
    timing: z
      .array(z.object({ t: msInt.nonnegative(), bpm: z.number().positive(), meter: z.number().int().positive() }))
      .min(1),
    keys: z.literal(KEY_COUNT),
    notes: z.array(noteSchema),
    pulses: z.array(pulseSchema),
    gen: z.object({
      source: z.enum(["manual", "import", "ai"]),
      importedFrom: z.enum(["osu", "sm", "ssc", "mc", "qua", "json"]).optional(),
      model: z.string().optional(),
      timingSource: z.enum(["imported", "detected", "manual"]),
    }),
  })
  .superRefine((b, ctx) => {
    const ids = new Set<number>();
    for (const [i, n] of b.notes.entries()) {
      if (ids.has(n.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notes", i, "id"], message: "Duplicate note id" });
      }
      ids.add(n.id);
      if (n.t > b.song.durationMs) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notes", i, "t"], message: "Note time after song durationMs" });
      }
      if (i > 0 && b.notes[i - 1]!.t > n.t) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notes", i, "t"], message: "Notes must be sorted by t" });
      }
      if (n.type === "hold") {
        if (n.d === undefined || n.t + n.d > b.song.durationMs) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notes", i, "d"], message: "Hold duration missing or beyond song durationMs" });
        }
      }
    }
    // no overlapping holds in one lane
    const holdsByLane = new Map<number, { t: number; end: number }[]>();
    for (const n of b.notes) {
      if (n.type !== "hold" || n.d === undefined) continue;
      const list = holdsByLane.get(n.lane) ?? [];
      for (const h of list) {
        if (n.t < h.end && h.t < n.t + n.d) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notes"], message: "Overlapping holds in one lane" });
          return;
        }
      }
      list.push({ t: n.t, end: n.t + n.d });
      holdsByLane.set(n.lane, list);
    }
    for (const [i, p] of b.pulses.entries()) {
      if (p.t > b.song.durationMs) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pulses", i, "t"], message: "Pulse time after song durationMs" });
      }
    }
    for (const [i, tm] of b.timing.entries()) {
      if (tm.t > b.song.durationMs) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timing", i, "t"], message: "Timing time after song durationMs" });
      }
    }
  });

export type Beatmap = z.infer<typeof beatmapSchema>;
export type BeatmapNote = Beatmap["notes"][number];

export function parseBeatmap(json: unknown): Beatmap {
  const result = beatmapSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`Invalid beatmap: ${first ? `${first.path.join(".")} — ${first.message}` : "unknown"}`);
  }
  return result.data;
}
