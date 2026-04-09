// Game save persistence — upsert/delete/list/get for in-progress game states
// and completed-game replay storage.
import db from './db.js';

const SAVE_MAX_AGE_DAYS = 3;

/** Check if a save's version is compatible with the running server.
 *  Uses SAVE_VERSION (integer) when present in the save; falls back to
 *  major.minor comparison for saves created before SAVE_VERSION was added. */
export function isVersionCompatible(saveVersion, currentVersion, saveSaveVersion, currentSaveVersion) {
  // If the save has a SAVE_VERSION field, use it (exact integer match)
  if (saveSaveVersion != null && currentSaveVersion != null) {
    return saveSaveVersion === currentSaveVersion;
  }
  // Legacy fallback: compare major.minor of the game version string
  if (!saveVersion || !currentVersion) return false;
  const [sMaj, sMin] = saveVersion.split('.');
  const [cMaj, cMin] = currentVersion.split('.');
  return sMaj === cMaj && sMin === cMin;
}

const _upsert = db.prepare(`
  INSERT INTO game_saves
    (room_id, hero_player_id, witch_player_id, hero_name, witch_name,
     round, phase, game_version, save_version, state_json,
     turn_deadline, turn_interval_ms, consecutive_timeouts,
     config_json, players_json, is_private, code, status,
     updated_at, created_at)
  VALUES
    (@roomId, @heroPlayerId, @witchPlayerId, @heroName, @witchName,
     @round, @phase, @gameVersion, @saveVersion, @stateJson,
     @turnDeadline, @turnIntervalMs, @consecutiveTimeouts,
     @configJson, @playersJson, @isPrivate, @code, @status,
     unixepoch(), unixepoch())
  ON CONFLICT(room_id) DO UPDATE SET
    round                = excluded.round,
    phase                = excluded.phase,
    game_version         = excluded.game_version,
    save_version         = excluded.save_version,
    state_json           = excluded.state_json,
    turn_deadline        = excluded.turn_deadline,
    turn_interval_ms     = excluded.turn_interval_ms,
    consecutive_timeouts = excluded.consecutive_timeouts,
    config_json          = excluded.config_json,
    players_json         = excluded.players_json,
    is_private           = excluded.is_private,
    code                 = excluded.code,
    status               = excluded.status,
    updated_at           = unixepoch()
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
const _getLastSaveRound = db.prepare(`
  SELECT round_num, pre_state_json, steps_json
  FROM   save_replay_rounds
  WHERE  room_id = ?
  ORDER  BY round_num DESC
  LIMIT  1
`);

const _listByPlayer = db.prepare(`
  SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         round, phase, game_version, turn_interval_ms, turn_deadline,
         status, code, players_json, updated_at, created_at
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
 * @param {object} [extra]            — optional: { turnDeadline, turnIntervalMs,
 *                                       consecutiveTimeouts, config, players, isPrivate, code, status }
 */
export function upsertSave(roomId, heroPlayerId, witchPlayerId, heroName, witchName, serializedState, extra = {}) {
  _upsert.run({
    roomId,
    heroPlayerId:        heroPlayerId  ?? null,
    witchPlayerId:       witchPlayerId ?? null,
    heroName:            heroName      ?? '',
    witchName:           witchName     ?? '',
    round:               serializedState.round,
    phase:               serializedState.phase,
    gameVersion:         serializedState.version,
    saveVersion:         extra.saveVersion ?? null,
    stateJson:           JSON.stringify(serializedState),
    turnDeadline:        extra.turnDeadline        ?? null,
    turnIntervalMs:      extra.turnIntervalMs       ?? 90000,
    consecutiveTimeouts: extra.consecutiveTimeouts  ? JSON.stringify(extra.consecutiveTimeouts) : '{}',
    configJson:          extra.config               ? JSON.stringify(extra.config)               : '{}',
    playersJson:         extra.players              ? JSON.stringify(extra.players)              : '[]',
    isPrivate:           extra.isPrivate            ? 1 : 0,
    code:                extra.code                 ?? null,
    status:              extra.status               ?? 'playing',
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

/** Retrieve just the most recent replay round for a save. Returns null if none. */
export function getLastSaveRound(roomId) {
  return _getLastSaveRound.get(roomId) ?? null;
}

/**
 * Remove stale saves on server startup:
 *   - any save idle for more than SAVE_MAX_AGE_DAYS days
 *   - any save from a different major.minor version (schema may be incompatible)
 *     Patch-only bumps (e.g. 1.3.24 → 1.3.25) are compatible and kept.
 *
 * Returns the number of rows pruned.
 */
export function pruneStaleAndIncompatibleSaves(currentVersion, currentSaveVersion) {
  const cutoff = Math.floor(Date.now() / 1000) - SAVE_MAX_AGE_DAYS * 86400;
  // Fetch non-battle candidates, then filter in JS for save-version-aware check.
  const candidates = db.prepare(`
    SELECT room_id, game_version, save_version, updated_at FROM game_saves
    WHERE COALESCE(json_extract(config_json, '$.isBattle'), 0) != 1
  `).all();

  const roomsToPrune = candidates.filter(row =>
    row.updated_at < cutoff ||
    !isVersionCompatible(row.game_version, currentVersion, row.save_version, currentSaveVersion)
  );
  if (roomsToPrune.length === 0) return 0;

  for (const { room_id } of roomsToPrune) {
    _deleteSaveRounds.run(room_id);
  }
  const placeholders = roomsToPrune.map(() => '?').join(',');
  const { changes } = db.prepare(
    `DELETE FROM game_saves WHERE room_id IN (${placeholders})`
  ).run(...roomsToPrune.map(r => r.room_id));
  return changes;
}

/**
 * Find all battle-mode saves in the DB (for recovery on server startup).
 * Returns rows with full state_json for reconstruction.
 */
export function getActiveBattleSaves() {
  return db.prepare(`
    SELECT * FROM game_saves
    WHERE status = 'playing'
      AND json_extract(config_json, '$.isBattle') = 1
    ORDER BY updated_at DESC
  `).all().map(row => {
    try { row.state = JSON.parse(row.state_json); } catch { row.state = null; }
    return row;
  });
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
     winner, win_reason, total_rounds, game_version, mode, players_json, pinned, created_at, expires_at)
  VALUES
    (@gameId, @roomId, @heroPlayerId, @witchPlayerId, @heroName, @witchName,
     @winner, @winReason, @totalRounds, @gameVersion, @mode, @playersJson, 0,
     unixepoch(), unixepoch() + @ttlSeconds)
`);

const _insertReplayRound = db.prepare(`
  INSERT OR IGNORE INTO game_replay_rounds (game_id, round_num, pre_state_json, steps_json)
  VALUES (@gameId, @roundNum, @preStateJson, @stepsJson)
`);

const _listCompletedByPlayer = db.prepare(`
  SELECT game_id, room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         winner, win_reason, total_rounds, game_version, mode, players_json, pinned, created_at, expires_at
  FROM   completed_games
  WHERE  hero_player_id = ? OR witch_player_id = ?
         OR players_json LIKE '%' || ? || '%'
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
  WHERE game_id = @gameId AND (hero_player_id = @playerId OR witch_player_id = @playerId
        OR players_json LIKE '%' || @playerId || '%')
`);

const _deleteCompletedGame = db.prepare(`
  DELETE FROM completed_games
  WHERE game_id = @gameId AND (hero_player_id = @playerId OR witch_player_id = @playerId
        OR players_json LIKE '%' || @playerId || '%')
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
      playersJson:   meta.playersJson   ?? '[]',
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
  return _listCompletedByPlayer.all(playerId, playerId, playerId);
}

/**
 * List all completed battle games (newest first, up to `limit`).
 */
export function getCompletedBattles(limit = 20) {
  return db.prepare(`
    SELECT game_id, room_id, hero_name, witch_name,
           winner, win_reason, total_rounds, game_version, mode,
           players_json, created_at
    FROM   completed_games
    WHERE  mode = 'battle'
    ORDER  BY created_at DESC
    LIMIT  ?
  `).all(limit);
}

/**
 * List completed battle games that a specific player participated in.
 */
export function getCompletedBattlesForPlayer(playerId, limit = 20) {
  return db.prepare(`
    SELECT game_id, room_id, hero_name, witch_name,
           winner, win_reason, total_rounds, game_version, mode,
           players_json, created_at
    FROM   completed_games
    WHERE  mode = 'battle'
      AND  (hero_player_id = ? OR witch_player_id = ?
            OR players_json LIKE '%' || ? || '%')
    ORDER  BY created_at DESC
    LIMIT  ?
  `).all(playerId, playerId, playerId, limit);
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
          game_version, mode, players_json, pinned, created_at, expires_at
   FROM completed_games
   ORDER BY created_at DESC`
);

/**
 * Return all completed games (admin view — no player filter).
 */
export function getAllCompletedGames() {
  return _getAllCompleted.all();
}

// ── Plan persistence (unified multiplayer) ────────────────────────────────────

const _upsertPlanStatus = db.prepare(`
  INSERT INTO game_plan_status (room_id, player_id, round, plan_json, submitted_at)
  VALUES (@roomId, @playerId, @round, @planJson, @submittedAt)
  ON CONFLICT(room_id, player_id, round) DO UPDATE SET
    plan_json    = excluded.plan_json,
    submitted_at = excluded.submitted_at
`);

const _getPlanStatusForRound = db.prepare(`
  SELECT player_id, plan_json, submitted_at
  FROM   game_plan_status
  WHERE  room_id = ? AND round = ?
`);

const _clearPlanStatusForRound = db.prepare(`
  DELETE FROM game_plan_status WHERE room_id = ? AND round = ?
`);

const _clearAllPlanStatus = db.prepare(`
  DELETE FROM game_plan_status WHERE room_id = ?
`);

/**
 * Create empty plan status rows for all players at the start of a round.
 * @param {string} roomId
 * @param {string[]} playerIds
 * @param {number} round
 */
const _insertPlanStatusIfMissing = db.prepare(`
  INSERT OR IGNORE INTO game_plan_status (room_id, player_id, round, plan_json, submitted_at)
  VALUES (@roomId, @playerId, @round, NULL, NULL)
`);

export function insertPlanStatusRows(roomId, playerIds, round) {
  for (const pid of playerIds) {
    _insertPlanStatusIfMissing.run({ roomId, playerId: pid, round });
  }
}

/**
 * Persist a submitted plan for a player.
 * @param {string} roomId
 * @param {string} playerId
 * @param {number} round
 * @param {object} plan — the PlanAction[] array
 */
export function upsertPlanStatus(roomId, playerId, round, plan) {
  _upsertPlanStatus.run({
    roomId,
    playerId,
    round,
    planJson:    JSON.stringify(plan),
    submittedAt: Math.floor(Date.now() / 1000),
  });
}

/**
 * Get plan status rows for a round. Returns array of { player_id, plan_json, submitted_at }.
 */
export function getPlanStatus(roomId, round) {
  return _getPlanStatusForRound.all(roomId, round);
}

/**
 * Check whether all specified players have submitted plans for a round.
 */
export function allPlansSubmitted(roomId, round, playerIds) {
  const rows = _getPlanStatusForRound.all(roomId, round);
  const submitted = new Set(rows.filter(r => r.plan_json !== null).map(r => r.player_id));
  return playerIds.every(pid => submitted.has(pid));
}

/**
 * Clean up plan status after resolution completes.
 */
export function clearPlanStatus(roomId, round) {
  _clearPlanStatusForRound.run(roomId, round);
}

/** Clean up all plan status rows for a room (on game over / deletion). */
export function clearAllPlanStatus(roomId) {
  _clearAllPlanStatus.run(roomId);
}

/**
 * Get all game_saves with expired turn deadlines that are still playing.
 * Used by the background deadline checker.
 */
export function getExpiredDeadlineGames() {
  return db.prepare(`
    SELECT room_id, turn_deadline, turn_interval_ms, players_json, round
    FROM   game_saves
    WHERE  status = 'playing'
      AND  turn_deadline IS NOT NULL
      AND  turn_deadline < unixepoch()
  `).all();
}

export function getApproachingDeadlineGames(windowMs = 600_000) {
  const windowS = Math.floor(windowMs / 1000);
  return db.prepare(`
    SELECT room_id, turn_deadline, turn_interval_ms, players_json, round, config_json
    FROM   game_saves
    WHERE  status = 'playing'
      AND  turn_deadline IS NOT NULL
      AND  turn_deadline > unixepoch()
      AND  turn_deadline <= unixepoch() + ?
  `).all(windowS);
}

/**
 * List all in-progress games for a player, including games stored in players_json.
 * Returns lightweight rows (no state_json) sorted by action-needed first.
 */
export function getActiveGamesForPlayer(playerId) {
  // Query both hero/witch columns (legacy) and players_json (new NvN)
  return db.prepare(`
    SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
           round, phase, game_version, turn_interval_ms, turn_deadline,
           status, code, players_json, config_json, updated_at, created_at
    FROM   game_saves
    WHERE  status IN ('playing', 'lobby')
      AND  (hero_player_id = ? OR witch_player_id = ?
            OR players_json LIKE '%' || ? || '%')
    ORDER  BY updated_at DESC
  `).all(playerId, playerId, playerId);
}

