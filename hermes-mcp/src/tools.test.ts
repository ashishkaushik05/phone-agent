import { describe, it, expect, vi } from "vitest";
import { TOOLS, runTool, type HermesTool } from "./tools.ts";
import type { HermesClientDeps } from "./hermesClient.ts";

function find(name: string): HermesTool {
  const t = TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t;
}

describe("tool request builders — one per hermes-core REST endpoint", () => {
  const cases: { name: string; args: Record<string, unknown>; method: string; path: string; body?: unknown }[] = [
    { name: "list_personas", args: {}, method: "GET", path: "/personas" },
    { name: "get_persona", args: { persona_id: "p1" }, method: "GET", path: "/personas/p1" },
    {
      name: "upsert_persona",
      args: { id: "p1", name: "n", systemInstruction: "s", triggerConfig: { needsData: [], escalation: [], offScript: [], closing: [] } },
      method: "POST",
      path: "/personas",
      body: { id: "p1", name: "n", systemInstruction: "s", triggerConfig: { needsData: [], escalation: [], offScript: [], closing: [] } },
    },
    { name: "delete_persona", args: { persona_id: "p1" }, method: "DELETE", path: "/personas/p1" },
    { name: "list_contacts", args: {}, method: "GET", path: "/contacts" },
    {
      name: "upsert_contact",
      args: { phoneE164: "+15551230000" },
      method: "POST",
      path: "/contacts",
      body: { phoneE164: "+15551230000" },
    },
    { name: "delete_contact", args: { contact_id: "c1" }, method: "DELETE", path: "/contacts/c1" },
    { name: "list_calls", args: {}, method: "GET", path: "/calls" },
    { name: "get_call", args: { call_id: "c9" }, method: "GET", path: "/calls/c9" },
    {
      name: "place_call",
      args: { to: "+15551230000", script: "Confirm the meeting." },
      method: "POST",
      path: "/calls",
      body: { to: "+15551230000", script: "Confirm the meeting." },
    },
    { name: "hangup_call", args: { call_id: "c9" }, method: "POST", path: "/calls/c9/hangup" },
    { name: "inject_guidance", args: { call_id: "c9", text: "wrap up" }, method: "POST", path: "/calls/c9/inject", body: { text: "wrap up" } },
    { name: "list_sms", args: {}, method: "GET", path: "/sms" },
    {
      name: "send_sms",
      args: { to: "+15551230000", body: "hi" },
      method: "POST",
      path: "/sms",
      body: { to: "+15551230000", body: "hi" },
    },
    { name: "list_whatsapp", args: {}, method: "GET", path: "/whatsapp" },
    {
      name: "send_whatsapp",
      args: { to: "+15551230000", body: "hi" },
      method: "POST",
      path: "/whatsapp",
      body: { to: "+15551230000", body: "hi" },
    },
    { name: "whatsapp_status", args: {}, method: "GET", path: "/whatsapp/status" },
    { name: "whatsapp_pair", args: {}, method: "POST", path: "/whatsapp/pair" },
    { name: "get_status", args: {}, method: "GET", path: "/health" },
  ];

  it("covers every registered tool exactly once", () => {
    expect(cases.map((c) => c.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  for (const c of cases) {
    it(`${c.name} builds the right request`, () => {
      const req = find(c.name).request(c.args);
      expect(req.method).toBe(c.method);
      expect(req.path).toBe(c.path);
      expect(req.body).toEqual(c.body);
    });
  }

  it("URL-encodes path segments built from arguments", () => {
    const req = find("get_call").request({ call_id: "weird/id with space" });
    expect(req.path).toBe("/calls/weird%2Fid%20with%20space");
  });
});

describe("runTool", () => {
  const tool = find("get_status");

  function deps(fetchImpl: typeof fetch): HermesClientDeps {
    return { baseUrl: "http://hermes-core.test", token: "tok", fetchImpl };
  }

  it("maps a successful REST response to a text content block", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, calls: 0 }), { status: 200 })) as unknown as typeof fetch;
    const r = await runTool(tool, {}, deps(fetchImpl));
    expect(r.isError).toBeUndefined();
    expect(r.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true, calls: 0 }) }]);
  });

  it("maps a REST error response to isError: true with the error message", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch;
    const r = await runTool(tool, {}, deps(fetchImpl));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe("500: boom");
  });

  it("maps an unreachable hermes-core to isError: true, never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await runTool(tool, {}, deps(fetchImpl));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("hermes-core unreachable");
  });

  it("maps a 204 No Content (e.g. a delete) to a plain 'ok' text, not 'undefined'", async () => {
    const del = find("delete_persona");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const r = await runTool(del, { persona_id: "p1" }, deps(fetchImpl));
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
  });
});
