import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.ts";
import type { Repos, CallEngine } from "./call-engine.ts";
import type { CoreMsg } from "./protocol.ts";
import type { DeviceRegistry } from "./devices.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalizeE164 } from "./repos/contacts.ts";
import type { WhatsappClient } from "./whatsapp.ts";

export interface HttpDeps {
  repos: Repos;
  engine: CallEngine;
  registry: DeviceRegistry;
  sendToDevice: (deviceId: string, m: CoreMsg) => void;
  whatsapp: WhatsappClient;
}

/** Wrap manual dashboard guidance so the agent treats it as a silent director note. */
export const wrapGuidance = (t: string): string =>
  t.trim().startsWith("<<DIRECTOR") ? t.trim() : `<<DIRECTOR - act silently: ${t.trim()}>>`;

export async function handle(req: IncomingMessage, res: ServerResponse, deps: HttpDeps): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const send = (code: number, body?: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const authed = () => req.headers.authorization === `Bearer ${config.phoneToken}`;
  /**
   * Resolve the device a write should route to:
   *  - explicit id given  -> that id iff it's currently registered, else null (provided-but-unknown => 409)
   *  - no explicit id     -> the sole connected device, or null if 0 or 2+ are connected
   * /hangup and /inject have no body device_id, so they pass the owning call's deviceId as `explicit`.
   */
  const pickDevice = (explicit: string | undefined): string | null => {
    if (explicit) return deps.registry.get(explicit) ? explicit : null;
    return deps.registry.soleId() ?? null;
  };
  const body = async (): Promise<any> => {
    let s = "";
    for await (const c of req) s += c;
    return s ? JSON.parse(s) : {};
  };
  const seg = url.pathname.split("/").filter(Boolean); // e.g. ["calls","abc","hangup"]
  const M = req.method ?? "GET";

  try {
    if (M === "GET" && (url.pathname === "/" || url.pathname.startsWith("/dashboard/"))) {
      return serveStatic(url.pathname, res);
    }

    if (M === "GET" && url.pathname === "/health") {
      return send(200, {
        ok: true,
        calls: deps.engine.list().length,
        devices: deps.registry.list().map((c) => ({ id: c.id, connectedAt: c.connectedAt, lastSeen: c.lastSeen })),
      });
    }

    // ---- personas ----
    if (seg[0] === "personas") {
      if (M === "GET" && seg.length === 1) return send(200, await deps.repos.personas.list());
      if (M === "GET" && seg.length === 2) {
        const p = await deps.repos.personas.get(seg[1]!);
        return p ? send(200, p) : send(404, { error: "not found" });
      }
      if (!authed()) return send(401, { error: "unauthorized" });
      if (M === "POST" && seg.length === 1) {
        return send(201, await deps.repos.personas.upsert(await body()));
      }
      if (M === "PUT" && seg.length === 2) {
        return send(200, await deps.repos.personas.upsert({ ...(await body()), id: seg[1]! }));
      }
      if (M === "DELETE" && seg.length === 2) {
        await deps.repos.personas.remove(seg[1]!);
        return send(204);
      }
    }

    // ---- contacts ----
    if (seg[0] === "contacts") {
      if (M === "GET" && seg.length === 1) return send(200, await deps.repos.contacts.list());
      if (!authed()) return send(401, { error: "unauthorized" });
      if (M === "POST" && seg.length === 1) return send(201, await deps.repos.contacts.upsert(await body()));
      if (M === "PUT" && seg.length === 2) {
        return send(200, await deps.repos.contacts.upsert({ ...(await body()), id: seg[1]! }));
      }
      if (M === "DELETE" && seg.length === 2) {
        await deps.repos.contacts.remove(seg[1]!);
        return send(204);
      }
    }

    // ---- calls ----
    if (seg[0] === "calls") {
      if (M === "GET" && seg.length === 1) return send(200, await deps.repos.calls.list());
      if (M === "GET" && seg.length === 2) {
        const c = await deps.repos.calls.get(seg[1]!);
        return c ? send(200, c) : send(404, { error: "not found" });
      }
      if (!authed()) return send(401, { error: "unauthorized" });
      if (M === "POST" && seg.length === 1) {
        const b = await body();
        if (!b.to) return send(400, { error: "'to' required" });
        if (b.persona_id && !(await deps.repos.personas.get(b.persona_id))) {
          return send(404, { error: "persona not found" });
        }
        const deviceId = pickDevice(b.device_id);
        if (!deviceId) return send(409, { error: "device_id required" });
        const id = await deps.engine.createOutbound(
          b.to,
          { script: b.script, personaId: b.persona_id },
          deviceId,
          deps.sendToDevice,
        );
        return send(202, { call_id: id, status: "queued" });
      }
      if (M === "POST" && seg.length === 3 && seg[2] === "hangup") {
        const target = pickDevice(deps.engine.get(seg[1]!)?.deviceId);
        if (!target) return send(409, { error: "device_id required" });
        deps.sendToDevice(target, { type: "call.hangup", call_id: seg[1]!, reason: "remote_hangup" });
        return send(200, { ok: true });
      }
      if (M === "POST" && seg.length === 3 && seg[2] === "inject") {
        const b = await body();
        if (!b.text) return send(400, { error: "'text' required" });
        const lc = deps.engine.get(seg[1]!);
        if (!lc) return send(404, { error: "call not found" });
        const target = pickDevice(lc.deviceId);
        if (!target) return send(409, { error: "device_id required" });
        await deps.engine.manualInject(seg[1]!, wrapGuidance(b.text), deps.sendToDevice);
        return send(200, { ok: true });
      }
    }

    // ---- sms ----
    if (seg[0] === "sms") {
      if (M === "GET" && seg.length === 1) return send(200, await deps.repos.sms.list());
      if (!authed()) return send(401, { error: "unauthorized" });
      if (M === "POST" && seg.length === 1) {
        const b = await body();
        if (!b.to) return send(400, { error: "'to' required" });
        if (!b.body) return send(400, { error: "'body' required" });
        const deviceId = pickDevice(b.device_id);
        if (!deviceId) return send(409, { error: "device_id required" });
        const to = normalizeE164(b.to);
        const { id } = await deps.repos.sms.record({
          direction: "outbound",
          peer: to,
          body: b.body,
          status: "queued",
          deviceId,
        });
        deps.sendToDevice(deviceId, { type: "sms.send", to, body: b.body, client_ref: id });
        return send(202, { sms_id: id, status: "queued" });
      }
    }

    // ---- whatsapp ----
    if (seg[0] === "whatsapp") {
      if (M === "GET" && seg.length === 1) return send(200, await deps.repos.whatsapp.list());
      if (M === "GET" && seg.length === 2 && seg[1] === "status") return send(200, deps.whatsapp.status());
      if (!authed()) return send(401, { error: "unauthorized" });
      if (M === "POST" && seg.length === 2 && seg[1] === "pair") {
        await deps.whatsapp.pair();
        return send(202, deps.whatsapp.status());
      }
      if (M === "POST" && seg.length === 1) {
        const b = await body();
        if (!b.to) return send(400, { error: "'to' required" });
        if (!b.body) return send(400, { error: "'body' required" });
        const r = await deps.whatsapp.send(b.to, b.body);
        return send(202, { whatsapp_id: r.id, status: r.status });
      }
    }

    send(404, { error: "not found" });
  } catch (e) {
    console.error("[http] handler error", e);
    send(500, { error: "internal error" });
  }
}

const DASH_DIR = fileURLToPath(new URL("./dashboard/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.slice("/dashboard/".length);
  if (rel.includes("..") || rel.includes("\0")) {
    res.writeHead(404).end();
    return;
  }
  const ext = rel.slice(rel.lastIndexOf("."));
  try {
    const buf = await readFile(DASH_DIR + rel);
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
}
