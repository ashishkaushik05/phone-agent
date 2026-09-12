import { describe, it, expect } from "vitest";
import { makePgliteDb } from "./db.ts";
import { migrate } from "./migrate.ts";
import { makeRepos } from "./repos/index.ts";
import { buildServer } from "./server.ts";
import { CallEngine } from "./call-engine.ts";
import { DeviceRegistry } from "./devices.ts";
import { WhatsappClient } from "./whatsapp.ts";
import type { AddressInfo } from "node:net";

describe("boot", () => {
  it("migrate → repos → buildServer → /health responds", async () => {
    const db = makePgliteDb();
    await migrate(db);
    const repos = makeRepos(db);
    // never start()ed — no fs/socket activity, just satisfies buildServer's deps
    const whatsapp = new WhatsappClient({ repo: repos.whatsapp, authDir: "/tmp/unused-whatsapp-auth" });
    const server = buildServer({ repos, engine: new CallEngine(repos), registry: new DeviceRegistry(), sendToDevice: () => {}, whatsapp });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    server.close();
    await db.close();
  });
});
