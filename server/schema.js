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
    is_admin   INTEGER NOT NULL DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS save_replay_rounds (
    room_id        TEXT NOT NULL,
    round_num      INTEGER NOT NULL,
    pre_state_json TEXT NOT NULL,
    steps_json     TEXT NOT NULL,
    PRIMARY KEY (room_id, round_num)
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

  CREATE TABLE IF NOT EXISTS player_identities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   TEXT NOT NULL REFERENCES players(id),
    provider    TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    metadata    TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(provider, provider_id)
  );

  CREATE TABLE IF NOT EXISTS magic_tokens (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    player_id  TEXT,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS campaign_saves (
    player_id    TEXT NOT NULL REFERENCES players(id),
    save_slot    TEXT NOT NULL DEFAULT 'campaign-1',
    state_json   TEXT NOT NULL,
    game_version TEXT NOT NULL,
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (player_id, save_slot)
  );

  CREATE TABLE IF NOT EXISTS game_stats (
    id                TEXT PRIMARY KEY,
    mode              TEXT NOT NULL,
    map_size          TEXT NOT NULL,
    winner            TEXT NOT NULL,
    win_reason        TEXT NOT NULL,
    rounds            INTEGER NOT NULL,
    final_phase       TEXT NOT NULL,
    hero_score        INTEGER NOT NULL DEFAULT 0,
    witch_score       INTEGER NOT NULL DEFAULT 0,
    hero_kills        INTEGER NOT NULL DEFAULT 0,
    witch_kills       INTEGER NOT NULL DEFAULT 0,
    hero_survivors    INTEGER NOT NULL DEFAULT 0,
    witch_summons     INTEGER NOT NULL DEFAULT 0,
    hero_personality  TEXT,
    witch_personality TEXT,
    hero_player_id    TEXT,
    witch_player_id   TEXT,
    game_version      TEXT NOT NULL,
    fog_of_war        INTEGER NOT NULL DEFAULT 0,
    duration_ms       INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS campaign_game_stats (
    id                TEXT PRIMARY KEY,
    campaign_id       TEXT NOT NULL,
    mission_id        TEXT NOT NULL,
    mission_title     TEXT NOT NULL DEFAULT '',
    winner            TEXT NOT NULL,
    win_reason        TEXT NOT NULL,
    rounds            INTEGER NOT NULL,
    final_phase       TEXT NOT NULL,
    hero_kills        INTEGER NOT NULL DEFAULT 0,
    witch_kills       INTEGER NOT NULL DEFAULT 0,
    survivors_deployed INTEGER NOT NULL DEFAULT 0,
    survivors_lost    INTEGER NOT NULL DEFAULT 0,
    enemies_spawned   INTEGER NOT NULL DEFAULT 0,
    has_witch         INTEGER NOT NULL DEFAULT 0,
    ai_personality    TEXT,
    map_size          TEXT NOT NULL DEFAULT 'standard',
    game_version      TEXT NOT NULL,
    duration_ms       INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;
