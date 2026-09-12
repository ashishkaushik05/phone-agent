import { makePgliteDb, type Db } from "../db.ts";
import { migrate } from "../migrate.ts";

export async function freshDb(): Promise<Db> {
  const db = makePgliteDb();
  await migrate(db);
  return db;
}
