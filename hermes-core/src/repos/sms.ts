import type { Db } from "../db.ts";

export interface SmsRow {
  id: string;
  direction: "inbound" | "outbound";
  peer: string;
  body: string;
  status: string;
  error: string | null;
  deviceId: string | null;
  callId: string | null;
  ts: string;
}

interface DbRow {
  id: string | number | bigint;
  direction: SmsRow["direction"];
  peer_e164: string;
  body: string;
  status: string;
  error: string | null;
  device_id: string | null;
  call_id: string | null;
  ts: string;
}

const toRow = (r: DbRow): SmsRow => ({
  id: String(r.id),
  direction: r.direction,
  peer: r.peer_e164,
  body: r.body,
  status: r.status,
  error: r.error,
  deviceId: r.device_id,
  callId: r.call_id,
  ts: r.ts,
});

export class SmsRepo {
  constructor(readonly db: Db) {}

  /** Insert one sms_messages row and return its bigint identity id (stringified). */
  async record(input: {
    direction: "inbound" | "outbound";
    peer: string;
    body: string;
    status: string;
    deviceId?: string;
    callId?: string;
    error?: string;
  }): Promise<{ id: string }> {
    const r = await this.db.query<{ id: string | number | bigint }>(
      `INSERT INTO hermes.sms_messages (direction, peer_e164, body, status, device_id, call_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.direction, input.peer, input.body, input.status, input.deviceId ?? null, input.callId ?? null, input.error ?? null],
    );
    return { id: String(r.rows[0]!.id) };
  }

  /** All messages, oldest first, capped — the dashboard groups these into per-peer threads itself. */
  async list(limit = 500): Promise<SmsRow[]> {
    const r = await this.db.query<DbRow>(
      `SELECT * FROM hermes.sms_messages ORDER BY ts ASC LIMIT $1`,
      [limit],
    );
    return r.rows.map(toRow);
  }

  /** Advance a message's status by its client_ref (= row id). Never downgrades a delivered row. */
  async updateStatus(clientRef: string, status: string, error?: string): Promise<void> {
    await this.db.query(
      `UPDATE hermes.sms_messages SET status = $2, error = $3
       WHERE id = $1::bigint AND status <> 'delivered'`,
      [clientRef, status, error ?? null],
    );
  }

  /** Outbound rows still waiting to leave this device — the reconnect replay set, oldest first. */
  async pendingOutbound(deviceId: string): Promise<SmsRow[]> {
    const r = await this.db.query<DbRow>(
      `SELECT * FROM hermes.sms_messages
       WHERE direction = 'outbound' AND status = 'queued' AND device_id = $1
       ORDER BY ts ASC`,
      [deviceId],
    );
    return r.rows.map(toRow);
  }
}
