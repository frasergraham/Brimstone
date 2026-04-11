// In-progress game saves — Postgres implementation.
import { query, runMutation, transaction } from './client.js';

export const saves = {
  upsert(row) {
    runMutation(`
      INSERT INTO game_saves
        (room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         round, phase, game_version, save_version, state_json,
         turn_deadline, turn_interval_ms, consecutive_timeouts,
         config_json, players_json, is_private, code, status,
         updated_at, created_at)
      VALUES
        ($1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, $17, $18,
         EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT)
      ON CONFLICT (room_id) DO UPDATE SET
        round                = EXCLUDED.round,
        phase                = EXCLUDED.phase,
        game_version         = EXCLUDED.game_version,
        save_version         = EXCLUDED.save_version,
        state_json           = EXCLUDED.state_json,
        turn_deadline        = EXCLUDED.turn_deadline,
        turn_interval_ms     = EXCLUDED.turn_interval_ms,
        consecutive_timeouts = EXCLUDED.consecutive_timeouts,
        config_json          = EXCLUDED.config_json,
        players_json         = EXCLUDED.players_json,
        is_private           = EXCLUDED.is_private,
        code                 = EXCLUDED.code,
        status               = EXCLUDED.status,
        updated_at           = EXTRACT(EPOCH FROM NOW())::BIGINT
    `, [
      row.roomId, row.heroPlayerId, row.witchPlayerId, row.heroName, row.witchName,
      row.round, row.phase, row.gameVersion, row.saveVersion, row.stateJson,
      row.turnDeadline, row.turnIntervalMs, row.consecutiveTimeouts,
      row.configJson, row.playersJson, row.isPrivate, row.code, row.status,
    ]);
  },
  delete(roomId) {
    runMutation('DELETE FROM game_saves WHERE room_id = $1', [roomId]);
  },
  getRaw(roomId) {
    return query('SELECT * FROM game_saves WHERE room_id = $1', [roomId])[0] ?? null;
  },
  get(roomId) {
    const row = query('SELECT * FROM game_saves WHERE room_id = $1', [roomId])[0];
    if (!row) return null;
    return { ...row, state: JSON.parse(row.state_json) };
  },
  listByPlayer(playerId) {
    return query(`
      SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
             round, phase, game_version, turn_interval_ms, turn_deadline,
             status, code, players_json, updated_at, created_at
      FROM   game_saves
      WHERE  hero_player_id = $1 OR witch_player_id = $1
      ORDER  BY updated_at DESC
    `, [playerId]);
  },
  listNonBattleForPruning() {
    return query(`
      SELECT room_id, game_version, save_version, updated_at FROM game_saves
      WHERE COALESCE((config_json::jsonb ->> 'isBattle')::int, 0) <> 1
    `);
  },
  listActiveBattles() {
    return query(`
      SELECT * FROM game_saves
      WHERE  status = 'playing'
        AND  (config_json::jsonb ->> 'isBattle')::int = 1
      ORDER  BY updated_at DESC
    `).map(row => {
      try { row.state = JSON.parse(row.state_json); } catch { row.state = null; }
      return row;
    });
  },
  listAllPlaying() {
    return query(`
      SELECT * FROM game_saves
      WHERE  status IN ('playing', 'lobby')
      ORDER  BY updated_at DESC
    `).map(row => {
      try { row.state = JSON.parse(row.state_json); } catch { row.state = null; }
      return row;
    });
  },
  listAdmin() {
    return query(`
      SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
             round, phase, game_version, updated_at, created_at
      FROM   game_saves
      ORDER  BY updated_at DESC
    `);
  },
  pruneByIds(roomIds) {
    if (!roomIds || roomIds.length === 0) return 0;
    const run = transaction(() => {
      runMutation('DELETE FROM save_replay_rounds WHERE room_id = ANY($1::text[])', [roomIds]);
      const { changes } = runMutation('DELETE FROM game_saves WHERE room_id = ANY($1::text[])', [roomIds]);
      return changes;
    });
    return run();
  },
  listExpiredDeadlines() {
    return query(`
      SELECT room_id, turn_deadline, turn_interval_ms, players_json, round
      FROM   game_saves
      WHERE  status = 'playing'
        AND  turn_deadline IS NOT NULL
        AND  turn_deadline < EXTRACT(EPOCH FROM NOW())::BIGINT
    `);
  },
  listApproachingDeadlines(windowSeconds) {
    return query(`
      SELECT room_id, turn_deadline, turn_interval_ms, players_json, round, config_json
      FROM   game_saves
      WHERE  status = 'playing'
        AND  turn_deadline IS NOT NULL
        AND  turn_deadline > EXTRACT(EPOCH FROM NOW())::BIGINT
        AND  turn_deadline <= EXTRACT(EPOCH FROM NOW())::BIGINT + $1
    `, [windowSeconds]);
  },
  listActiveForPlayer(playerId) {
    return query(`
      SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
             round, phase, game_version, turn_interval_ms, turn_deadline,
             status, code, players_json, config_json, updated_at, created_at
      FROM   game_saves
      WHERE  status IN ('playing', 'lobby')
        AND  (hero_player_id = $1 OR witch_player_id = $1
              OR players_json LIKE '%' || $1 || '%')
      ORDER  BY updated_at DESC
    `, [playerId]);
  },
};
