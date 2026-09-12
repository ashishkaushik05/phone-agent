import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { GeminiLiveClient } from "./gemini-live-client.ts";

/** Minimal stand-in for `ws`'s WebSocket — enough surface for GeminiLiveClient to drive. */
class FakeWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function setUp(model = "models/gemini-3.1-flash-live-preview") {
  const ws = new FakeWs();
  const urls: string[] = [];
  const client = new GeminiLiveClient({ wsFactory: (url) => (urls.push(url), ws as any), model });
  return { ws, urls, client };
}

const send = (ws: FakeWs, obj: unknown) => ws.emit("message", Buffer.from(JSON.stringify(obj)));

describe("GeminiLiveClient.connect", () => {
  it("opens the BidiGenerateContent endpoint with the API key and sends setup on open", async () => {
    const { ws, urls, client } = setUp();
    const readyPromise = client.connect("my-api-key", "be a helpful receptionist");
    ws.emit("open");
    send(ws, { setupComplete: {} });
    await readyPromise;

    expect(urls[0]).toContain("BidiGenerateContent");
    expect(urls[0]).toContain("key=my-api-key");

    const setupMsg = JSON.parse(ws.sent[0]!);
    expect(setupMsg.setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(setupMsg.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setupMsg.setup.systemInstruction.parts[0].text).toBe("be a helpful receptionist");
    // Requested explicitly — see the design spec's note on why this connector requests
    // both transcription streams even though phone-connector's own setup currently omits them.
    expect(setupMsg.setup.inputAudioTranscription).toEqual({});
    expect(setupMsg.setup.outputAudioTranscription).toEqual({});
  });

  it("rejects the ready promise on a setup error", async () => {
    const { ws, client } = setUp();
    const readyPromise = client.connect("key", "instruction");
    ws.emit("open");
    send(ws, { error: { message: "bad request" } });
    await expect(readyPromise).rejects.toThrow(/bad request/);
  });
});

describe("GeminiLiveClient audio/text send", () => {
  async function connected() {
    const { ws, client } = setUp();
    const readyPromise = client.connect("key", "instruction");
    ws.emit("open");
    send(ws, { setupComplete: {} });
    await readyPromise;
    ws.sent = []; // clear the setup message
    return { ws, client };
  }

  it("sendAudioChunk wraps base64 PCM16 audio in a realtimeInput message", async () => {
    const { ws, client } = await connected();
    client.sendAudioChunk(new Int16Array([1, 2, 3]));
    const msg = JSON.parse(ws.sent[0]!);
    expect(msg.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    const decoded = Buffer.from(msg.realtimeInput.audio.data, "base64");
    expect(decoded.readInt16LE(0)).toBe(1);
    expect(decoded.readInt16LE(4)).toBe(3);
  });

  it("sendTextTurn wraps a director inject as a completed user turn", async () => {
    const { ws, client } = await connected();
    client.sendTextTurn("<<DIRECTOR - act silently: wrap up now>>");
    const msg = JSON.parse(ws.sent[0]!);
    expect(msg.clientContent.turns).toEqual([{ role: "user", parts: [{ text: "<<DIRECTOR - act silently: wrap up now>>" }] }]);
    expect(msg.clientContent.turnComplete).toBe(true);
  });
});

describe("GeminiLiveClient server message handling", () => {
  async function connectedWithListener() {
    const { ws, client } = setUp();
    const listener = {
      onAudioChunk: vi.fn(),
      onTranscript: vi.fn(),
      onTurnComplete: vi.fn(),
      onInterrupted: vi.fn(),
      onClosed: vi.fn(),
      onError: vi.fn(),
    };
    client.setListener(listener);
    const readyPromise = client.connect("key", "instruction");
    ws.emit("open");
    send(ws, { setupComplete: {} });
    await readyPromise;
    return { ws, client, listener };
  }

  it("decodes model audio (modelTurn inlineData) to onAudioChunk", async () => {
    const { ws, listener } = await connectedWithListener();
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(500, 0);
    pcm.writeInt16LE(-500, 2);
    send(ws, { serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm.toString("base64") } }] } } });
    expect(listener.onAudioChunk).toHaveBeenCalledTimes(1);
    const got: Int16Array = listener.onAudioChunk.mock.calls[0]![0];
    expect([...got]).toEqual([500, -500]);
  });

  it("routes inputTranscription to the caller role and outputTranscription to the agent role", async () => {
    const { ws, listener } = await connectedWithListener();
    send(ws, { serverContent: { inputTranscription: { text: "hello there" } } });
    send(ws, { serverContent: { outputTranscription: { text: "hi, how can I help" } } });
    expect(listener.onTranscript).toHaveBeenNthCalledWith(1, "caller", "hello there");
    expect(listener.onTranscript).toHaveBeenNthCalledWith(2, "agent", "hi, how can I help");
  });

  it("fires onTurnComplete and onInterrupted from serverContent flags", async () => {
    const { ws, listener } = await connectedWithListener();
    send(ws, { serverContent: { turnComplete: true } });
    send(ws, { serverContent: { interrupted: true } });
    expect(listener.onTurnComplete).toHaveBeenCalledTimes(1);
    expect(listener.onInterrupted).toHaveBeenCalledTimes(1);
  });

  it("forwards close/error to the listener", async () => {
    const { ws, listener } = await connectedWithListener();
    ws.emit("close", 1006, Buffer.from("abnormal"));
    expect(listener.onClosed).toHaveBeenCalledWith(expect.stringContaining("1006"));
  });
});
