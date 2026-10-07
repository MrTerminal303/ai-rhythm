import { CounterDO } from "./counter-do.js";
import { isFresh, nextCache, type HealthCache } from "./health-cache.js";

export { CounterDO };

let healthCache: HealthCache = null;

interface Env {
  COUNTER: DurableObjectNamespace;
}

// W2 smoke-test DO: no auth yet by design — auth is deferred to W4 (rooms get
// real state and identity). Until then the only hardening is the Origin check
// on /echo and /ws below (missing Origin = non-browser client, e.g. the smoke
// script's fetch/undici WebSocket → allowed).
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const wantDb = url.searchParams.get("db") === "1";
      if (!wantDb) {
        const now = Date.now();
        if (isFresh(healthCache, now)) {
          return json({ ok: true, cached: true });
        }
        healthCache = nextCache(now);
        return json({ ok: true, cached: false });
      }
      // /health?db=1 → bypass cache → DO fetch → SELECT 1
      const stub = env.COUNTER.idFromName("health");
      const res = await env.COUNTER.get(stub).fetch("https://do/health-db");
      return res;
    }

    if (url.pathname === "/echo") {
      if (!sameHostOrigin(request)) return json({ error: "origin not allowed" }, 403);
      const msg = url.searchParams.get("msg");
      if (msg === null) return json({ error: "msg required" }, 400);
      return json({ msg }); // json() sets an explicit application/json content type — kills MIME-sniff reflection
    }

    if (url.pathname === "/ws") {
      if (!sameHostOrigin(request)) return json({ error: "origin not allowed" }, 403);
      // ONE deterministic DO named "smoke": a unique name per run would leave a new
      // persistent named DO in production forever (stored DOs are never garbage-collected).
      // Counts accumulate across runs by design — the smoke script asserts relative
      // increments (session2 = session1 + 1), never absolute 1 → 2.
      const stub = env.COUNTER.idFromName("smoke");
      return env.COUNTER.get(stub).fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

/**
 * I1: when a browser sends Origin on /echo or /ws, it must be same-host as the
 * request; missing Origin (curl, Node smoke script) is allowed — see header comment.
 * Unparseable Origin (e.g. "null") → rejected.
 */
function sameHostOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200): Response {
  // Explicit charset=utf-8 JSON content type — never relies on sniffing
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
