// Game save persistence — upsert/delete/list/get for in-progress game states
// and completed-game replay storage.
import db from './db.js';

const SAVE_MAX_AGE_DAYS = 3;

const _upsert = db.prepare(`
  INSERT INTO game_saves
    (room_id, hero_player_id, witch_player_id, hero_name, witch_name,
     round, phase, game_version, state_json, updated_at, created_at)
  VALUES
    (@roomId, @heroPlayerId, @witchPlayerId, @heroName, @witchName,
     @round, @phase, @gameVersion, @stateJson, unixepoch(), unixepoch())
  ON CONFLICT(room_id) DO UPDATE SET
    round        = excluded.round,
    phase        = excluded.phase,
    game_version = excluded.game_version,
    state_json   = excluded.state_json,
    updated_at   = unixepoch()
`);

const _delete = db.prepare(`DELETE FROM game_saves WHERE room_id = ?`);
const _deleteSaveRounds = db.prepare(`DELETE FROM save_replay_rounds WHERE room_id = ?`);
const _insertSaveRound = db.prepare(`
  INSERT OR REPLACE INTO save_replay_rounds (room_id, round_num, pre_state_json, steps_json)
  VALUES (@roomId, @roundNum, @preStateJson, @stepsJson)
`);
const _getSaveRounds = db.prepare(`
  SELECT round_num, pre_state_json, steps_json
  FROM   save_replay_rounds
  WHERE  room_id = ?
  ORDER  BY round_num ASC
`);

const _listByPlayer = db.prepare(`
  SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         round, phase, game_version, updated_at, created_at
  FROM   game_saves
  WHERE  hero_player_id = ? OR witch_player_id = ?
  ORDER  BY updated_at DESC
`);

const _getByRoom = db.prepare(`SELECT * FROM game_saves WHERE room_id = ?`);

/**
 * Persist (create or update) the serialized state for a room.
 * @param {string} roomId
 * @param {string|null} heroPlayerId  — null / 'ai' for AI-controlled hero
 * @param {string|null} witchPlayerId — null / 'ai' for AI-controlled witch
 * @param {string} heroName
 * @param {string} witchName
 * @param {object} serializedState    — result of serializeState(); must include .version
 */
export function upsertSave(roomId, heroPlayerId, witchPlayerId, heroName, witchName, serializedState) {
  _upsert.run({
    roomId,
    heroPlayerId:  heroPlayerId  ?? null,
    witchPlayerId: witchPlayerId ?? null,
    heroName:      heroName      ?? '',
    witchName:     witchName     ?? '',
    round:         serializedState.round,
    phase:         serializedState.phase,
    gameVersion:   serializedState.version,
    stateJson:     JSON.stringify(serializedState),
  });
}

/** Remove the save for a completed or abandoned room (including replay rounds). */
export function deleteSave(roomId) {
  _deleteSaveRounds.run(roomId);
  _delete.run(roomId);
}

/** Append a single round's replay data to the save. */
export function appendSaveRound(roomId, roundNum, preStateJson, stepsJson) {
  _insertSaveRound.run({ roomId, roundNum, preStateJson, stepsJson });
}

/** Retrieve all replay rounds for a save, ordered by round number. */
export function getSaveRounds(roomId) {
  return _getSaveRounds.all(roomId);
}

/**
 * Remove stale saves on server startup:
 *   - any save idle for more than SAVE_MAX_AGE_DAYS days
 *   - any save from a different game version (schema may be incompatible)
 *
 * Returns the number of rows pruned.
 */
export function pruneStaleAndIncompatibleSaves(currentVersion) {
  const cutoff = Math.floor(Date.now() / 1000) - SAVE_MAX_AGE_DAYS * 86400;
  // Collect room IDs that will be pruned so we can clean up their replay rounds
  const staleRooms = db.prepare(`
    SELECT room_id FROM game_saves
    WHERE updated_at < ? OR game_version != ?
  `).all(cutoff, currentVersion);
  for (const { room_id } of staleRooms) {
    _deleteSaveRounds.run(room_id);
  }
  const { changes } = db.prepare(`
    DELETE FROM game_saves
    WHERE updated_at < ? OR game_version != ?
  `).run(cutoff, currentVersion);
  return changes;
}

/**
 * List all in-progress saves that involve a given human player ID.
 * Returns lightweight rows (no state_json) sorted newest-first.
 */
export function getActiveSaves(playerId) {
  return _listByPlayer.all(playerId, playerId);
}

/**
 * Retrieve a single save by room ID, with the full state parsed.
 * Returns null if not found.
 */
export function getSave(roomId) {
  const row = _getByRoom.get(roomId);
  if (!row) return null;
  return { ...row, state: JSON.parse(row.state_json) };
}

// ---------------------------------------------------------------------------
// Completed-game replay storage
// ---------------------------------------------------------------------------

const _insertCompletedGame = db.prepare(`
  INSERT OR IGNORE INTO completed_games
    (game_id, room_id, hero_player_id, witch_player_id, hero_name, witch_name,
     winner, win_reason, total_rounds, game_version, mode, pinned, created_at, expires_at)
  VALUES
    (@gameId, @roomId, @heroPlayerId, @witchPlayerId, @heroName, @witchName,
     @winner, @winReason, @totalRounds, @gameVersion, @mode, 0,
     unixepoch(), unixepoch() + @ttlSeconds)
`);

const _insertReplayRound = db.prepare(`
  INSERT OR IGNORE INTO game_replay_rounds (game_id, round_num, pre_state_json, steps_json)
  VALUES (@gameId, @roundNum, @preStateJson, @stepsJson)
`);

const _listCompletedByPlayer = db.prepare(`
  SELECT game_id, room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         winner, win_reason, total_rounds, game_version, mode, pinned, created_at, expires_at
  FROM   completed_games
  WHERE  hero_player_id = ? OR witch_player_id = ?
  ORDER  BY created_at DESC
`);

const _getCompletedRounds = db.prepare(`
  SELECT round_num, pre_state_json, steps_json
  FROM   game_replay_rounds
  WHERE  game_id = ?
  ORDER  BY round_num ASC
`);

const _getCompletedGame = db.prepare(`
  SELECT * FROM completed_games WHERE game_id = ?
`);

const _setPinned = db.prepare(`
  UPDATE completed_games
  SET pinned = @pinned,
      expires_at = CASE WHEN @pinned = 1 THEN NULL ELSE unixepoch() + @ttlSeconds END
  WHERE game_id = @gameId AND (hero_player_id = @playerId OR witch_player_id = @playerId)
`);

const _deleteCompletedGame = db.prepare(`
  DELETE FROM completed_games
  WHERE game_id = @gameId AND (hero_player_id = @playerId OR witch_player_id = @playerId)
`);

const _deleteCompletedRounds = db.prepare(`
  DELETE FROM game_replay_rounds WHERE game_id = ?
`);

const _pruneExpired = db.prepare(`
  SELECT game_id FROM completed_games
  WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at < unixepoch()
`);

const _deleteExpiredGame  = db.prepare(`DELETE FROM completed_games WHERE game_id = ?`);

const TTL_SECONDS = SAVE_MAX_AGE_DAYS * 86400;

/**
 * Persist a completed game with its full round replay history.
 *
 * @param {string} gameId      — fresh UUID for this completed-game record
 * @param {string} roomId      — original room UUID
 * @param {object} meta        — { heroPlayerId, witchPlayerId, heroName, witchName,
 *                                 winner, winReason, totalRounds, gameVersion, mode }
 * @param {Array}  rounds      — [{ roundNum, preStateJson, stepsJson }]
 */
export function createCompletedGame(gameId, roomId, meta, rounds) {
  const insertAll = db.transaction(() => {
    _insertCompletedGame.run({
      gameId,
      roomId,
      heroPlayerId:  meta.heroPlayerId  ?? null,
      witchPlayerId: meta.witchPlayerId ?? null,
      heroName:      meta.heroName      ?? '',
      witchName:     meta.witchName     ?? '',
      winner:        meta.winner        ?? '',
      winReason:     meta.winReason     ?? '',
      totalRounds:   meta.totalRounds   ?? 0,
      gameVersion:   meta.gameVersion   ?? '',
      mode:          meta.mode          ?? 'hvai',
      ttlSeconds:    TTL_SECONDS,
    });
    for (const r of rounds) {
      _insertReplayRound.run({
        gameId,
        roundNum:     r.roundNum,
        preStateJson: r.preStateJson,
        stepsJson:    r.stepsJson,
      });
    }
  });
  insertAll();
}

/**
 * List all completed games for a player (lightweight — no replay data).
 */
export function getCompletedGames(playerId) {
  return _listCompletedByPlayer.all(playerId, playerId);
}

/**
 * Return all rounds for a completed game, ordered by round number.
 * Each row: { round_num, pre_state_json, steps_json }
 */
export function getCompletedGameRounds(gameId) {
  return _getCompletedRounds.all(gameId);
}

/**
 * Get a single completed game record (without rounds).
 */
export function getCompletedGame(gameId) {
  return _getCompletedGame.get(gameId) ?? null;
}

/**
 * Pin or unpin a completed game.
 * Only the owning player can pin; returns true if a row was updated.
 */
export function pinCompletedGame(gameId, playerId, pinned) {
  const { changes } = _setPinned.run({
    gameId,
    playerId,
    pinned: pinned ? 1 : 0,
    ttlSeconds: TTL_SECONDS,
  });
  return changes > 0;
}

/**
 * Delete a completed game and all its rounds.
 * Only the owning player can delete; returns true if a row was deleted.
 */
export function deleteCompletedGame(gameId, playerId) {
  const { changes } = _deleteCompletedGame.run({ gameId, playerId });
  if (changes > 0) _deleteCompletedRounds.run(gameId);
  return changes > 0;
}

/**
 * Remove expired (unpinned, past TTL) completed games and their rounds.
 * Returns number of games pruned.
 */
export function pruneExpiredCompletedGames() {
  const expired = _pruneExpired.all();
  const del = db.transaction(() => {
    for (const { game_id } of expired) {
      _deleteExpiredGame.run(game_id);
      _deleteCompletedRounds.run(game_id);
    }
  });
  del();
  return expired.length;
}

const _getAllCompleted = db.prepare(
  `SELECT game_id, room_id, hero_player_id, witch_player_id,
          hero_name, witch_name, winner, win_reason, total_rounds,
          game_version, mode, pinned, created_at, expires_at
   FROM completed_games
   ORDER BY created_at DESC`
);

/**
 * Return all completed games (admin view — no player filter).
 */
export function getAllCompletedGames() {
  return _getAllCompleted.all();
}

// ── Single-player uploaded games ──────────────────────────────────────────────

const _insertSpGame = db.prepare(
  `INSERT OR REPLACE INTO sp_completed_games
     (game_id, hero_name, witch_name, winner, win_reason, total_rounds, game_version, mode)
   VALUES (@game_id, @hero_name, @witch_name, @winner, @win_reason, @total_rounds, @game_version, @mode)`
);
const _insertSpRound = db.prepare(
  `INSERT OR REPLACE INTO sp_replay_rounds (game_id, round_num, pre_state_json, steps_json)
   VALUES (@game_id, @round_num, @pre_state_json, @steps_json)`
);
const _getAllSpCompleted = db.prepare(
  `SELECT game_id, hero_name, witch_name, winner, win_reason, total_rounds,
          game_version, mode, created_at
   FROM sp_completed_games ORDER BY created_at DESC`
);
const _getSpCompletedRounds = db.prepare(
  `SELECT round_num, pre_state_json, steps_json
   FROM sp_replay_rounds WHERE game_id = ? ORDER BY round_num ASC`
);

/**
 * Persist a single-player completed game upload.
 * @param {string} gameId
 * @param {{ heroName, witchName, winner, winReason, totalRounds, gameVersion, mode }} meta
 * @param {{ roundNum, preState, steps }[]} rounds
 */
export function createSpCompletedGame(gameId, meta, rounds) {
  const insert = db.transaction(() => {
    _insertSpGame.run({
      game_id:      gameId,
      hero_name:    meta.heroName    ?? '',
      witch_name:   meta.witchName   ?? '',
      winner:       meta.winner,
      win_reason:   meta.winReason   ?? '',
      total_rounds: meta.totalRounds ?? rounds.length,
      game_version: meta.gameVersion ?? '',
      mode:         meta.mode        ?? 'hvai',
    });
    for (const r of rounds) {
      _insertSpRound.run({
        game_id:        gameId,
        round_num:      r.roundNum,
        pre_state_json: typeof r.preState === 'string' ? r.preState : JSON.stringify(r.preState),
        steps_json:     typeof r.steps    === 'string' ? r.steps    : JSON.stringify(r.steps),
      });
    }
  });
  insert();
}

const _getSpCompletedGame = db.prepare(
  `SELECT game_id, hero_name, witch_name, winner, win_reason, total_rounds,
          game_version, mode, created_at
   FROM sp_completed_games WHERE game_id = ?`
);

/** Return all SP uploaded completed games (admin view). */
export function getAllSpCompletedGames() {
  return _getAllSpCompleted.all();
}

/** Return one SP completed game record (without rounds). */
export function getSpCompletedGame(gameId) {
  return _getSpCompletedGame.get(gameId) ?? null;
}

/** Return all replay rounds for one SP game. */
export function getSpCompletedGameRounds(gameId) {
  return _getSpCompletedRounds.all(gameId);
}
