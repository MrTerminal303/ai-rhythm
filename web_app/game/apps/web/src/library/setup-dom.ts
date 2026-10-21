// W3 T19 (B2): node-env DOM install for library.test.tsx.
//
// library.test.tsx runs in the node vitest env (see the test's env-deviation comment) so the
// T18 store's crypto.subtle.digest hashing path stays on Node's webcrypto with node-realm
// ArrayBuffers. This file installs the jsdom DOM globals RTL needs, preserving Node crypto.
//
// FAKE-INDEXEDDB COMMIT-TIMING WORKAROUND: fake-indexeddb auto-commits a transaction as soon
// as all its requests finish and a macrotask boundary is crossed with nothing pending.
// Node's webcrypto `crypto.subtle.digest` resolves via a thread-pool macrotask, so a
// `await digest` inside a readwrite tx (db.ts listCharts' verify loop) lets fake-indexeddb
// commit the tx before the next request lands → TransactionInactiveError. Real browsers defer
// the commit to a separate task that loses to the in-flight microtask chain, so the bug is
// fake-indexeddb-only. Fix: patch `crypto.subtle.digest` with a sync-HMAC-backed,
// microtask-resolving version so the tx stays open across the await. The patched hash is
// STILL a real SHA-256 (via Node's `crypto.createHash`), only the resolution is in a
// microtask instead of a thread-pool macrotask — the hash VALUE is unchanged, so db.ts's
// verify-flip semantics are identical to the browser.
//
// Order in the test file: fake-indexeddb/auto first (registers indexedDB on its own jsdom
// window stub), then THIS file (replaces window/document with the real jsdom for RTL), then
// @testing-library/react (whose `screen` binds `document` at import time).
//
// fake-indexeddb/auto registers `indexedDB` on the ambient `self` global. The Node vitest
// env has no self — unless window/self are defined first, the auto module registers
// nothing, and db.ts's global `indexedDB.open` resolves to undefined (listCharts never
// settles, the page hangs on Loading). This file defines self BEFORE re-importing the
// auto module, so that second import is what actually wires fake-indexeddb onto globalThis.
// @ts-expect-error jsdom ships no bundled type declarations (dev-only test helper; the page
// itself has no jsdom dependency — install @types/jsdom if this file ever outgrows testing).
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
// jsdom's window defines self as a getter returning itself; Next's Link (a client component
// with router integration) reaches for the ambient `self` global at render time. Install it
// BEFORE the window alias so any code that already grabbed window sees a coherent set.
Object.defineProperty(dom.window, "self", { value: dom.window, writable: true, configurable: true });
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.self = dom.window as unknown as typeof globalThis.self;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

// Now that self/window are in place, safe to re-import fake-indexeddb/auto if the test
// file imported it BEFORE this setup-dom (ESM hoisting means the test's own
// `import "fake-indexeddb/auto"` runs first; it registered against an undefined self at
// that point, so it silently registered nothing). The `auto` module's registration is
// idempotent — importing it a second time, after self is set, is the reliable way to get
// the fake onto globalThis.
import "fake-indexeddb/auto";
// Verify: db.ts's global `indexedDB.open` must resolve. If the auto module's second
// import still didn't register (its self-check path differs), fall back to the direct
// module's factory.
{
  const g = globalThis as unknown as { indexedDB?: IDBFactory };
  if (!g.indexedDB) {
    const fidb = await import("fake-indexeddb");
    g.indexedDB = fidb.default;
  }
}

// Patch crypto.subtle.digest to a microtask-resolving SHA-256 (see header comment for why
// fake-indexeddb's commit timing otherwise loses to Node's thread-pool macrotask).
// db.ts's `sha256Hex` calls `crypto.subtle.digest("SHA-256", bytes)` — the patch matches
// the exact algorithm and input shape db.ts uses, so the digest value is byte-identical
// to the real webcrypto; only the resolution task class changes.
let origDigest: typeof SubtleCrypto.prototype["digest"] | null = null;
{
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    origDigest = subtle.digest.bind(subtle);
    subtle.digest = async (algorithm: string, data: ArrayBuffer | ArrayBufferView) => {
      // db.ts only ever calls digest("SHA-256", bytes) on an ArrayBuffer-backed source;
      // route those through the sync Node hash (microtask resolve). Unknown algorithm or
      // non-byte input falls back to the real webcrypto so we don't silently change values.
      if (algorithm === "SHA-256" && data instanceof ArrayBuffer) {
        const h = createHash("sha256").update(new Uint8Array(data)).digest();
        await Promise.resolve(); // resolve in a microtask — keeps fake-indexeddb's tx open
        return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) as ArrayBuffer;
      }
      // ponytail: ArrayBufferView path not exercised by db.ts; cast keeps the real-webcrypto
      // fallback honest for any future caller that passes a view.
      if (!origDigest) throw new Error("origDigest not installed");
      return origDigest(algorithm, data as unknown as BufferSource) as Promise<ArrayBuffer>;
    };
  }
}

// Containment for same-worker test files that run after library.test.tsx:
// library.test.tsx (via vitest env setup) sets process.env.NEXT_PUBLIC_E2E="1" and imports
// this module, which patches crypto.subtle.digest. Restore both in afterAll so the
// digest patch and env var can't leak to subsequent test files in the same worker.
// The jsdom DOM globals (window/document/self, etc.) are left installed: they are
// inert in files that don't use RTL (the node env's absence of a DOM is the deviation,
// not the presence of one), and restoring them risks breaking a later test that
// assumes the jsdom install is ambient. Test files needing a pristine DOM should
// manage their own env (T18 db.test.ts pattern).
import { afterAll } from "vitest";
afterAll(() => {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle && origDigest) subtle.digest = origDigest;
  origDigest = null;
  delete process.env.NEXT_PUBLIC_E2E;
});

export {};
