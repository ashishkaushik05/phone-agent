import type { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { makeRepos, CallEngine } from "./call-engine.ts";
import { makePgDb, makePgliteDb } from "./db.ts";
import { migrate } from "./migrate.ts";
import { buildServer } from "./server.ts";
import { makeBus, makeLocalBus } from "./redis.ts";
import { DeviceRegistry } from "./devices.ts";
import { WhatsappClient } from "./whatsapp.ts";
import type { CoreMsg } from "./protocol.ts";

const db = config.databaseUrl ? makePgDb(config.databaseUrl) : makePgliteDb();
await migrate(db);
const repos = makeRepos(db);

/** Connected phone-connector sockets, keyed by device_id. */
const registry = new DeviceRegistry();
const sendToDevice = (id: string, m: CoreMsg) => {
  const c = registry.get(id);
  if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  else console.error("[main] device not connected:", id, m.type);
};

/** Dashboard WS clients — fed engine events for the live call view. */
const dashClients = new Set<WebSocket>();

/**
 * Fan-out bus between the engine and the dashboard sockets.
 * - local bus: in-process pass-through (single hermes-core instance)
 * - Redis bus: pub/sub on `hermes:events`, so events reach dashboard
 *   clients attached to any hermes-core instance.
 */
const bus = config.redisUrl ? makeBus(config.redisUrl) : makeLocalBus();
await bus.subscribe((callId, ev) => {
  const payload = JSON.stringify({ callId, ...(ev as object) });
  for (const c of dashClients) if (c.readyState === c.OPEN) c.send(payload);
});

/** File-based session (see spec §7) — survives a hermes-core restart even in dev, where the
 *  message DB itself (PGlite) doesn't. Resolved off this module's own location, not cwd. */
const whatsappAuthDir = fileURLToPath(new URL("../data/whatsapp-auth", import.meta.url));
const whatsapp = new WhatsappClient({
  repo: repos.whatsapp,
  authDir: whatsappAuthDir,
  onChange: () => void bus.publish("", { kind: "whatsapp" }),
});
void whatsapp.start(); // connects with existing creds if paired; else waits "unpaired" for POST /whatsapp/pair

const engine = new CallEngine(repos, {
  onEvent: (callId, ev) => void bus.publish(callId, ev),
  whatsapp,
});

const server = buildServer({
  repos,
  engine,
  registry,
  sendToDevice,
  whatsapp,
  attachDashboard: (wss) => {
    wss.on("connection", (ws) => {
      dashClients.add(ws);
      ws.on("close", () => dashClients.delete(ws));
    });
  },
});

server.listen(config.port, () => {
  console.log(`hermes-core listening on :${config.port}  (director: ${config.directorMode})`);
  console.log(`  WSS   ws://localhost:${config.port}/phone · ws://localhost:${config.port}/dashboard`);
  console.log(`  REST  /health · /personas · /contacts · /calls`);
});
