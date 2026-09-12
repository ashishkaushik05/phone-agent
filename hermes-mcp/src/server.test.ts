import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { buildHttpServer } from "./server.ts";

/** Starts the server on an ephemeral port and returns its base URL. */
async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  return `http://localhost:${addr.port}`;
}

describe("hermes-mcp HTTP server", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("rejects a request to /mcp with no bearer", async () => {
    server = buildHttpServer({ baseUrl: "http://unused.test", token: "secret" });
    const base = await start(server);
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });

  it("rejects a request to /mcp with the wrong bearer", async () => {
    server = buildHttpServer({ baseUrl: "http://unused.test", token: "secret" });
    const base = await start(server);
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });

  it("404s any path other than /mcp", async () => {
    server = buildHttpServer({ baseUrl: "http://unused.test", token: "secret" });
    const base = await start(server);
    const r = await fetch(`${base}/whatever`, { headers: { authorization: "Bearer secret" } });
    expect(r.status).toBe(404);
  });

  it("completes a full initialize -> tools/list -> tools/call round trip with the right bearer", async () => {
    const fetchImpl = (async (url: string | URL) => {
      expect(String(url)).toBe("http://hermes-core.test/health");
      return new Response(JSON.stringify({ ok: true, calls: 0, devices: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    server = buildHttpServer({ baseUrl: "http://hermes-core.test", token: "secret", fetchImpl });
    const base = await start(server);
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer secret",
    };

    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    expect(init.status).toBe(200);

    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listText = await list.text();
    expect(listText).toContain('"name":"get_status"');
    expect(listText).toContain('"name":"send_whatsapp"');

    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_status", arguments: {} } }),
    });
    const callText = await call.text();
    expect(callText).toContain('\\"ok\\":true');
  });
});
