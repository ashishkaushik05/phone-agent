import { describe, it, expect } from "vitest";
import { freshDb } from "./test/db.ts";

const EXPECTED = [
  "personas", "contacts", "calls", "transcript_events",
  "director_actions", "sms_messages", "outreach_tasks", "notifications",
  "whatsapp_messages",
];

describe("schema 001_init", () => {
  it("creates every hermes table", async () => {
    const db = await freshDb();
    const r = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'hermes' AND table_name <> '_migrations'`,
    );
    const got = r.rows.map((x) => x.table_name).sort();
    expect(got).toEqual([...EXPECTED].sort());
    await db.close();
  });

  it("transcript_events.role is constrained", async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO hermes.calls (id, direction, from_number, status) VALUES ('c1', 'inbound', '+1555', 'active')`,
    );
    await expect(
      db.query(
        `INSERT INTO hermes.transcript_events (call_id, seq, role, text) VALUES ('c1', 0, 'bogus', 'hi')`,
      ),
    ).rejects.toThrow();
    await db.close();
  });
});
