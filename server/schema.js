// All table definitions in one place.
// To add a new table, append a CREATE TABLE IF NOT EXISTS statement below.

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS players (
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

  CREATE TABLE IF NOT EXISTS game_saves (
    room_id               TEXT PRIMARY KEY,
    hero_player_id        TEXT,
    witch_player_id       TEXT,
    hero_name             TEXT NOT NULL DEFAULT '',
    witch_name            TEXT NOT NULL DEFAULT '',
    round                 INTEGER NOT NULL DEFAULT 1,
    phase                 TEXT NOT NULL DEFAULT 'dawn',
    game_version          TEXT NOT NULL,
    save_version          INTEGER,
    state_json            TEXT NOT NULL,
    turn_deadline         INTEGER,
    turn_interval_ms      INTEGER NOT NULL DEFAULT 90000,
    consecutive_timeouts  TEXT NOT NULL DEFAULT '{}',
    config_json           TEXT NOT NULL DEFAULT '{}',
    players_json          TEXT NOT NULL DEFAULT '[]',
    is_private            INTEGER NOT NULL DEFAULT 0,
    code                  TEXT,
    status                TEXT NOT NULL DEFAULT 'playing',
    updated_at            INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at            INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS game_plan_status (
    room_id      TEXT NOT NULL,
    player_id    TEXT NOT NULL,
    round        INTEGER NOT NULL,
    plan_json    TEXT,
    submitted_at INTEGER,
    PRIMARY KEY (room_id, player_id, round)
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
    players_json    TEXT NOT NULL DEFAULT '[]',
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

  CREATE TABLE IF NOT EXISTS async_games (
    room_id                    TEXT PRIMARY KEY,
    code                       TEXT NOT NULL,
    hero_player_id             TEXT,
    witch_player_id            TEXT,
    hero_name                  TEXT NOT NULL DEFAULT '',
    witch_name                 TEXT NOT NULL DEFAULT '',
    host_player_id             TEXT NOT NULL,
    host_faction               TEXT NOT NULL,
    round                      INTEGER NOT NULL DEFAULT 0,
    phase                      TEXT NOT NULL DEFAULT '',
    turn_deadline              INTEGER,
    turn_interval_ms           INTEGER NOT NULL,
    game_version               TEXT NOT NULL,
    state_json                 TEXT,
    config_json                TEXT NOT NULL DEFAULT '{}',
    status                     TEXT NOT NULL DEFAULT 'waiting',
    winner                     TEXT,
    win_reason                 TEXT,
    invitee_email              TEXT,
    consecutive_timeout_rounds INTEGER NOT NULL DEFAULT 0,
    created_at                 INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at                 INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS async_plan_status (
    room_id      TEXT NOT NULL REFERENCES async_games(room_id),
    player_id    TEXT NOT NULL,
    round        INTEGER NOT NULL,
    plan_json    TEXT,
    submitted_at INTEGER,
    PRIMARY KEY (room_id, player_id, round)
  );

  CREATE TABLE IF NOT EXISTS async_notifications (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id   TEXT NOT NULL,
    player_id TEXT NOT NULL,
    type      TEXT NOT NULL,
    sent_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS device_tokens (
    player_id  TEXT NOT NULL REFERENCES players(id),
    token      TEXT NOT NULL,
    platform   TEXT NOT NULL DEFAULT 'ios',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (player_id, token)
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
