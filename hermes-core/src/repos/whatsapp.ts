import type { Db } from "../db.ts";

export interface WhatsappRow {
  id: string;
  direction: "inbound" | "outbound";
  peer: string;
  body: string;
  status: string;
  error: string | null;
  callId: string | null;
  ts: string;
}

interface DbRow {
  id: string | number | bigint;
  direction: WhatsappRow["direction"];
  peer_e164: string;
  body: string;
  status: string;
  error: string | null;
  call_id: string | null;
  ts: string;
}

const toRow = (r: DbRow): WhatsappRow => ({
  id: String(r.id),
  direction: r.direction,
  peer: r.peer_e164,
  body: r.body,
  status: r.status,
  error: r.error,
  callId: r.call_id,
  ts: r.ts,
});

// Ladder order for updateStatus's non-downgrade guard — one step further than SMS's
// (queued -> sent -> delivered) since Baileys also surfaces read receipts. "failed" is
// terminal but not "higher" than anything; it's handled as its own case below.
// Kept in sync by hand with the SQL CASE in updateStatus() — small, closed ladder, not
// worth generating one from the other.
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

export class WhatsappRepo {
  constructor(readonly db: Db) {}

  /** Insert one whatsapp_messages row and return its bigint identity id (stringified). */
  async record(input: {
    direction: "inbound" | "outbound";
    peer: string;
    body: string;
    status: string;
    callId?: string;
    error?: string;
  }): Promise<{ id: string }> {
    const r = await this.db.query<{ id: string | number | bigint }>(
      `INSERT INTO hermes.whatsapp_messages (direction, peer_e164, body, status, call_id, error)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [input.direction, input.peer, input.body, input.status, input.callId ?? null, input.error ?? null],
    );
    return { id: String(r.rows[0]!.id) };
  }

  /** All messages, oldest first, capped — the dashboard groups these into per-peer threads itself. */
  async list(limit = 500): Promise<WhatsappRow[]> {
    const r = await this.db.query<DbRow>(
      `SELECT * FROM hermes.whatsapp_messages ORDER BY ts ASC LIMIT $1`,
      [limit],
    );
    return r.rows.map(toRow);
  }

  /**
   * Advance a message's status by its client_ref (= row id). Never moves a row backward
   * along queued -> sent -> delivered -> read (a late "sent" arriving after "read" is a
   * no-op), and never overwrites a terminal "failed" row. Unlike SMS there's a 4th rung
   * (read), so this is a rank comparison rather than a single hardcoded "delivered" check.
   */
  async updateStatus(clientRef: string, status: string, error?: string): Promise<void> {
    const newRank = RANK[status];
    if (newRank === undefined) {
      // "failed" (or any other terminal/unranked status) always applies — there's no
      // ordering to violate.
      await this.db.query(
        `UPDATE hermes.whatsapp_messages SET status = $2, error = $3
         WHERE id = $1::bigint AND status <> 'failed'`,
        [clientRef, status, error ?? null],
      );
      return;
    }
    // current_rank is -1 for any status not in the ladder (e.g. "received", used for
    // inbound rows) so a ranked update never accidentally overwrites those either.
    await this.db.query(
      `UPDATE hermes.whatsapp_messages SET status = $2, error = $3
       WHERE id = $1::bigint
         AND status <> 'failed'
         AND CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE -1 END < $4`,
      [clientRef, status, error ?? null, newRank],
    );
  }

  /** Outbound rows still waiting to send — the reconnect replay set, oldest first. No
   *  per-device filter (unlike SMS): WhatsApp is one global connection, not N phones. */
  async pendingOutbound(): Promise<WhatsappRow[]> {
    const r = await this.db.query<DbRow>(
      `SELECT * FROM hermes.whatsapp_messages
       WHERE direction = 'outbound' AND status = 'queued'
       ORDER BY ts ASC`,
    );
    return r.rows.map(toRow);
  }
}
