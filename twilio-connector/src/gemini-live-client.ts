/**
 * Gemini Live API (BidiGenerateContent) client — TS port of the wire protocol documented
 * in phone-connector/src/com/hermes/connector/GeminiLiveClient.java's docblock:
 *
 *   connect:  wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=API_KEY
 *   setup:    {"setup": {"model", "generationConfig": {"responseModalities": ["AUDIO"]}, "systemInstruction", ...}}
 *   audio in: {"realtimeInput": {"audio": {"data": base64, "mimeType": "audio/pcm;rate=16000"}}}
 *   text in:  {"clientContent": {"turns": [{"role":"user","parts":[{"text": "..."}]}], "turnComplete": true}}
 *   audio out:{"serverContent": {"modelTurn": {"parts": [{"inlineData": {"data": base64}}]}, "turnComplete", "interrupted"}}
 *   ack:      {"setupComplete": {}}
 *
 * Unlike the Android client, this one explicitly requests `inputAudioTranscription` and
 * `outputAudioTranscription` in `setup` — the Live API only emits those fields when asked
 * to (per ai.google.dev/api/live), and this connector has no other way to get caller-side
 * text for hermes-core's trigger matching (there's no on-device mic path to fall back on).
 * The server may send frames as text or binary WS frames; both are treated as UTF-8 JSON.
 */

export interface GeminiLiveListener {
  onAudioChunk(pcm24k: Int16Array): void;
  onTranscript(role: "caller" | "agent", text: string): void;
  onTurnComplete(): void;
  onInterrupted(): void;
  onClosed(reason: string): void;
  onError(err: Error): void;
}

const noopListener: GeminiLiveListener = {
  onAudioChunk: () => {},
  onTranscript: () => {},
  onTurnComplete: () => {},
  onInterrupted: () => {},
  onClosed: () => {},
  onError: () => {},
};

/** The subset of `ws`'s WebSocket surface this client drives — narrowed so tests can pass a fake. */
export interface WsLike {
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close", cb: (code: number, reason: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface GeminiLiveClientOptions {
  wsFactory: (url: string) => WsLike;
  model?: string;
}

const HOST = "generativelanguage.googleapis.com";
const PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_MODEL = "models/gemini-3.1-flash-live-preview";

export class GeminiLiveClient {
  private readonly wsFactory: (url: string) => WsLike;
  private readonly model: string;
  private listener: GeminiLiveListener = noopListener;
  private ws: WsLike | undefined;
  private ready = false;

  constructor(opts: GeminiLiveClientOptions) {
    this.wsFactory = opts.wsFactory;
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  /** Swap the listener — mirrors the Android client's outbound-prewarm pattern. */
  setListener(listener: GeminiLiveListener): void {
    this.listener = listener;
  }

  connect(apiKey: string, systemInstruction: string): Promise<void> {
    const url = `wss://${HOST}${PATH}?key=${encodeURIComponent(apiKey)}`;
    const ws = this.wsFactory(url);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            setup: {
              model: this.model,
              generationConfig: { responseModalities: ["AUDIO"] },
              systemInstruction: { parts: [{ text: systemInstruction }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          }),
        );
      });
      ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString("utf-8"));
        } catch {
          return;
        }
        if (msg.setupComplete) {
          this.ready = true;
          resolve();
          return;
        }
        if (msg.error) {
          reject(new Error(`Gemini Live setup error: ${JSON.stringify(msg.error)}`));
          this.listener.onError(new Error(JSON.stringify(msg.error)));
          return;
        }
        this.handleServerContent(msg.serverContent);
      });
      ws.on("close", (code, reason) => this.listener.onClosed(`code=${code} reason=${reason.toString("utf-8")}`));
      ws.on("error", (err) => {
        if (!this.ready) reject(err);
        this.listener.onError(err);
      });
    });
  }

  private handleServerContent(sc: any): void {
    if (!sc) return;
    if (sc.interrupted) this.listener.onInterrupted();
    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const buf = Buffer.from(part.inlineData.data, "base64");
          const pcm = new Int16Array(buf.length / 2);
          for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
          this.listener.onAudioChunk(pcm);
        }
      }
    }
    if (sc.inputTranscription?.text) this.listener.onTranscript("caller", sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.listener.onTranscript("agent", sc.outputTranscription.text);
    if (sc.turnComplete) this.listener.onTurnComplete();
  }

  /** Feed one chunk of PCM16/16kHz/mono audio (the format `audio.ts`'s upsampler produces). */
  sendAudioChunk(pcm16kMono: Int16Array): void {
    if (!this.ws || !this.ready) return;
    const buf = Buffer.alloc(pcm16kMono.length * 2);
    for (let i = 0; i < pcm16kMono.length; i++) buf.writeInt16LE(pcm16kMono[i]!, i * 2);
    this.ws.send(
      JSON.stringify({ realtimeInput: { audio: { data: buf.toString("base64"), mimeType: "audio/pcm;rate=16000" } } }),
    );
  }

  /** Send a silent director-steering turn (the `<<DIRECTOR ...>>` text hermes-core's `call.inject` carries). */
  sendTextTurn(text: string): void {
    if (!this.ws || !this.ready) return;
    this.ws.send(
      JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }),
    );
  }

  close(): void {
    this.ws?.close();
  }
}
