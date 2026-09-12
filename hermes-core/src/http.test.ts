import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { freshDb } from "./test/db.ts";
import { makeRepos, CallEngine } from "./call-engine.ts";
import { buildServer } from "./server.ts";
import { DeviceRegistry } from "./devices.ts";
import type { WhatsappClient } from "./whatsapp.ts";
import type { CoreMsg } from "./protocol.ts";

/** A stand-in for WhatsappClient, same spirit as this file's `sendToDevice: (_id, m) => ...`
 *  fakes — http.test.ts only needs to verify the REST routes call through correctly, not
 *  WhatsappClient's own state machine (that's whatsapp.test.ts's job, see spec §9). */
function fakeWhatsapp() {
  const pairCalls: void[] = [];
  const sendCalls: { peer: string; body: string }[] = [];
  let status: { state: string; qr?: string } = { state: "unpaired" };
  const obj = {
    status: () => status,
    pair: async () => {
      pairCalls.push(undefined);
      status = { state: "qr-pending", qr: "data:image/png;base64,fake" };
    },
    send: async (peer: string, body: string) => {
      sendCalls.push({ peer, body });
      return { id: "wa-1", status: "queued" };
    },
  };
  return { whatsapp: obj as unknown as WhatsappClient, pairCalls, sendCalls, getStatus: () => status };
}

let base: string;
let sent: CoreMsg[];
let server: ReturnType<typeof buildServer>;

beforeEach(async () => {
  const repos = makeRepos(await freshDb());
  sent = [];
  const engine = new CallEngine(repos);
  // REST-triggered sends route to the sole connected device; register one fake phone.
  const registry = new DeviceRegistry();
  registry.register("phone-1", { readyState: 1, OPEN: 1, close() {}, send() {} } as unknown as import("ws").WebSocket);
  server = buildServer({ repos, engine, registry, sendToDevice: (_id, m) => sent.push(m), whatsapp: fakeWhatsapp().whatsapp });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

const auth = { authorization: "Bearer smoke-token", "content-type": "application/json" };

describe("REST", () => {
  it("GET /health is open", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
  });

  it("persona CRUD round-trips", async () => {
    const create = await fetch(`${base}/personas`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ id: "p1", name: "Test", systemInstruction: "You are a test.", triggerConfig: { needsData: [], escalation: [], offScript: [], closing: [] } }),
    });
    expect(create.status).toBe(201);
    const list = (await (await fetch(`${base}/personas`)).json()) as any[];
    expect(list.map((p: any) => p.id)).toContain("p1");
    const del = await fetch(`${base}/personas/p1`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
  });

  it("POST /personas without auth is 401", async () => {
    const r = await fetch(`${base}/personas`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });

  it("POST /calls queues an outbound call and pushes call.place", async () => {
    const r = await fetch(`${base}/calls`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+15551230000", script: "Confirm the meeting." }) });
    expect(r.status).toBe(202);
    const body = (await r.json()) as any;
    expect(body.status).toBe("queued");
    expect(sent.find((m) => m.type === "call.place")).toBeTruthy();
  });

  it("POST /calls with a persona_id places the call on that saved persona", async () => {
    await fetch(`${base}/personas`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ id: "screen", name: "Screener", systemInstruction: "You screen calls for Acme.", triggerConfig: { needsData: [], escalation: [], offScript: [], closing: [] } }),
    });
    const r = await fetch(`${base}/calls`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+15551230000", persona_id: "screen" }) });
    expect(r.status).toBe(202);
    const place = sent.find((m) => m.type === "call.place") as any;
    expect(place.system_instruction).toContain("screen calls for Acme");
  });

  it("POST /calls with an unknown persona_id is 404", async () => {
    const r = await fetch(`${base}/calls`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+15551230000", persona_id: "nope" }) });
    expect(r.status).toBe(404);
  });

  it("contact CRUD round-trips and GET is open", async () => {
    const create = await fetch(`${base}/contacts`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ id: "c1", phoneE164: "+15551239999", name: "Alice" }),
    });
    expect(create.status).toBe(201);
    const list = (await (await fetch(`${base}/contacts`)).json()) as any[];
    expect(list.map((c: any) => c.id)).toContain("c1");
    const del = await fetch(`${base}/contacts/c1`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
  });

  it("POST /calls/:id/inject wraps and pushes guidance, and persists it to the transcript", async () => {
    // create a live call first
    await fetch(`${base}/calls`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+1555" }) });
    const id = (sent.find((m) => m.type === "call.place") as any).call_id;
    const r = await fetch(`${base}/calls/${id}/inject`, { method: "POST", headers: auth, body: JSON.stringify({ text: "wrap up now" }) });
    expect(r.status).toBe(200);
    const inj = sent.find((m) => m.type === "call.inject") as any;
    expect(inj.text).toContain("<<DIRECTOR - act silently: wrap up now>>");

    const detail = (await (await fetch(`${base}/calls/${id}`)).json()) as any;
    expect(detail.transcript.at(-1)).toMatchObject({ role: "director", text: inj.text });
    expect(detail.actions.at(-1)).toMatchObject({ category: "manual", kind: "inject" });
  });

  it("POST /calls/:id/inject for an unknown call is 404 and never falls back to the sole connected device", async () => {
    const r = await fetch(`${base}/calls/no-such-call/inject`, { method: "POST", headers: auth, body: JSON.stringify({ text: "hi" }) });
    expect(r.status).toBe(404);
    expect(sent.find((m) => m.type === "call.inject")).toBeUndefined();
  });
});

const fakeWs = () =>
  ({ readyState: 1, OPEN: 1, close() {}, send() {} } as unknown as import("ws").WebSocket);

describe("REST device selection", () => {
  const servers: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  async function mk(deviceIds: string[]) {
    const repos = makeRepos(await freshDb());
    const routed: { id: string; m: CoreMsg }[] = [];
    const engine = new CallEngine(repos);
    const registry = new DeviceRegistry();
    for (const id of deviceIds) registry.register(id, fakeWs());
    const wa = fakeWhatsapp();
    const srv = buildServer({ repos, engine, registry, sendToDevice: (id, m) => routed.push({ id, m }), whatsapp: wa.whatsapp });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, r));
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return { base: b, routed, repos, wa };
  }

  it("POST /calls with one device and no device_id routes to that device", async () => {
    const { base, routed } = await mk(["phone-a"]);
    const r = await fetch(`${base}/calls`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+15551230000" }) });
    expect(r.status).toBe(202);
    const place = routed.find((x) => x.m.type === "call.place");
    expect(place?.id).toBe("phone-a");
  });

  it("POST /calls with zero devices is 409", async () => {
    const { base } = await mk([]);
    const r = await fetch(`${base}/calls`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+15551230000" }) });
    expect(r.status).toBe(409);
  });

  it("POST /calls with two devices and no device_id is 409", async () => {
    const { base } = await mk(["phone-a", "phone-b"]);
    const r = await fetch(`${base}/calls`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+15551230000" }) });
    expect(r.status).toBe(409);
  });

  it("POST /calls with two devices routes to the named device_id", async () => {
    const { base, routed } = await mk(["phone-a", "phone-b"]);
    const r = await fetch(`${base}/calls`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ to: "+15551230000", device_id: "phone-b" }),
    });
    expect(r.status).toBe(202);
    const place = routed.find((x) => x.m.type === "call.place");
    expect(place?.id).toBe("phone-b");
  });

  it("POST /calls/:id/hangup + /inject route to the call's OWNING device, not soleId()", async () => {
    const { base, routed } = await mk(["phone-a", "phone-b"]);
    // place a call on phone-b
    const c = await fetch(`${base}/calls`, {
      method: "POST", headers: auth, body: JSON.stringify({ to: "+15551230000", device_id: "phone-b" }),
    });
    const id = ((await c.json()) as any).call_id;

    const h = await fetch(`${base}/calls/${id}/hangup`, { method: "POST", headers: auth });
    expect(h.status).toBe(200);
    expect(routed.find((x) => x.m.type === "call.hangup")?.id).toBe("phone-b");

    const inj = await fetch(`${base}/calls/${id}/inject`, {
      method: "POST", headers: auth, body: JSON.stringify({ text: "wrap up" }),
    });
    expect(inj.status).toBe(200);
    expect(routed.find((x) => x.m.type === "call.inject")?.id).toBe("phone-b");
  });

  it("POST /calls/:id/hangup for an unknown call with 2+ devices is 409", async () => {
    const { base } = await mk(["phone-a", "phone-b"]);
    const r = await fetch(`${base}/calls/nope/hangup`, { method: "POST", headers: auth });
    expect(r.status).toBe(409);
  });

  it("POST /sms persists a row and pushes sms.send with the row id as client_ref", async () => {
    const { base, routed, repos } = await mk(["phone-a"]);
    const r = await fetch(`${base}/sms`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ to: "+15551230000", body: "hello there" }),
    });
    expect(r.status).toBe(202);
    const resBody = (await r.json()) as any;
    expect(resBody.status).toBe("queued");
    expect(resBody.sms_id).toBeTruthy();

    const rows = (await repos.sms.db.query(
      `SELECT id, direction, peer_e164, body, status, device_id FROM hermes.sms_messages`,
    )).rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("outbound");
    expect(rows[0].peer_e164).toBe("+15551230000");
    expect(rows[0].body).toBe("hello there");
    expect(rows[0].status).toBe("queued");
    expect(rows[0].device_id).toBe("phone-a");

    const sms = routed.find((x) => x.m.type === "sms.send");
    expect(sms?.id).toBe("phone-a");
    expect((sms?.m as any).client_ref).toBe(resBody.sms_id);
    expect((sms?.m as any).client_ref).toBe(String(rows[0].id));
  });

  it("GET /sms is open and lists recorded messages oldest first", async () => {
    const { base } = await mk(["phone-a"]);
    await fetch(`${base}/sms`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+1555", body: "one" }) });
    await fetch(`${base}/sms`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+1555", body: "two" }) });
    const list = (await (await fetch(`${base}/sms`)).json()) as any[];
    expect(list.map((m) => m.body)).toEqual(["one", "two"]);
  });

  it("POST /sms stores the peer in E.164 so it matches a contact row", async () => {
    const { base } = await mk(["phone-a"]);
    const r = await fetch(`${base}/sms`, { method: "POST", headers: auth, body: JSON.stringify({ to: "98765 43210", body: "hi" }) });
    expect(r.status).toBe(202);
    const rows = (await (await fetch(`${base}/sms`)).json()) as any[];
    expect(rows.at(-1).peer).toBe("+919876543210");
  });

  it("POST /sms missing body is 400", async () => {
    const { base } = await mk(["phone-a"]);
    const r = await fetch(`${base}/sms`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+1555" }) });
    expect(r.status).toBe(400);
  });

  it("POST /sms with zero devices is 409", async () => {
    const { base } = await mk([]);
    const r = await fetch(`${base}/sms`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+1555", body: "hi" }) });
    expect(r.status).toBe(409);
  });

  it("GET /health lists connected devices", async () => {
    const { base } = await mk(["phone-a", "phone-b"]);
    const h = (await (await fetch(`${base}/health`)).json()) as any;
    expect(h.ok).toBe(true);
    expect(Array.isArray(h.devices)).toBe(true);
    expect(h.devices).toHaveLength(2);
    expect(h.devices.map((d: any) => d.id).sort()).toEqual(["phone-a", "phone-b"]);
    expect(h.devices[0]).toHaveProperty("connectedAt");
    expect(h.devices[0]).toHaveProperty("lastSeen");
  });

  // ---- whatsapp: no device concept at all — GET/status are open, POST/pair need auth ----

  it("GET /whatsapp/status is open and returns the client's current status", async () => {
    const { base } = await mk([]);
    const r = await fetch(`${base}/whatsapp/status`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ state: "unpaired" });
  });

  it("GET /whatsapp/status needs no auth even though POST /whatsapp/pair does", async () => {
    const { base } = await mk([]);
    const noAuth = await fetch(`${base}/whatsapp/status`);
    expect(noAuth.status).toBe(200);
    const unauthedPair = await fetch(`${base}/whatsapp/pair`, { method: "POST" });
    expect(unauthedPair.status).toBe(401);
  });

  it("POST /whatsapp/pair calls pair() and returns the resulting status", async () => {
    const { base, wa } = await mk([]);
    const r = await fetch(`${base}/whatsapp/pair`, { method: "POST", headers: auth });
    expect(r.status).toBe(202);
    expect(wa.pairCalls).toHaveLength(1);
    expect(await r.json()).toEqual(wa.getStatus());
  });

  it("POST /whatsapp sends via the client and returns its id/status, no device_id involved", async () => {
    const { base, wa } = await mk([]); // zero devices — would 409 on /sms, irrelevant here
    const r = await fetch(`${base}/whatsapp`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ to: "+15551230000", body: "hello via whatsapp" }),
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ whatsapp_id: "wa-1", status: "queued" });
    expect(wa.sendCalls).toEqual([{ peer: "+15551230000", body: "hello via whatsapp" }]);
  });

  it("POST /whatsapp missing 'to' or 'body' is 400", async () => {
    const { base } = await mk([]);
    const noTo = await fetch(`${base}/whatsapp`, { method: "POST", headers: auth, body: JSON.stringify({ body: "hi" }) });
    expect(noTo.status).toBe(400);
    const noBody = await fetch(`${base}/whatsapp`, { method: "POST", headers: auth, body: JSON.stringify({ to: "+1555" }) });
    expect(noBody.status).toBe(400);
  });

  it("POST /whatsapp without auth is 401", async () => {
    const { base } = await mk([]);
    const r = await fetch(`${base}/whatsapp`, { method: "POST", body: JSON.stringify({ to: "+1555", body: "hi" }) });
    expect(r.status).toBe(401);
  });

  it("GET /whatsapp is open and lists recorded messages (real repo, not the fake)", async () => {
    const { base, repos } = await mk([]);
    await repos.whatsapp.record({ direction: "inbound", peer: "+1555", body: "hey", status: "received" });
    const list = (await (await fetch(`${base}/whatsapp`)).json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ direction: "inbound", peer: "+1555", body: "hey" });
  });
});
