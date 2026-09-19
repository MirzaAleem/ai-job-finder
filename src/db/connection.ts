import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../util/logger.js';
import { applySchema } from './schema.js';

export interface DbHandle {
  disconnect(): Promise<void>;
}

/**
 * One connection per process, held in a module singleton.
 *
 * SQLite is a file, not a server: there is no pool to manage and no reconnect to
 * handle, so the repositories reach for `getDb()` rather than being passed a
 * handle through every constructor.
 */
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database is not connected. Call connectDb() before using a repository.');
  }
  return db;
}

export function isConnected(): boolean {
  return db !== null;
}

/**
 * Opens (and creates, if absent) the database file, then applies the schema.
 *
 * `:memory:` is honoured as-is, which is what the tests use.
 */
export async function connectDb(file: string, logger: Logger): Promise<DbHandle> {
  if (db) await closeDb();

  const isMemory = file === ':memory:';
  if (!isMemory) {
    // A fresh clone has no data/ directory; creating it here is what makes the
    // default SQLITE_PATH work with no setup step at all.
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  try {
    db = new Database(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not open the SQLite database at "${file}": ${message}`, { cause: err });
  }

  // WAL lets the dashboard read while a run is writing. Not available for an
  // in-memory database, where it is silently a no-op anyway.
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // A scheduled run and a hand-run command can overlap; wait rather than throw.
  db.pragma('busy_timeout = 5000');

  applySchema(db);
  logger.info('DB', 'connected', { database: isMemory ? ':memory:' : path.resolve(file) });

  return {
    async disconnect() {
      await closeDb();
      logger.info('DB', 'disconnected');
    },
  };
}

export async function closeDb(): Promise<void> {
  db?.close();
  db = null;
}

/** Test seam: attach an already-open database without touching the filesystem. */
export function setDb(instance: Database.Database | null): void {
  db = instance;
}
