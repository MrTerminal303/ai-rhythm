// e2e/w3-journey-import.spec.ts
// W3 T26 — spec §7 journey 1: the IMPORT journey, end to end in a real browser.
//
//   /import + real short.osu + real short.webm  →  the T18 store holds the chart,
//   holds its audio asset, the two content hashes are DISTINCT (the audio bytes are not
//   the chart bytes), and a consistency walk finds NO chart whose `audioHash` has no
//   matching `audioAssets` row (the observable form of B1's atomicity contract).
//
// The fixtures are the committed 30 s generated song pair (`apps/web/public/songs/`), not a
// click track or a synthetic blob. All input goes through real Playwright file inputs.
import { expect, test } from "@playwright/test";
import { chartWithoutAudio, importSong, readStore, shot } from "./journey-helpers";

test("journey 1: /import stores the real song's chart + audio, hashes distinct, store consistent", async ({
  page,
}) => {
  const chartId = await importSong(page);
  expect(chartId.length).toBeGreaterThan(0);

  const store = await readStore(page);
  const chart = store.charts.find((c) => c.chartId === chartId);
  if (!chart) throw new Error(`no stored chart row for ${chartId} — import did not persist`);
  expect(chart.state).toBe("playable");
  // Real metadata read back from the generated .osu, not the filename.
  expect(chart.title).toBe("short");
  expect(chart.difficulty).toBe("W3 Fix");
  expect(chart.noteCount).toBe(71);
  expect(chart.nps).toBeGreaterThan(0);

  // Audio row exists, keyed by the chart's audioHash.
  expect(store.audioHashes).toContain(chart.audioHash);
  // Audio hash ≠ chart hash — the two content addresses cover different bytes.
  expect(chart.audioHash).not.toBe(chart.chartHash);

  // Atomicity, observable form: a walk over BOTH stores finds no orphan chart.
  expect(chartWithoutAudio(store)).toEqual([]);
  // Measured values for the evidence checklist (the assertions above are the gate).
  console.log(
    `[w3-journey-1] title=${chart.title} difficulty=${chart.difficulty} notes=${chart.noteCount} ` +
      `nps=${chart.nps.toFixed(3)} audioHash=${chart.audioHash.slice(0, 12)}… ` +
      `chartHash=${chart.chartHash.slice(0, 12)}… distinct=${chart.audioHash !== chart.chartHash} ` +
      `orphanCharts=${chartWithoutAudio(store).length} audioAssets=${store.audioHashes.length}`,
  );
  await shot(page, "w3-journey-1-import.png");
});
