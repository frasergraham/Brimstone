// Database backend factory.
// Wraps better-sqlite3 behind a minimal interface so consumers depend on
// { prepare, exec, transaction, close } rather than the driver directly.
//
// Usage:
//   createBackend('/path/to/file.db')   — on-disk database
//   createBackend(':memory:')            — in-memory (for tests)

import Database from 'better-sqlite3';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { SCHEMA_SQL } from './schema.js';

export function createBackend(dbPath) {
  if (dbPath !== ':memory:') {
    try { mkdirSync(dirname(dbPath), { recursive: true }); } catch {}
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);

  return {
    prepare(sql)       { return db.prepare(sql); },
    exec(sql)          { return db.exec(sql); },
    transaction(fn)    { return db.transaction(fn); },
    close()            { return db.close(); },
  };
}
