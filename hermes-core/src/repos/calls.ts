import type { Db } from "../db.ts";

export interface CallRow {
  id: string;
  direction: "inbound" | "outbound";
  fromNumber: string | null;
  toNumber: string | null;
  personaId: string | null;
  contactId: string | null;
  status: "queued" | "dialing" | "active" | "ended";
  deviceId: string | null;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  outcomeSummary: string | null;
}

export interface CallDetail extends CallRow {
  transcript: { seq: number; role: string; text: string; ts: string }[];
  actions: { ts: string; category: string; matched: string | null; kind: string; payload: any }[];
}

interface DbRow {
  id: string;
  direction: CallRow["direction"];
  from_number: string | null;
  to_number: string | null;
  persona_id: string | null;
  contact_id: string | null;
  status: CallRow["status"];
  device_id: string | null;
  started_at: string;
  connected_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  outcome_summary: string | null;
}

const toRow = (r: DbRow): CallRow => ({
  id: r.id,
  direction: r.direction,
  fromNumber: r.from_number,
  toNumber: r.to_number,
  personaId: r.persona_id,
  contactId: r.contact_id,
  status: r.status,
  deviceId: r.device_id,
  startedAt: r.started_at,
  connectedAt: r.connected_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
  outcomeSummary: r.outcome_summary,
});

export class CallsRepo {
  constructor(readonly db: Db) {}

  async create(c: {
    id: string;
    direction: CallRow["direction"];
    fromNumber?: string | null;
    toNumber?: string | null;
    personaId?: string | null;
    contactId?: string | null;
    status?: CallRow["status"];
    deviceId?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO hermes.calls (id, direction, from_number, to_number, persona_id, contact_id, status, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, c.direction, c.fromNumber ?? null, c.toNumber ?? null, c.personaId ?? null, c.contactId ?? null, c.status ?? "queued", c.deviceId || null],
    );
  }

  async setStatus(id: string, status: CallRow["status"], at: Date = new Date()): Promise<void> {
    await this.db.query(
      `UPDATE hermes.calls
       SET status = $2,
           connected_at = CASE WHEN $2 = 'active' AND connected_at IS NULL THEN $3 ELSE connected_at END
       WHERE id = $1`,
      [id, status, at.toISOString()],
    );
  }

  async finalize(id: string, endReason: string, outcomeSummary?: string): Promise<void> {
    await this.db.query(
      `UPDATE hermes.calls
       SET status = 'ended', ended_at = now(), end_reason = $2,
           outcome_summary = COALESCE($3, outcome_summary)
       WHERE id = $1`,
      [id, endReason, outcomeSummary ?? null],
    );
  }

  /** Update only the outcome summary — used by post-call review, which must not move ended_at. */
  async setOutcomeSummary(id: string, summary: string): Promise<void> {
    await this.db.query(`UPDATE hermes.calls SET outcome_summary = $2 WHERE id = $1`, [id, summary]);
  }

  async appendTranscript(callId: string, seq: number, role: string, text: string): Promise<void> {
    await this.db.query(
      `INSERT INTO hermes.transcript_events (call_id, seq, role, text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (call_id, seq) DO NOTHING`,
      [callId, seq, role, text],
    );
  }

  async appendAction(
    callId: string,
    a: { category: string; matched?: string | null; kind: string; payload?: unknown },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO hermes.director_actions (call_id, category, matched, kind, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [callId, a.category, a.matched ?? null, a.kind, JSON.stringify(a.payload ?? {})],
    );
  }

  async get(id: string): Promise<CallDetail | null> {
    const c = await this.db.query<DbRow>(`SELECT * FROM hermes.calls WHERE id = $1`, [id]);
    if (!c.rows[0]) return null;
    const t = await this.db.query<{ seq: number; role: string; text: string; ts: string }>(
      `SELECT seq, role, text, ts FROM hermes.transcript_events WHERE call_id = $1 ORDER BY seq`,
      [id],
    );
    const a = await this.db.query<{ ts: string; category: string; matched: string | null; kind: string; payload: any }>(
      `SELECT ts, category, matched, kind, payload FROM hermes.director_actions WHERE call_id = $1 ORDER BY ts`,
      [id],
    );
    return { ...toRow(c.rows[0]), transcript: t.rows, actions: a.rows };
  }

  async list(limit = 100): Promise<CallRow[]> {
    const r = await this.db.query<DbRow>(
      `SELECT * FROM hermes.calls ORDER BY started_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map(toRow);
  }
}
