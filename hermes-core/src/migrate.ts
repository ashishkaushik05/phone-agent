import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

const migrationsDir = new URL("../migrations/", import.meta.url);

export async function migrate(db: Db): Promise<void> {
  await db.exec(`CREATE SCHEMA IF NOT EXISTS hermes`);
  await db.exec(
    `CREATE TABLE IF NOT EXISTS hermes._migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const applied = await db.query<{ name: string }>(`SELECT name FROM hermes._migrations`);
  const done = new Set(applied.rows.map((r) => r.name));

  const files = readdirSync(fileURLToPath(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(new URL(file, migrationsDir), "utf8").trim();
    if (sql) await db.exec(sql);
    await db.query(`INSERT INTO hermes._migrations (name) VALUES ($1)`, [file]);
  }
}
