import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { WebSocket } from "ws";
import { buildServer, type ServerDeps, type MediaStreamSink } from "./server.ts";

const AUTH_TOKEN = "test-auth-token";
const PUBLIC_BASE_URL = "https://x.test"; // signed against this, server never actually binds here

function sign(fullUrl: string, params: Record<string, string>): string {
  const data = fullUrl + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", AUTH_TOKEN).update(Buffer.from(data, "utf-8")).digest("base64");
}

function fakeManager(): MediaStreamSink & {
  starts: any[];
  media: any[];
  stops: string[];
  statusCallbacks: any[];
} {
  const starts: any[] = [];
  const media: any[] = [];
  const stops: string[] = [];
  const statusCallbacks: any[] = [];
  return {
    starts,
    media,
    stops,
    statusCallbacks,
    onStreamStart: (p) => void starts.push(p),
    onStreamMedia: (callSid, payload) => void media.push({ callSid, payload }),
    onStreamStop: (callSid) => void stops.push(callSid),
    onStatusCallback: (callSid, status) => void statusCallbacks.push({ callSid, status }),
  };
}

let base: string;
let wsBase: string;
let server: ReturnType<typeof buildServer>;
let manager: ReturnType<typeof fakeManager>;

beforeEach(async () => {
  manager = fakeManager();
  const deps: ServerDeps = { manager, twilioAuthToken: AUTH_TOKEN, publicBaseUrl: PUBLIC_BASE_URL };
  server = buildServer(deps);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** Posts Twilio-shaped form params, signed as if the request had arrived at PUBLIC_BASE_URL + path. */
async function postAsTwilio(path: string, params: Record<string, string>) {
  const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(params).toString(),
  });
}

describe("POST /voice/inbound", () => {
  it("returns Connect/Stream TwiML carrying the caller's number as a Parameter", async () => {
    const res = await postAsTwilio("/voice/inbound", { CallSid: "CA1", From: "+15551230000", To: "+15559990000" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const body = await res.text();
    expect(body).toContain(`<Stream url="wss://x.test/media-stream">`);
    expect(body).toContain('<Parameter name="from" value="+15551230000"/>');
  });

  it("rejects a request with no Twilio signature", async () => {
    const res = await fetch(`${base}/voice/inbound`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA1", From: "+1", To: "+1" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(manager.starts.length).toBe(0);
  });

  it("rejects a tampered signature", async () => {
    const res = await fetch(`${base}/voice/inbound`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bogus==" },
      body: new URLSearchParams({ CallSid: "CA1", From: "+1", To: "+1" }).toString(),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /voice/outbound", () => {
  it("returns Connect/Stream TwiML carrying call_id as a Parameter", async () => {
    const res = await postAsTwilio("/voice/outbound?call_id=abc-123", { CallSid: "CA2", From: "+1", To: "+1" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<Parameter name="call_id" value="abc-123"/>');
  });
});

describe("POST /voice/status", () => {
  it("forwards CallSid/CallStatus to the manager", async () => {
    const res = await postAsTwilio("/voice/status", { CallSid: "CA3", CallStatus: "no-answer" });
    expect(res.status).toBe(200);
    expect(manager.statusCallbacks).toEqual([{ callSid: "CA3", status: "no-answer" }]);
  });
});

describe("/media-stream WebSocket", () => {
  it("relays start/media/stop events to the manager", async () => {
    const ws = new WebSocket(`${wsBase}/media-stream`);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    ws.send(JSON.stringify({ event: "start", start: { callSid: "CA9", streamSid: "MZ9", customParameters: { from: "+1555" } } }));
    ws.send(JSON.stringify({ event: "media", media: { payload: "AAAA" } }));
    ws.send(JSON.stringify({ event: "stop" }));
    await vi.waitFor(() => expect(manager.stops).toEqual(["CA9"]));

    expect(manager.starts[0]).toMatchObject({ callSid: "CA9", streamSid: "MZ9", customParameters: { from: "+1555" } });
    expect(typeof manager.starts[0].sendToTwilio).toBe("function");
    expect(manager.media[0]).toEqual({ callSid: "CA9", payload: "AAAA" });

    ws.close();
  });

  it("still calls onStreamStop if the socket closes without an explicit stop event", async () => {
    const ws = new WebSocket(`${wsBase}/media-stream`);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify({ event: "start", start: { callSid: "CA10", streamSid: "MZ10", customParameters: {} } }));
    await vi.waitFor(() => expect(manager.starts.length).toBe(1));
    ws.close();
    await vi.waitFor(() => expect(manager.stops).toEqual(["CA10"]));
  });
});
