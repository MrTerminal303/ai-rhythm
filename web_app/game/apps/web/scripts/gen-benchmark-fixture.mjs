// Pure CLI — no exports, no main-check. Run: node gen-benchmark-fixture.mjs [--stdout]
// (An `import.meta.url === file://${process.argv[1]}` main-check would silently skip on
// Windows: import.meta.url is file:///E:/... while argv[1] is E:\... — never match.)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const durationMs = 180_000;
const noteCount = 900;
const notes = [];
for (let i = 0; i < noteCount; i++) {
  notes.push({ id: i, t: 1000 + i * 197, lane: i % 4, type: "tap" });
}
const pulses = [];
for (let b = 0; b < durationMs / 500; b++) {
  pulses.push({ t: b * 500, s: b % 4 === 0 ? 1 : 0.5, durationMs: 80 });
}
const json =
  JSON.stringify(
    {
      version: 1,
      meta: { title: "W1 Benchmark", artist: "AIRhythm", creator: "generated", difficulty: "benchmark", tags: ["w1", "perf"], previewMs: 0 },
      song: { songKey: "file:w1-benchmark", durationMs, audioOffsetMs: 0 },
      timing: [{ t: 0, bpm: 120, meter: 4 }],
      keys: 4,
      notes,
      pulses,
      gen: { source: "manual", timingSource: "manual" },
    },
    null,
    2,
  ) + "\n";

if (process.argv.includes("--stdout")) {
  process.stdout.write(json); // used by tests — no filesystem mutation
} else {
  const out = fileURLToPath(new URL("../fixtures/w1-benchmark-chart.json", import.meta.url));
  writeFileSync(out, json);
  console.log("wrote", out);
}
