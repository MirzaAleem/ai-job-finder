import { connectDb, getDb, closeDb, type DbHandle } from '../../src/db/connection.js';
import { createSilentLogger } from '../../src/util/logger.js';

let handle: DbHandle | null = null;

/**
 * An in-memory SQLite database, created fresh and schema-applied by connectDb.
 *
 * This is the whole reason the migration off Mongo was worth doing for the tests
 * too: no download, no spawned server, no 120-second beforeAll timeout.
 */
export async function startTestDb(): Promise<void> {
  handle = await connectDb(':memory:', createSilentLogger());
}

export async function stopTestDb(): Promise<void> {
  await handle?.disconnect();
  handle = null;
  await closeDb();
}

const TABLES = ['job_evaluations', 'job_applications', 'jobs', 'runs', 'candidate_profiles'];

/** Truncate between tests. Ordered so foreign keys are never violated. */
export async function clearTables(): Promise<void> {
  const db = getDb();
  for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
}

/** Row count for a table, for the "did it actually persist?" assertions. */
export function count(table: string): number {
  return getDb().prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

/** First matching row, as raw SQLite types. */
export function firstRow<T>(sql: string, ...params: unknown[]): T | undefined {
  return getDb()
    .prepare(sql)
    .get(...(params as never[])) as T | undefined;
}

export function allRows<T>(sql: string, ...params: unknown[]): T[] {
  return getDb()
    .prepare(sql)
    .all(...(params as never[])) as T[];
}
