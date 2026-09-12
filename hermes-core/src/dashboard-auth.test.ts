import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { freshDb } from "./test/db.ts";
import { makeRepos, CallEngine } from "./call-engine.ts";
import { buildServer } from "./server.ts";
import { DeviceRegistry } from "./devices.ts";
import { WhatsappClient } from "./whatsapp.ts";

let base: string;
let server: ReturnType<typeof buildServer>;

beforeEach(async () => {
  const repos = makeRepos(await freshDb());
  const whatsapp = new WhatsappClient({ repo: repos.whatsapp, authDir: "/tmp/unused-whatsapp-auth" });
  server = buildServer({ repos, engine: new CallEngine(repos), registry: new DeviceRegistry(), sendToDevice: () => {}, whatsapp });
  await new Promise<void>((r) => server.listen(0, r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

function tryConnect(url: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      resolve("open");
      ws.close();
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? -1));
    ws.on("error", () => {}); // the unexpected-response handler already resolved; avoid an unhandled error
  });
}

describe("/dashboard WS auth", () => {
  it("rejects a connection with no token", async () => {
    expect(await tryConnect(`${base}/dashboard`)).toBe(401);
  });

  it("rejects a connection with the wrong token", async () => {
    expect(await tryConnect(`${base}/dashboard?token=nope`)).toBe(401);
  });

  it("accepts a connection with the configured control token", async () => {
    expect(await tryConnect(`${base}/dashboard?token=smoke-token`)).toBe("open");
  });
});
