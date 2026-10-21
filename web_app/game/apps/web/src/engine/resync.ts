// apps/web/src/engine/resync.ts — A11 (spec §3 A11, arch §15/P1.10).
// W3 only REPRESENTS an interruption as a defined recovery phase (W4 boundary: full
// AudioContext interruption-recovery implementation is W4). The 2 s output-latency poll
// (W2 T12) is retained as documented fallback — no reliable cross-browser
// output-device-change event exists — and is subsumed into this machine.
export type ResyncState = "aligned" | "resyncing" | "recovery-paused";
export type ResyncEventType = "device-change" | "alignment-ok" | "alignment-lost" | "interruption" | "user-resume";

export const RESYNC_TRANSITIONS: Readonly<Record<ResyncState, Partial<Record<ResyncEventType, ResyncState>>>> = {
  aligned: { "device-change": "resyncing", interruption: "recovery-paused" },
  resyncing: { "alignment-ok": "aligned", "alignment-lost": "recovery-paused", interruption: "recovery-paused" },
  "recovery-paused": { interruption: "recovery-paused", "user-resume": "resyncing" },
};

export class ResyncController {
  private state: ResyncState;
  constructor(initial: ResyncState = "aligned") { this.state = initial; } // production: default only
  get current(): ResyncState { return this.state; }
  dispatch(event: ResyncEventType): ResyncState {
    const next = RESYNC_TRANSITIONS[this.state][event];
    if (next === undefined) throw new Error(`illegal resync transition: ${this.state} --${event}-->`);
    this.state = next;
    return next;
  }
}
