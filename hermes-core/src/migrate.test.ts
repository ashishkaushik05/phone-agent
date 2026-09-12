import { describe, it, expect } from "vitest";
import { makePgliteDb } from "./db.ts";
import { migrate } from "./migrate.ts";

describe("migrate", () => {
  it("creates the hermes schema and records applied migrations", async () => {
    const db = makePgliteDb();
    await migrate(db);

    const schema = await db.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'hermes'`,
    );
    expect(schema.rows).toHaveLength(1);

    const applied = await db.query<{ name: string }>(`SELECT name FROM hermes._migrations ORDER BY name`);
    expect(applied.rows.map((r) => r.name)).toContain("001_init.sql");
    expect(applied.rows.map((r) => r.name)).toContain("003_device_id.sql");

    const cols = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'hermes' AND column_name = 'device_id'`,
    );
    expect(cols.rows.map((r) => r.table_name).sort()).toEqual(["calls", "sms_messages"]);

    await db.close();
  });

  it("is idempotent — running twice does not error", async () => {
    const db = makePgliteDb();
    await migrate(db);
    await migrate(db);
    await db.close();
  });

  it("seeds the preset personas alongside the default", async () => {
    const db = makePgliteDb();
    await migrate(db);
    const r = await db.query<{ id: string }>(`SELECT id FROM hermes.personas`);
    expect(r.rows.map((x) => x.id).sort()).toEqual(
      ["after-hours", "appointment-booker", "call-screener", "default", "info-gatherer"],
    );
    const nonDefault = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM hermes.personas WHERE is_default = false`,
    );
    expect(nonDefault.rows[0]?.n).toBe(4);
    await db.close();
  });
});
