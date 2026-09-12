import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { HermesClient } from "./hermes-client.ts";

class FakeWs extends EventEmitter {
  sent: string[] = [];
  readyState = 1; // OPEN
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.emit("close", 1000, Buffer.from("bye"));
  }
}

function setUp() {
  const sockets: FakeWs[] = [];
  const urls: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  const wsFactory = (url: string, headers: Record<string, string>) => {
    urls.push(url);
    headersSeen.push(headers);
    const ws = new FakeWs();
    sockets.push(ws);
    return ws as any;
  };
  return { sockets, urls, headersSeen, wsFactory };
}

const send = (ws: FakeWs, obj: unknown) => ws.emit("message", Buffer.from(JSON.stringify(obj)));

describe("HermesClient.connect", () => {
  it("opens the phone WSS with a bearer token and sends hello with the device id", async () => {
    const { sockets, urls, headersSeen, wsFactory } = setUp();
    const client = new HermesClient({
      url: "ws://localhost:8787/phone",
      token: "smoke-token",
      deviceId: "twilio-main",
      wsFactory,
      onMessage: vi.fn(),
    });

    const connectPromise = client.connect();
    sockets[0]!.emit("open");
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: "hello", device_id: "twilio-main" });
    send(sockets[0]!, { type: "hello_ack", device_id: "twilio-main" });
    await connectPromise;

    expect(urls[0]).toBe("ws://localhost:8787/phone");
    expect(headersSeen[0]!.authorization).toBe("Bearer smoke-token");
  });
});

describe("HermesClient message dispatch", () => {
  it("forwards every non-hello_ack message to onMessage", async () => {
    const { sockets, wsFactory } = setUp();
    const onMessage = vi.fn();
    const client = new HermesClient({ url: "ws://x", token: "t", deviceId: "d", wsFactory, onMessage });
    const p = client.connect();
    sockets[0]!.emit("open");
    send(sockets[0]!, { type: "hello_ack", device_id: "d" });
    await p;

    send(sockets[0]!, { type: "call.accept", call_id: "c1", system_instruction: "hi", trigger_config: {} });
    expect(onMessage).toHaveBeenCalledWith({ type: "call.accept", call_id: "c1", system_instruction: "hi", trigger_config: {} });
    expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "hello_ack" }));
  });

  it("send() forwards a PhoneMsg as JSON over the open socket", async () => {
    const { sockets, wsFactory } = setUp();
    const client = new HermesClient({ url: "ws://x", token: "t", deviceId: "d", wsFactory, onMessage: vi.fn() });
    const p = client.connect();
    sockets[0]!.emit("open");
    send(sockets[0]!, { type: "hello_ack", device_id: "d" });
    await p;

    client.send({ type: "call.inbound", call_id: "c1", from: "+1555", device_id: "d" });
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ type: "call.inbound", call_id: "c1", from: "+1555", device_id: "d" });
  });
});

describe("HermesClient reconnect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reopens the socket and re-sends hello after the link drops", async () => {
    const { sockets, wsFactory } = setUp();
    const onReconnect = vi.fn();
    const client = new HermesClient({ url: "ws://x", token: "t", deviceId: "d", wsFactory, onMessage: vi.fn(), onReconnect });
    const p = client.connect();
    sockets[0]!.emit("open");
    send(sockets[0]!, { type: "hello_ack", device_id: "d" });
    await p;

    sockets[0]!.emit("close", 1006, Buffer.from("lost"));
    expect(sockets.length).toBe(1); // no immediate reconnect — waits for backoff

    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBe(2);

    sockets[1]!.emit("open");
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ type: "hello", device_id: "d" });
    send(sockets[1]!, { type: "hello_ack", device_id: "d" });
    await Promise.resolve();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
