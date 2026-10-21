// A8: real handler test — assert the actual /echo + /health response shape
// (status + JSON body + content type), not a placeholder.
import { describe, expect, it } from "vitest";
// index.ts re-exports CounterDO, which imports the Workers-only
// `cloudflare:workers` virtual module — resolved via the vitest alias
// (vitest.config.mjs). The default export is the handler itself.
import defaultExport from "./index.js";

type Handler = {
  fetch(request: Request, env: { COUNTER: unknown }): Promise<Response>;
};
const handler = defaultExport as unknown as Handler;

const fetchJson = async (path: string, init?: RequestInit) => {
  const res = await handler.fetch(new Request(`https://worker.test${path}`, init), { COUNTER: null });
  const body = await res.json();
  return { status: res.status, body, contentType: res.headers.get("Content-Type") };
};

describe("worker /echo handler", () => {
  it("returns the msg with application/json content type", async () => {
    const { status, body, contentType } = await fetchJson("/echo?msg=ping");
    expect(status).toBe(200);
    expect(body).toEqual({ msg: "ping" });
    expect(contentType).toContain("application/json");
  });

  it("400 when msg is absent", async () => {
    const { status, body } = await fetchJson("/echo");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "msg required" });
  });

  it("403 for a cross-host Origin", async () => {
    const { status, body } = await fetchJson("/echo?msg=x", {
      headers: { Origin: "https://evil.example" },
    });
    expect(status).toBe(403);
    expect(body).toEqual({ error: "origin not allowed" });
  });
});

describe("worker /health handler", () => {
  it("returns { ok, cached } JSON", async () => {
    const first = await fetchJson("/health");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, cached: false }); // first hit populates the cache
    const second = await fetchJson("/health");
    expect(second.body).toEqual({ ok: true, cached: true }); // within TTL → cached
  });
});

describe("worker unknown route", () => {
  it("404 with JSON error body", async () => {
    const { status, body } = await fetchJson("/nope");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not found" });
  });
});
