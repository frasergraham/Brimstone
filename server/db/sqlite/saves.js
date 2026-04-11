// In-progress game saves domain (game_saves table).
import { prepare, transaction } from './client.js';

const _upsert = prepare(`
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

const _delete = prepare('DELETE FROM game_saves WHERE room_id = ?');

const _listByPlayer = prepare(`
  SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         round, phase, game_version, turn_interval_ms, turn_deadline,
         status, code, players_json, updated_at, created_at
  FROM   game_saves
  WHERE  hero_player_id = ? OR witch_player_id = ?
  ORDER  BY updated_at DESC
`);

const _getByRoom = prepare('SELECT * FROM game_saves WHERE room_id = ?');

const _listNonBattle = prepare(`
  SELECT room_id, game_version, save_version, updated_at FROM game_saves
  WHERE COALESCE(json_extract(config_json, '$.isBattle'), 0) != 1
`);

const _listActiveBattles = prepare(`
  SELECT * FROM game_saves
  WHERE  status = 'playing'
    AND  json_extract(config_json, '$.isBattle') = 1
  ORDER  BY updated_at DESC
`);

const _listAllPlaying = prepare(`
  SELECT * FROM game_saves
  WHERE  status IN ('playing', 'lobby')
  ORDER  BY updated_at DESC
`);

const _listAdmin = prepare(`
  SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         round, phase, game_version, updated_at, created_at
  FROM   game_saves
  ORDER  BY updated_at DESC
`);

const _listExpiredDeadlines = prepare(`
  SELECT room_id, turn_deadline, turn_interval_ms, players_json, round
  FROM   game_saves
  WHERE  status = 'playing'
    AND  turn_deadline IS NOT NULL
    AND  turn_deadline < unixepoch()
`);

const _listApproachingDeadlines = prepare(`
  SELECT room_id, turn_deadline, turn_interval_ms, players_json, round, config_json
  FROM   game_saves
  WHERE  status = 'playing'
    AND  turn_deadline IS NOT NULL
    AND  turn_deadline > unixepoch()
    AND  turn_deadline <= unixepoch() + ?
`);

const _listActiveForPlayer = prepare(`
  SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         round, phase, game_version, turn_interval_ms, turn_deadline,
         status, code, players_json, config_json, updated_at, created_at
  FROM   game_saves
  WHERE  status IN ('playing', 'lobby')
    AND  (hero_player_id = ? OR witch_player_id = ?
          OR players_json LIKE '%' || ? || '%')
  ORDER  BY updated_at DESC
`);

export const saves = {
  upsert(row) { _upsert.run(row); },
  delete(roomId) { _delete.run(roomId); },
  /** Returns the raw row with state_json as a string (caller parses if needed). */
  getRaw(roomId) { return _getByRoom.get(roomId) ?? null; },
  /** Returns the row with an extra `.state` field parsed from state_json, or null. */
  get(roomId) {
    const row = _getByRoom.get(roomId);
    if (!row) return null;
    return { ...row, state: JSON.parse(row.state_json) };
  },
  listByPlayer(playerId) {
    return _listByPlayer.all(playerId, playerId);
  },
  /** Lightweight list of non-battle saves for pruning. Returns only columns
   *  needed for version/age checks. */
  listNonBattleForPruning() {
    return _listNonBattle.all();
  },
  /** Full-state list of active battle saves. Adds parsed `.state` field. */
  listActiveBattles() {
    return _listActiveBattles.all().map(row => {
      try { row.state = JSON.parse(row.state_json); } catch { row.state = null; }
      return row;
    });
  },
  /** Full-state list of every save with status 'playing' or 'lobby'. */
  listAllPlaying() {
    return _listAllPlaying.all().map(row => {
      try { row.state = JSON.parse(row.state_json); } catch { row.state = null; }
      return row;
    });
  },
  listAdmin() {
    return _listAdmin.all();
  },
  /** Delete a batch of saves by room id (transactional). Returns the number
   *  of game_saves rows deleted. Also clears their replay-round records. */
  pruneByIds(roomIds) {
    if (!roomIds || roomIds.length === 0) return 0;
    const deleteReplay = prepare('DELETE FROM save_replay_rounds WHERE room_id = ?');
    const placeholders = roomIds.map(() => '?').join(',');
    const deleteSaves = prepare(`DELETE FROM game_saves WHERE room_id IN (${placeholders})`);
    const run = transaction(() => {
      for (const id of roomIds) deleteReplay.run(id);
      return deleteSaves.run(...roomIds).changes;
    });
    return run();
  },
  listExpiredDeadlines() {
    return _listExpiredDeadlines.all();
  },
  listApproachingDeadlines(windowSeconds) {
    return _listApproachingDeadlines.all(windowSeconds);
  },
  listActiveForPlayer(playerId) {
    return _listActiveForPlayer.all(playerId, playerId, playerId);
  },
};
