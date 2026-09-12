import { describe, it, expect, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import { freshDb } from "./test/db.ts";
import { makeRepos, CallEngine } from "./call-engine.ts";
import { buildServer } from "./server.ts";
import { DeviceRegistry } from "./devices.ts";
import { WhatsappClient } from "./whatsapp.ts";

let base: string;

beforeEach(async () => {
  const repos = makeRepos(await freshDb());
  const whatsapp = new WhatsappClient({ repo: repos.whatsapp, authDir: "/tmp/unused-whatsapp-auth" });
  const server = buildServer({ repos, engine: new CallEngine(repos), registry: new DeviceRegistry(), sendToDevice: () => {}, whatsapp });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

describe("dashboard static", () => {
  it("serves the SPA shell at /", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("hermes-core");
  });

  it("serves app.js with a JS content-type", async () => {
    const r = await fetch(`${base}/dashboard/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
  });

  it("rejects path traversal", async () => {
    const r = await fetch(`${base}/dashboard/..%2f..%2fpackage.json`);
    expect(r.status).toBe(404);
  });
});
