/**
 * Registry of connected phone-connector sockets, keyed by device_id.
 * One hermes-core instance can hold links to many Android phones at once;
 * every inbound message carries its device_id so the engine can route replies back.
 */

export interface DeviceConn {
  id: string;
  ws: import("ws").WebSocket;
  connectedAt: number;
  lastSeen: number;
}

export class DeviceRegistry {
  private conns = new Map<string, DeviceConn>();

  /** Store the socket for `id`, closing (and replacing) any existing conn for the same id. */
  register(id: string, ws: import("ws").WebSocket): void {
    const existing = this.conns.get(id);
    if (existing && existing.ws !== ws) {
      const addr = (existing.ws as any)._socket?.remoteAddress ?? "?";
      console.warn("[devices] replacing", id, "(was", addr + ")");
      existing.ws.close();
    }
    const now = Date.now();
    this.conns.set(id, { id, ws, connectedAt: now, lastSeen: now });
  }

  drop(id: string): void {
    this.conns.delete(id);
  }

  /**
   * Drop every conn that owns this socket — used on `ws.close` when the id isn't known.
   * Loops without an early return so a socket registered under two ids leaves no phantom.
   */
  dropSocket(ws: import("ws").WebSocket): void {
    for (const [id, conn] of this.conns) {
      if (conn.ws === ws) this.conns.delete(id);
    }
  }

  get(id: string): DeviceConn | undefined {
    return this.conns.get(id);
  }

  touch(id: string): void {
    const conn = this.conns.get(id);
    if (conn) conn.lastSeen = Date.now();
  }

  list(): DeviceConn[] {
    return [...this.conns.values()];
  }

  /** The single connected device's id, iff exactly one is connected. */
  soleId(): string | undefined {
    if (this.conns.size !== 1) return undefined;
    return this.conns.keys().next().value;
  }
}
