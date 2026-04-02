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

  // Migration: add is_admin column to existing databases
  try { db.exec('ALTER TABLE players ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'); } catch {}
  // Migration: add invitee_email column for game invites
  try { db.exec('ALTER TABLE async_games ADD COLUMN invitee_email TEXT'); } catch {}

  // Migration: extend game_saves for unified multiplayer (plan persistence, room recovery)
  try { db.exec('ALTER TABLE game_saves ADD COLUMN turn_deadline INTEGER'); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN turn_interval_ms INTEGER NOT NULL DEFAULT 90000"); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN consecutive_timeouts TEXT NOT NULL DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN players_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { db.exec('ALTER TABLE game_saves ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE game_saves ADD COLUMN code TEXT'); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN status TEXT NOT NULL DEFAULT 'playing'"); } catch {}

  // Seed default admin user (idempotent via INSERT OR IGNORE)
  db.exec(`
    INSERT OR IGNORE INTO players (id, username, token, is_admin)
    VALUES ('seed-admin-twisted-weasel', 'TwistedWeasel', 'seed-token-twisted-weasel', 1);
    INSERT OR IGNORE INTO player_identities (player_id, provider, provider_id)
    VALUES ('seed-admin-twisted-weasel', 'email', 'frasergraham@me.com');
  `);

  return {
    prepare(sql)       { return db.prepare(sql); },
    exec(sql)          { return db.exec(sql); },
    transaction(fn)    { return db.transaction(fn); },
    close()            { return db.close(); },
  };
}
