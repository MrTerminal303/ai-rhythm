"use client";

// W3 T19 (B2): local library page — list, play link, delete, unplayable labeling.
//
// Rows come from the T18 store's VERIFYING list read (listCharts default
// verifyAudio=true): missing/corrupt audio bytes flip the row to "damaged" so the
// unplayable badge renders from the hash-verified state, never a manual markDamaged
// (review P0). Play links use T15's ?libraryChartId= scheme — never ?chart=.
import Link from "next/link";
import { useEffect, useState } from "react";
import { deleteChart, importChartWithAudio, listCharts, type ChartRecord, type AudioMeta } from "../../library/db.js";

// W3 T19 (B2) E2E seam — same NEXT_PUBLIC_E2E gate as the calibrate page's __calibrateTest
// and the play page's __w2 hook (inlined at build; the Playwright webServer sets it, prod
// builds leave it unset → seam absent). importChartWithAudio is a stable module-scope
// import, so the seam is registered once on mount (not per-render) and never deleted:
// e2e drives it before navigating away, and a later re-mount re-registers the same
// reference (mirror of __w2's teardown, minus the delete since the binding is stable).
declare global {
  interface Window {
    __lib?: {
      importForTest(
        chart: unknown,
        audioBytes: ArrayBuffer,
        audioMeta?: AudioMeta,
      ): Promise<string>;
    };
  }
}

export default function LibraryPage() {
  const [rows, setRows] = useState<ChartRecord[] | null>(null);
  useEffect(() => {
    void listCharts().then(setRows);
  }, []);
  // E2E seam — stable importChartWithAudio reference, registered once per mount.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_E2E === "1") {
      window.__lib = {
        importForTest: (chart, audioBytes, audioMeta) =>
          importChartWithAudio({
            chart,
            audioBytes,
            audioMeta: audioMeta ?? { durationMs: 60_000, sampleRate: 44_100, channels: 1 },
          }).then((r) => r.chartId),
      };
    }
  }, []);

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(`Delete "${id.slice(0, 8)}…"? This cannot be undone.`)) return;
    await deleteChart(id);
    setRows(await listCharts());
  };

  if (rows === null) {
    return (
      <main data-testid="library-list">
        <p style={{ color: "var(--text-dim)" }}>Loading…</p>
      </main>
    );
  }

  if (rows.length === 0) {
    return (
      <main>
        <p data-testid="library-empty">No songs yet.</p>
        <Link href="/import">Import a song</Link>
      </main>
    );
  }

  return (
    <main data-testid="library-list">
      {rows.map((r) => {
        const unplayable = r.state === "damaged";
        return (
          <div key={r.chartId} data-testid="library-row">
            <span>{r.title}</span>
            <span>{r.difficulty}</span>
            <span>{r.nps.toFixed(1)} NPS</span>
            <span>{r.noteCount} notes</span>
            {unplayable && <span data-testid="unplayable-badge">unplayable</span>}
            <Link
              href={`/play?libraryChartId=${r.chartId}`}
              aria-disabled={unplayable || undefined}
              onClick={(e) => {
                if (unplayable) e.preventDefault();
              }}
            >
              Play
            </Link>
            <button type="button" onClick={() => void remove(r.chartId)}>
              Delete
            </button>
          </div>
        );
      })}
    </main>
  );
}
