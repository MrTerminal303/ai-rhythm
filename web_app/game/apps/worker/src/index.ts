import { CounterDO } from "./counter-do.js";
import { isFresh, nextCache, type HealthCache } from "./health-cache.js";

export { CounterDO };

let healthCache: HealthCache = null;

interface Env {
  COUNTER: DurableObjectNamespace;
}

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
      const msg = url.searchParams.get("msg");
      if (msg === null) return json({ error: "msg required" }, 400);
      return json({ msg });
    }

    if (url.pathname === "/ws") {
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

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
