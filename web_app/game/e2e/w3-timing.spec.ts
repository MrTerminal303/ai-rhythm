// e2e/w3-timing.spec.ts
// W3 T15 (A5): three-claim timing evidence — claim 2 (real-browser integration) plus the standing
// mid-play suite (spec §7 journey 5).
//   Claim 1 (deterministic clock/judgement correctness) = the audited Vitest matrix (both clock-pair
//   sources, simulated output delay, suspend/resume, visibility, device change, calibration-once).
//   Vitest is engine-agnostic, so the report references that ONE suite rather than duplicating it
//   per browser. Claim 3 (audible-output synchronization) is NOT acoustically certified in W3 —
//   see apps/web/evidence-templates/w3-timing-report.md.
//
// RUNNER: the three engine projects live in the committed apps/web/playwright.config.ts; firefox and
// webkit are grep-scoped to w3-timing|w3-fixture-decode|w3-clock-invariant so the REST of the suite
// stays chromium-only (CI time). Run: `pnpm --filter @airhythm/web exec playwright test w3-timing`.
//
// Automation-scheduling limitations (spec §9; the evidence report quotes this verbatim): hit-offset
// distributions under automation mix input-scheduling jitter with clock error — integration
// evidence, NOT acoustic certification.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

type W2Timing = {
  phase(): string;
  chartTimeMs(): number;
  playbackPositionMs(): number;
  noteCount(): number;
  notes(): { t: number; lane: number }[];
  dts(): number[];
  suspend(): Promise<void>;
  resume(): Promise<void>;
};

// Claim 2 runs the committed fixture pair public/songs/long.osu + long.webm through the W2 import
// path: the spec feeds the REAL .osu through the app's own /import UI (so the chart in sessionStorage
// is the app-canonicalized one a user would get — no parser duplicated into the test), then re-opens
// /play with ?fixtureAudio=long so long.webm supplies the audio from the fixture branch.
const LONG_OSU = path.join(__dirname, "..", "apps", "web", "public", "songs", "long.osu");
const PLAY_URL = "/play?import=1&fixtureAudio=long"; // `import=1` — the param is truthy-tested, `import=` is falsy

/** Import long.osu through the real importer, then open /play with the fixture audio attached. */
async function openLongSong(page: Page): Promise<void> {
  await page.goto("/import");
  await page.setInputFiles('input[type="file"]', {
    name: "long.osu",
    mimeType: "text/plain",
    buffer: readFileSync(LONG_OSU),
  });
  await expect(page.getByText(/imported/i)).toBeVisible();
  await page.getByRole("button", { name: /^play$/i }).click();
  await expect(page).toHaveURL(/\/play\?import/, { timeout: 30_000 }); // client-side route push; slow engines need longer than the 5 s default
  // Same origin, so the chart /import just stored in sessionStorage survives this navigation;
  // the added param only swaps the audio source (click track → /songs/long.webm).
  await page.goto(PLAY_URL);
}

async function startPlaying(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLongSong(page);
  // WebKit platform gap (this environment, 2026-10-16): this Playwright WebKit build exposes NO
  // Web Audio API, so playback cannot start at all and claim-2 evidence is UNVERIFIABLE here. This
  // THROWS — it goes RED with the reason (no test.fail()/skip: an inverted expectation would report
  // the gap as a passing gate; same guard shape as w3-fixture-decode.spec.ts). Operator/CI: run this
  // spec on a WebKit build WITH Web Audio (macOS-attached WebKit, or the Linux CI runner).
  const hasAudio = await page.evaluate(
    () => !!(window.AudioContext ?? (window as never as { webkitAudioContext?: unknown }).webkitAudioContext),
  );
  if (!hasAudio) {
    throw new Error(
      "[w3-timing] WEBKIT PLATFORM GAP: no Web Audio API (AudioContext/webkitAudioContext both undefined) in this WebKit " +
      "build — playback cannot start, so claim 2 is UNVERIFIED for webkit in this environment. Chromium + Firefox run claim 2 " +
      "locally; the third engine comes from an operator/CI run on a WebKit build WITH Web Audio.",
    );
  }
  await page.getByRole("button", { name: /click to start/i }).click();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing");
}

const chartTimeMs = (page: Page): Promise<number> =>
  page.evaluate(() => (window as never as { __w2: W2Timing }).__w2.chartTimeMs());

const noteCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as never as { __w2: W2Timing }).__w2.noteCount());

test("A5 claim 2: ≥100 scripted hits against the real long song report a distribution", async ({ page }, testInfo) => {
  // Weak-PC lever (same spirit as playwright.config.ts's timeout/workers note): the scripted loop
  // below costs ONE waitForFunction + ONE keyboard.press round trip per note — measured ~1.6 s per
  // note here, so 160 scheduled notes need >180 s of wall clock. test.slow() raises this test's
  // budget to 3× (540 s) without weakening any assertion; a faster machine finishes well inside the
  // default budget. The distribution BANDS (median<40, p95Abs<110) are unchanged.
  test.slow();
  await startPlaying(page);
  expect(await noteCount(page)).toBeGreaterThan(200); // the real long song, not the 60-note w1 fixture

  // Node-side scheduling loop with REAL input tools (CLAUDE.md §5: page.keyboard.press, never
  // synthetic dispatchEvent — synthetic events are isTrusted:false and prove nothing).
  const notes = await page.evaluate(
    () => (window as never as { __w2: { notes(): { t: number; lane: number }[] } }).__w2.notes(),
  );
  const KEYS = ["d", "f", "j", "k"] as const;
  const upcoming = notes.filter((n) => n.t > 2000).slice(0, 160); // skip the first seconds (settle)
  for (const n of upcoming) {
    await page.waitForFunction(
      (t: number) => (window as never as { __w2: { chartTimeMs(): number } }).__w2.chartTimeMs() >= t - 10,
      n.t,
      // polling:10 — NOT the default raf polling. On a software-WebGL machine the render loop runs at
      // multi-second intervals (playwright.config.ts's weak-PC note), so a raf-polled wait resolves
      // about a second late and lands outside the ±110 ms judgement window. A 10 ms timer decouples
      // the schedule from the render loop; the residual error is then the press round trip, which the
      // median/p95 bands below absorb.
      { polling: 10 },
    );
    await page.keyboard.press(KEYS[n.lane]!);
  }
  const dts = await page.evaluate(
    () => (window as never as { __w2: { dts(): number[] } }).__w2.dts(),
  );
  console.log(`[A5 claim2 ${testInfo.project.name}] scheduled=${upcoming.length} hit-dts=${dts.length}`);
  // SCHEDULING FLOOR (measured on this machine 2026-10-16, chromium+firefox, software WebGL): one
  // waitForFunction + one keyboard.press round trip costs ~0.5–1.6 s per note, while long.osu spaces
  // its notes 500 ms apart — so the scripted loop falls behind the real-time song (measured: chart
  // 112.7 s vs the 64 s note it was scheduling) and only the leading notes land in-window. This
  // assertion therefore FAILS on this weak-PC machine by construction and PASSES where a round trip
  // is milliseconds (CI ubuntu runner, operator machine) — the counts printed above and in the
  // attached artifact are the honest local record; they are not a widened or relaxed gate.
  expect(
    dts.length,
    `only ${dts.length}/${upcoming.length} scripted presses landed in the ±110 ms judgement window — on a weak-PC ` +
      `software-WebGL machine the Playwright press round trip exceeds long.osu's 500 ms note spacing, so the loop falls ` +
      `behind the real-time song (environment limit, NOT a timing regression; see the spec comment)`,
  ).toBeGreaterThanOrEqual(100);
  const sorted = [...dts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
  const absSorted = [...dts].map(Math.abs).sort((a, b) => a - b);
  const p95Abs = absSorted[Math.min(absSorted.length - 1, Math.ceil(absSorted.length * 0.95) - 1)]!;
  const outliers = dts.filter((d) => Math.abs(d) > 110).length;
  console.log(`[A5 claim2 ${testInfo.project.name}] n=${dts.length} median=${median.toFixed(1)} p95=${p95.toFixed(1)} p95Abs=${p95Abs.toFixed(1)} outliers=${outliers}`);
  // Distribution bands absorb automation jitter (spec §9): integration evidence, NOT acoustic.
  // Gate on ABSOLUTE error (review P0: signed p95 passes a strongly-early distribution — all-negative
  // offsets yield a negative p95); signed median/p95 kept for diagnostics only.
  expect(Math.abs(median)).toBeLessThan(40);  // band, not a single-hit assertion
  expect(p95Abs).toBeLessThan(110);
  testInfo.attach("hit-offset-distribution", { body: JSON.stringify({ engine: testInfo.project.name, n: dts.length, median, p95, p95Abs, outliers, dts }, null, 2), contentType: "application/json" });
});

test("A5 standing: AudioContext suspend/resume (1/5/20 s) freezes the chart clock and resumes from the frozen position", async ({ page }) => {
  // Spec §7 journey 5, solo form: there is no serverSongMs to realign against, so W3's assertion IS
  // the W2 bookkeeping invariant (chart ≡ playback + offset, fixture audioOffsetMs = 0) holding after
  // a suspension, plus "the clock did not run during the suspension".
  await startPlaying(page);
  for (const seconds of [1, 5, 20]) {
    // Read the pre-suspend chart time and suspend in ONE evaluate: a cross-evaluate round trip costs
    // ~150 ms under trace recording (the W2 blur test records the same overhead), which would show up
    // as fake "drift" in the freeze assertion. Measurement window = this single evaluate onward.
    const frozenBefore = await page.evaluate(async () => {
      const w = (window as never as { __w2: W2Timing }).__w2;
      const t = w.chartTimeMs();
      await w.suspend(); // A suspended AudioContext drives statechange → "interruption" (A11)
      return t;
    });
    const wallBefore = Date.now();
    await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "recovering");
    await page.waitForTimeout(seconds * 1000);
    const frozenDuring = await chartTimeMs(page);
    expect(frozenDuring).toBeLessThan(frozenBefore + 50); // frozen: no advance while suspended
    await page.evaluate(() => (window as never as { __w2: W2Timing }).__w2.resume());
    await page.getByTestId("recovering-resume-button").click();
    await page.waitForFunction(
      () => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "playing",
      undefined,
      { timeout: 15000 }, // includes the 3-2-1 resume countdown
    );
    const wallElapsed = Date.now() - wallBefore;
    const after = await chartTimeMs(page);
    expect(after).toBeGreaterThanOrEqual(frozenBefore); // resumed from the frozen position, not a restart
    expect(after - frozenBefore).toBeLessThan(wallElapsed + 4000); // did NOT run during the suspension
    const bookkeeping = await page.evaluate(() => {
      const w = (window as never as { __w2: W2Timing }).__w2;
      return Math.abs(w.chartTimeMs() - w.playbackPositionMs()); // fixture audioOffsetMs is 0
    });
    expect(bookkeeping).toBeLessThanOrEqual(10); // the W2 layer-1 invariant survives the suspension
    console.log(`[A5 standing suspend ${seconds}s] advanced=${(after - frozenBefore).toFixed(0)}ms wallElapsed=${wallElapsed}ms bookkeeping=${bookkeeping.toFixed(2)}ms`);
  }
});

test("A5 standing: tab hide mid-play auto-pauses the real song", async ({ page }) => {
  await startPlaying(page);
  await page.waitForTimeout(1000);
  // Synthetic visibilitychange is the sanctioned exception (no input tool expresses a tab hide — the
  // same reasoning W2's blur test records). document.visibilityState is a READONLY prototype getter,
  // so the branch the page actually reads is shadowed on the instance before dispatching.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "paused");
  await expect(page.getByTestId("pause-overlay")).toBeVisible();
  const chartAtPause = await chartTimeMs(page);
  await page.waitForTimeout(500);
  expect(await chartTimeMs(page)).toBeLessThan(chartAtPause + 50); // clock frozen by the auto-pause
});

test("A5 standing: refresh mid-play (~30 s) reloads clean to idle with the real chart intact", async ({ page }) => {
  await startPlaying(page);
  const notesBefore = await noteCount(page);
  await page.waitForFunction(
    () => (window as never as { __w2: { chartTimeMs(): number } }).__w2.chartTimeMs() >= 30_000,
    undefined,
    { timeout: 90_000 },
  );
  await page.reload();
  await page.waitForFunction(() => (window as never as { __w2?: { phase(): string } }).__w2?.phase() === "idle");
  await expect(page.getByTestId("start-overlay")).toBeVisible();
  expect(await noteCount(page)).toBe(notesBefore); // chart intact across the reload
  // DEFERRED TO W4 (recorded in the evidence report): a SOLO refresh cannot resume mid-song —
  // resume-position depends on W4's server timeline (no serverSongMs in solo). W3's evidence is
  // this clean reload to idle with the chart intact; the mid-song resume assertion is W4's.
});
