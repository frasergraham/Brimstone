// Shared better-sqlite3 handle for all SQLite domain modules.
// Owns schema bootstrap and legacy migrations. Initialization happens at
// module-load time so that sibling domain modules can declare prepared
// statements at their own module-load time without race concerns.

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { SCHEMA_SQL_SQLITE } from '../schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(__dirname, '..', '..', '..', 'data', 'brimstone.db');
const DB_PATH = process.env.DB_PATH || DEFAULT_PATH;

function _open(dbPath) {
  if (dbPath !== ':memory:') {
    try { mkdirSync(dirname(dbPath), { recursive: true }); } catch {}
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL_SQLITE);
  _runMigrations(db);
  return db;
}

let db = _open(DB_PATH);

/** Prepare a statement against the shared handle. */
export function prepare(sql) { return db.prepare(sql); }

/** Execute raw SQL on the shared handle. */
export function exec(sql) { return db.exec(sql); }

/** Wrap `fn` in a better-sqlite3 transaction (call the returned function to run it). */
export function transaction(fn) { return db.transaction(fn); }

/** Close the shared handle. Tests only — production holds the handle for the
 *  server's lifetime. After close(), the next access will reopen from DB_PATH. */
export function close() {
  if (db) { db.close(); db = null; }
}

/** Reopen the handle against a new path. Used by tests that swap between
 *  multiple :memory: databases. */
export function reopen(dbPath) {
  if (db) db.close();
  db = _open(dbPath);
}

// ── Legacy migrations ───────────────────────────────────────────────────────
//
// These adapt existing on-disk databases from older schema shapes. They are
// SQLite-only; the Postgres backend is born with the canonical schema.
function _runMigrations(db) {
  try { db.exec('ALTER TABLE players ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE async_games ADD COLUMN invitee_email TEXT'); } catch {}

  try { db.exec('ALTER TABLE game_saves ADD COLUMN turn_deadline INTEGER'); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN turn_interval_ms INTEGER NOT NULL DEFAULT 90000"); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN consecutive_timeouts TEXT NOT NULL DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN players_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
  try { db.exec('ALTER TABLE game_saves ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE game_saves ADD COLUMN code TEXT'); } catch {}
  try { db.exec("ALTER TABLE game_saves ADD COLUMN status TEXT NOT NULL DEFAULT 'playing'"); } catch {}
  try { db.exec('ALTER TABLE game_saves ADD COLUMN save_version INTEGER'); } catch {}

  try { db.exec("ALTER TABLE completed_games ADD COLUMN players_json TEXT NOT NULL DEFAULT '[]'"); } catch {}

  try { db.exec('ALTER TABLE game_replay_rounds ADD COLUMN final_entities_json TEXT'); } catch {}

  {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='players'").get();
    const needsMigration = tableInfo?.sql?.includes('TEXT UNIQUE NOT NULL COLLATE NOCASE');
    if (needsMigration) {
      db.pragma('foreign_keys = OFF');
      db.exec(`
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
      const rows = db.prepare('SELECT id FROM players WHERE discriminator IS NULL').all();
      const update = db.prepare('UPDATE players SET discriminator = ? WHERE id = ?');
      for (const row of rows) {
        update.run(1000 + Math.floor(Math.random() * 9000), row.id);
      }
      db.pragma('foreign_keys = ON');
    }
  }

  try {
    db.exec(`
      DELETE FROM player_identities WHERE player_id = 'seed-admin-twisted-weasel';
      DELETE FROM device_tokens WHERE player_id = 'seed-admin-twisted-weasel';
      DELETE FROM players WHERE id = 'seed-admin-twisted-weasel';
    `);
  } catch { /* tables may not exist yet on fresh DB — that's fine */ }
}
