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

  // Migration: add save_version to game_saves for schema-aware compatibility checks
  try { db.exec('ALTER TABLE game_saves ADD COLUMN save_version INTEGER'); } catch {}

  // Migration: add players_json to completed_games for NvN support
  try { db.exec("ALTER TABLE completed_games ADD COLUMN players_json TEXT NOT NULL DEFAULT '[]'"); } catch {}

  // Migration: add discriminator column and drop the old UNIQUE(username) constraint.
  // SQLite can't drop constraints, so we must recreate the table.
  // Detect the old schema by checking if the CREATE TABLE SQL still has "username   TEXT UNIQUE".
  {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='players'").get();
    const needsMigration = tableInfo?.sql?.includes('TEXT UNIQUE NOT NULL COLLATE NOCASE');
    if (needsMigration) {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        -- Create new table with the updated schema (no UNIQUE on username alone)
        CREATE TABLE _players_new (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL COLLATE NOCASE,
          discriminator INTEGER,
          token         TEXT UNIQUE NOT NULL,
          wins          INTEGER NOT NULL DEFAULT 0,
          losses        INTEGER NOT NULL DEFAULT 0,
          draws         INTEGER NOT NULL DEFAULT 0,
          is_admin      INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(username, discriminator)
        );
        INSERT INTO _players_new (id, username, token, wins, losses, draws, is_admin, created_at)
          SELECT id, username, token, wins, losses, draws, is_admin, created_at FROM players;
        DROP TABLE players;
        ALTER TABLE _players_new RENAME TO players;
      `);
      // Assign random 4-digit discriminators to all existing players
      const rows = db.prepare('SELECT id FROM players WHERE discriminator IS NULL').all();
      const update = db.prepare('UPDATE players SET discriminator = ? WHERE id = ?');
      for (const row of rows) {
        update.run(1000 + Math.floor(Math.random() * 9000), row.id);
      }
      db.pragma('foreign_keys = ON');
    }
  }

  // Clean up legacy seed admin if present (admin is now granted via email identity)
  try {
    db.exec(`
      DELETE FROM player_identities WHERE player_id = 'seed-admin-twisted-weasel';
      DELETE FROM device_tokens WHERE player_id = 'seed-admin-twisted-weasel';
      DELETE FROM players WHERE id = 'seed-admin-twisted-weasel';
    `);
  } catch { /* tables may not exist yet on fresh DB — that's fine */ }

  return {
    prepare(sql)       { return db.prepare(sql); },
    exec(sql)          { return db.exec(sql); },
    transaction(fn)    { return db.transaction(fn); },
    close()            { return db.close(); },
  };
}
