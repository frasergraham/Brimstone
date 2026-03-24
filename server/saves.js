// Game save persistence — upsert/delete/list/get for in-progress game states.
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

/** Remove the save for a completed or abandoned room. */
export function deleteSave(roomId) {
  _delete.run(roomId);
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
