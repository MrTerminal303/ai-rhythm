// Node 22+: global WebSocket client (D5 — no ws dependency)
// accepts either: node scripts/smoke.mjs <baseUrl>  OR  WORKER_URL=<url> node scripts/smoke.mjs
//   (Git Bash env-prefix form; PowerShell: $env:WORKER_URL="<url>"; node scripts/smoke.mjs)
const base = process.argv[2] ?? process.env.WORKER_URL;
if (!base) {
  console.error("usage: node scripts/smoke.mjs <baseUrl>   (or set WORKER_URL)");
  process.exit(2);
}
// Single deterministic DO ("smoke") in the worker — counts accumulate across runs,
// so assertions are relative (session2 = session1 + 1), never absolute 1 → 2.
// NOT concurrency-safe: never run two smoke processes against the same Worker at once
// (both increment this one DO; interleaved +1 assertions would fail).
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
};

// 1. health (twice — exercises the D6 cache when both requests land in the same isolate)
const h1 = await (await fetch(`${base}/health`)).json();
const h2 = await (await fetch(`${base}/health`)).json();
check("health ok", h1.ok === true && h2.ok === true, JSON.stringify([h1, h2]));
// The cache is isolate-local (in-module state): consecutive requests are NOT guaranteed
// the same isolate, so `cached: true` cannot be required — assert the field's shape only.
check("health cached field is boolean", typeof h2.cached === "boolean", JSON.stringify(h2));

// 2. health?db=1 → SELECT 1 in DO
const hd = await (await fetch(`${base}/health?db=1`)).json();
check("health db", hd.ok === true && hd.db === "ok", JSON.stringify(hd));

// 3. echo
const e = await (await fetch(`${base}/echo?msg=hi`)).json();
check("echo", e.msg === "hi", JSON.stringify(e));

// 4. DO WS session 1 (deterministic "smoke" DO): welcome count + ping/pong, then close
// Native WebSocket (browser-compatible API, global since Node 22): addEventListener, event.data
const connect = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
    const out = {};
    let settled = false;
    const timer = setTimeout(() => finish(new Error("ws timeout")), 5000);
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve(value);
    }
    ws.addEventListener("message", (event) => {
      const s = String(event.data);
      if (s.startsWith("{")) Object.assign(out, JSON.parse(s));
      else if (s === "pong") out.pong = true;
      if (out.welcomed !== undefined && out.pong) finish(null, out);
      if (out.count !== undefined && out.welcomed === undefined) {
        out.welcomed = true;
        ws.send("ping");
      }
    });
    ws.addEventListener("error", () => finish(new Error("ws error")));
    ws.addEventListener("close", () => finish(new Error("ws closed before handshake complete")));
  });

const s1 = await connect();
check("session1 welcome count≥1", Number.isInteger(s1.count) && s1.count >= 1 && s1.pong === true, JSON.stringify(s1));

// 5. DO WS session 2 (same deterministic DO): counter increments across sessions
const s2 = await connect();
check("session2 = session1 + 1 (persisted)", s2.count === s1.count + 1, JSON.stringify([s1, s2]));

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("smoke OK");
