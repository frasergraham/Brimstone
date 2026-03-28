// All table definitions in one place.
// To add a new table, append a CREATE TABLE IF NOT EXISTS statement below.

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS players (
    id         TEXT PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL COLLATE NOCASE,
    token      TEXT UNIQUE NOT NULL,
    wins       INTEGER NOT NULL DEFAULT 0,
    losses     INTEGER NOT NULL DEFAULT 0,
    draws      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS game_saves (
    room_id          TEXT PRIMARY KEY,
    hero_player_id   TEXT,
    witch_player_id  TEXT,
    hero_name        TEXT NOT NULL DEFAULT '',
    witch_name       TEXT NOT NULL DEFAULT '',
    round            INTEGER NOT NULL DEFAULT 1,
    phase            TEXT NOT NULL DEFAULT 'dawn',
    game_version     TEXT NOT NULL,
    state_json       TEXT NOT NULL,
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS completed_games (
    game_id         TEXT PRIMARY KEY,
    room_id         TEXT,
    hero_player_id  TEXT,
    witch_player_id TEXT,
    hero_name       TEXT NOT NULL DEFAULT '',
    witch_name      TEXT NOT NULL DEFAULT '',
    winner          TEXT NOT NULL,
    win_reason      TEXT NOT NULL DEFAULT '',
    total_rounds    INTEGER NOT NULL DEFAULT 0,
    game_version    TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'hvai',
    pinned          INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at      INTEGER
  );

  CREATE TABLE IF NOT EXISTS game_replay_rounds (
    game_id        TEXT NOT NULL,
    round_num      INTEGER NOT NULL,
    pre_state_json TEXT NOT NULL,
    steps_json     TEXT NOT NULL,
    PRIMARY KEY (game_id, round_num)
  );

  CREATE TABLE IF NOT EXISTS sp_completed_games (
    game_id      TEXT PRIMARY KEY,
    hero_name    TEXT NOT NULL DEFAULT '',
    witch_name   TEXT NOT NULL DEFAULT '',
    winner       TEXT NOT NULL,
    win_reason   TEXT NOT NULL DEFAULT '',
    total_rounds INTEGER NOT NULL DEFAULT 0,
    game_version TEXT NOT NULL DEFAULT '',
    mode         TEXT NOT NULL DEFAULT 'hvai',
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sp_replay_rounds (
    game_id        TEXT NOT NULL,
    round_num      INTEGER NOT NULL,
    pre_state_json TEXT NOT NULL,
    steps_json     TEXT NOT NULL,
    PRIMARY KEY (game_id, round_num)
  );
`;
