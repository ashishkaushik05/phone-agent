import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

export interface Db {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

export function makePgDb(connectionString: string): Db {
  const pool = new Pool({ connectionString });
  return {
    query: async (text, params) => {
      const result = await pool.query(text, params as unknown[] | undefined);
      return { rows: result.rows as any[] };
    },
    exec: async (text) => {
      await pool.query(text);
    },
    close: () => pool.end(),
  };
}

export function makePgliteDb(dataDir?: string): Db {
  const pg = new PGlite(dataDir);
  return {
    query: async (text, params) => {
      const r = await pg.query(text, params as unknown[] | undefined);
      return { rows: r.rows as any[] };
    },
    exec: async (text) => {
      await pg.exec(text);
    },
    close: () => pg.close(),
  };
}
