// Async (play-by-mail) games domain — async_games + async_plan_status + async_notifications.
import { prepare } from './client.js';

const _insert = prepare(`
  INSERT INTO async_games
    (room_id, code, host_player_id, host_faction,
     hero_player_id, witch_player_id, hero_name, witch_name,
     turn_interval_ms, game_version, config_json, invitee_email, status)
  VALUES
    (@roomId, @code, @hostPlayerId, @hostFaction,
     @heroPlayerId, @witchPlayerId, @heroName, @witchName,
     @turnIntervalMs, @gameVersion, @configJson, @inviteeEmail, 'waiting')
`);

const _getByRoom = prepare('SELECT * FROM async_games WHERE room_id = ?');
const _getByCode = prepare(`SELECT * FROM async_games WHERE code = ? AND status = 'waiting'`);
const _codeExists = prepare('SELECT 1 FROM async_games WHERE code = ?');

const _listForPlayer = prepare(`
  SELECT room_id, code, hero_player_id, witch_player_id,
         hero_name, witch_name, host_player_id, host_faction,
         round, phase, turn_deadline, turn_interval_ms,
         status, winner, win_reason, config_json, updated_at, created_at
  FROM   async_games
  WHERE  (hero_player_id = ? OR witch_player_id = ? OR host_player_id = ?)
         AND status IN ('waiting', 'playing')
  ORDER  BY updated_at DESC
`);

const _activate = prepare(`
  UPDATE async_games SET
    hero_player_id = @heroPlayerId,
    witch_player_id = @witchPlayerId,
    hero_name = @heroName,
    witch_name = @witchName,
    state_json = @stateJson,
    round = @round,
    phase = @phase,
    turn_deadline = @turnDeadline,
    status = 'playing',
    updated_at = unixepoch()
  WHERE room_id = @roomId AND status = 'waiting'
`);

const _updateState = prepare(`
  UPDATE async_games SET
    state_json = @stateJson,
    round = @round,
    phase = @phase,
    turn_deadline = @turnDeadline,
    consecutive_timeout_rounds = @consecutiveTimeoutRounds,
    updated_at = unixepoch()
  WHERE room_id = @roomId
`);

const _finish = prepare(`
  UPDATE async_games SET
    status = @status,
    winner = @winner,
    win_reason = @winReason,
    state_json = @stateJson,
    updated_at = unixepoch()
  WHERE room_id = @roomId
`);

const _delete             = prepare('DELETE FROM async_games WHERE room_id = ?');
const _deletePlans        = prepare('DELETE FROM async_plan_status WHERE room_id = ?');
const _deleteNotifications = prepare('DELETE FROM async_notifications WHERE room_id = ?');

const _findStale = prepare(`
  SELECT room_id FROM async_games
  WHERE (status IN ('finished', 'abandoned') AND updated_at < ?)
     OR (game_version != ?)
`);
const _pruneStale = prepare(`
  DELETE FROM async_games
  WHERE (status IN ('finished', 'abandoned') AND updated_at < ?)
     OR (game_version != ?)
`);
const _pruneOrphanPlans = prepare(`
  DELETE FROM async_plan_status
  WHERE room_id NOT IN (SELECT room_id FROM async_games)
`);
// NOTE: async_notifications is shared between the legacy async_games system
// and the unified game_saves system (both call _record() via server/notifications.js).
// This prune must preserve rows for rooms that live in EITHER table — otherwise
// every server restart wipes dedup records for unified multiplayer games, and
// the next checkApproachingDeadlines() cycle re-fires an already-sent push.
const _pruneOrphanNotifs = prepare(`
  DELETE FROM async_notifications
  WHERE room_id NOT IN (SELECT room_id FROM async_games)
    AND room_id NOT IN (SELECT room_id FROM game_saves)
`);

const _insertPlanRow = prepare(`
  INSERT INTO async_plan_status (room_id, player_id, round)
  VALUES (@roomId, @playerId, @round)
`);

const _submitPlan = prepare(`
  UPDATE async_plan_status SET
    plan_json = @planJson,
    submitted_at = unixepoch()
  WHERE room_id = @roomId AND player_id = @playerId AND round = @round
        AND plan_json IS NULL
`);

const _listPlanStatus = prepare(`
  SELECT player_id, plan_json IS NOT NULL AS submitted, plan_json
  FROM   async_plan_status
  WHERE  room_id = ? AND round = ?
`);

const _countPending = prepare(`
  SELECT COUNT(*) AS pending
  FROM   async_plan_status
  WHERE  room_id = ? AND round = ? AND plan_json IS NULL
`);

const _listExpired = prepare(`
  SELECT room_id FROM async_games
  WHERE  turn_deadline < unixepoch() AND status = 'playing'
`);

const _listCurrentRoundPlanStatus = prepare(`
  SELECT room_id, player_id, plan_json IS NOT NULL AS submitted
  FROM   async_plan_status AS ps
  WHERE  ps.round = (SELECT round FROM async_games WHERE async_games.room_id = ps.room_id)
`);

// ── Legacy migration helpers (consumed by lobby.js#migrateAsyncGames) ──────
const _listForMigration = prepare(`
  SELECT * FROM async_games WHERE status IN ('playing', 'waiting')
`);
const _listPlansForRoom = prepare(`
  SELECT * FROM async_plan_status WHERE room_id = ?
`);
const _markMigrated = prepare(
  `UPDATE async_games SET status = 'migrated' WHERE room_id = ?`
);

export const async_ = {
  create(row) { _insert.run(row); },
  get(roomId) { return _getByRoom.get(roomId) ?? null; },
  getByCode(code) { return _getByCode.get(code) ?? null; },
  codeExists(code) { return !!_codeExists.get(code); },
  listForPlayer(playerId) {
    return _listForPlayer.all(playerId, playerId, playerId);
  },
  activate(row) { _activate.run(row); },
  update(row) { _updateState.run(row); },
  finish(row) { _finish.run(row); },
  delete(roomId) {
    _deleteNotifications.run(roomId);
    _deletePlans.run(roomId);
    _delete.run(roomId);
  },
  /** Prune stale/incompatible games. Returns { found, deleted }. */
  pruneStale(cutoffUnixSeconds, currentVersion) {
    const stale = _findStale.all(cutoffUnixSeconds, currentVersion);
    for (const { room_id } of stale) {
      _deletePlans.run(room_id);
      _deleteNotifications.run(room_id);
    }
    const result = _pruneStale.run(cutoffUnixSeconds, currentVersion);
    _pruneOrphanPlans.run();
    _pruneOrphanNotifs.run();
    return { found: stale.length, deleted: result.changes };
  },
  insertPlanRow({ roomId, playerId, round }) {
    _insertPlanRow.run({ roomId, playerId, round });
  },
  submitPlan({ roomId, playerId, round, planJson }) {
    const result = _submitPlan.run({ roomId, playerId, round, planJson });
    return result.changes > 0;
  },
  listPlanStatusForRound(roomId, round) {
    return _listPlanStatus.all(roomId, round);
  },
  countPendingPlans(roomId, round) {
    return _countPending.get(roomId, round).pending;
  },
  listExpiredDeadlineRooms() {
    return _listExpired.all();
  },
  listCurrentRoundPlanStatus() {
    return _listCurrentRoundPlanStatus.all();
  },
  // Migration helpers
  listForMigration() {
    try { return _listForMigration.all(); }
    catch { return []; }   // table may not exist yet
  },
  listPlansForRoom(roomId) {
    try { return _listPlansForRoom.all(roomId); }
    catch { return []; }
  },
  markMigrated(roomId) {
    try { _markMigrated.run(roomId); } catch {}
  },
};
