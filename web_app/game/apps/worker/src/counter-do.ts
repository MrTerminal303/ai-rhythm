import { DurableObject } from "cloudflare:workers"; // current class form (super(ctx, env)); not the legacy `implements` shape

export class CounterDO extends DurableObject<unknown> {
  // <unknown> env: base default is Cloudflare.Env; brief's constructor takes env: unknown
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env); // required by the DurableObject base class
    // idempotent (IF NOT EXISTS / INSERT OR IGNORE), but hibernation re-creates the object in
    // memory after idle — keep constructor work minimal; move heavier init to an explicit
    // setup path in a later phase if anything beyond these two statements is ever added.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec("INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)");
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/health-db") {
      const r = this.ctx.storage.sql.exec("SELECT 1").one();
      return Response.json({ ok: true, db: r && Object.values(r).includes(1) ? "ok" : "error" });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);

    // read-modify-write is atomic WITHOUT an explicit transaction: Cloudflare's SQLite
    // storage operations are synchronous, and there is no intervening await between the
    // SELECT and the UPDATE, so no other request can interleave (current docs guarantee
    // sync-without-await atomicity in SQLite-backed DOs).
    const row = this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM counter WHERE id = 1").one();
    const next = row.value + 1;
    this.ctx.storage.sql.exec("UPDATE counter SET value = ? WHERE id = 1", next);
    server.send(JSON.stringify({ type: "welcome", count: next }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") ws.send("pong");
    else ws.send(message); // echo anything else
  }

  override webSocketClose(_ws: WebSocket): void {
    // hibernation notification only — do NOT call ws.close() here (connection is already closed)
  }
}
