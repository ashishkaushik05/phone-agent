/**
 * WS client to hermes-core's `/phone` endpoint — this connector's side of the exact
 * protocol phone-connector speaks (see protocol.ts). Registers as a device with `hello`,
 * forwards every other inbound CoreMsg to `onMessage`, and reconnects with backoff on
 * link loss (mirroring the phone's own link-loss behavior — no new recovery protocol).
 */
import type { CoreMsg, PhoneMsg } from "./protocol.ts";

export interface WsLike {
  readyState: number;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close", cb: (code: number, reason: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

const OPEN = 1;
const BACKOFF_MS = [1000, 2000, 5000, 10000] as const;

export interface HermesClientOptions {
  url: string;
  token: string;
  deviceId: string;
  onMessage: (msg: CoreMsg) => void;
  /** Fired once hello_ack arrives after a reconnect (not on the very first connect). */
  onReconnect?: () => void;
  wsFactory?: (url: string, headers: Record<string, string>) => WsLike;
}

export class HermesClient {
  private readonly opts: HermesClientOptions;
  private readonly wsFactory: (url: string, headers: Record<string, string>) => WsLike;
  private ws: WsLike | undefined;
  private attempt = 0;

  constructor(opts: HermesClientOptions) {
    this.opts = opts;
    this.wsFactory = opts.wsFactory ?? (() => {
      throw new Error("HermesClient: no wsFactory given and no default ws import wired");
    });
  }

  /** Resolves once the first hello_ack arrives. Reconnects on later drops without re-resolving. */
  connect(): Promise<void> {
    return this.open(/* isReconnect */ false);
  }

  private open(isReconnect: boolean): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.wsFactory(this.opts.url, { authorization: `Bearer ${this.opts.token}` });
      this.ws = ws;
      ws.on("open", () => {
        this.attempt = 0;
        ws.send(JSON.stringify({ type: "hello", device_id: this.opts.deviceId }));
      });
      ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString("utf-8"));
        } catch {
          return;
        }
        if (msg.type === "hello_ack") {
          if (isReconnect) this.opts.onReconnect?.();
          resolve();
          return;
        }
        this.opts.onMessage(msg as CoreMsg);
      });
      ws.on("close", () => this.scheduleReconnect());
      ws.on("error", () => {
        /* the close handler that follows drives reconnection */
      });
    });
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    setTimeout(() => void this.open(true), delay);
  }

  send(msg: PhoneMsg): void {
    if (!this.ws || this.ws.readyState !== OPEN) {
      console.error("[hermes-client] link down, dropping", msg.type);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws?.close();
  }
}
