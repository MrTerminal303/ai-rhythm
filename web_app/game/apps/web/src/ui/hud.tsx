import { useEffect, useRef, useState } from "react";
import type { GameSnapshot, JudgementEvent } from "../engine/types.js";

const JUDGE_LABEL: Record<string, string> = { perfect: "PERFECT", great: "GREAT", good: "GOOD", miss: "MISS" };
const JUDGE_VAR: Record<string, string> = {
  perfect: "var(--judge-perfect)",
  great: "var(--judge-great)",
  good: "var(--judge-good)",
  miss: "var(--judge-miss)",
};
const KEYS: [string, number][] = [["D", 0], ["F", 1], ["J", 2], ["K", 3]];
const POPUP_MS = 350; // popup retention (HUD state, not engine) — next frame's events:[] must not erase it

function latestJudge(events: readonly JudgementEvent[]): JudgementEvent | null {
  return events.length ? events[events.length - 1]! : null;
}

export function Hud({ snapshot, activeLanes }: { snapshot: GameSnapshot | null; activeLanes: number[] }) {
  const score = snapshot?.score ?? 0;
  const combo = snapshot?.combo ?? 0;
  const accuracy = snapshot?.accuracy ?? 0;

  // popup lives in HUD state for POPUP_MS — snapshots arrive every frame with events:[],
  // so deriving the popup from snapshot.events directly would show it for ~1 frame
  const [popup, setPopup] = useState<string | null>(null);
  const popupTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!snapshot || snapshot.events.length === 0) return;
    const judge = latestJudge(snapshot.events)!;
    setPopup(judge.type === "hit" ? judge.grade : "miss");
    window.clearTimeout(popupTimer.current);
    popupTimer.current = window.setTimeout(() => setPopup(null), POPUP_MS);
  }, [snapshot]);
  useEffect(() => () => window.clearTimeout(popupTimer.current), []); // unmount cleanup only

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 p-4">
      <div className="flex w-full max-w-[480px] items-baseline justify-between text-sm">
        <span data-testid="score" className="text-xl" style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
          {score.toLocaleString("en-US")}
        </span>
        <span data-testid="accuracy" style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {(accuracy * 100).toFixed(2)}%
        </span>
      </div>
      <div data-testid="combo" className="text-2xl" style={{ color: "var(--you)", fontFamily: "var(--font-mono)" }}>
        COMBO {combo}
      </div>
      {popup && (
        <div data-testid="judge-popup" className="text-lg font-semibold" style={{ color: JUDGE_VAR[popup] }}>
          {JUDGE_LABEL[popup]}
        </div>
      )}
      <div className="absolute right-4 top-4 flex gap-2">
        {KEYS.map(([label, lane]) => (
          <span
            key={label}
            data-key={label}
            className="flex h-9 w-9 items-center justify-center rounded-[6px] border text-sm"
            style={{
              borderColor: "var(--line)",
              background: activeLanes.includes(lane) ? "var(--you)" : "var(--surface)",
              color: activeLanes.includes(lane) ? "var(--bg)" : "var(--text-dim)",
              transition: "background 120ms cubic-bezier(0.22,1,0.36,1)",
            }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
