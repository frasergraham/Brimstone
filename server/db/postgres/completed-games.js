// Completed games — Postgres implementation.
import { query, runMutation, transaction } from './client.js';

export const completedGames = {
  create(meta, rounds) {
    const run = transaction(() => {
      runMutation(`
        INSERT INTO completed_games
          (game_id, room_id, hero_player_id, witch_player_id, hero_name, witch_name,
           winner, win_reason, total_rounds, game_version, mode, players_json,
           pinned, created_at, expires_at)
        VALUES
          ($1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12,
           0, EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT + $13)
        ON CONFLICT (game_id) DO NOTHING
      `, [
        meta.gameId, meta.roomId, meta.heroPlayerId, meta.witchPlayerId, meta.heroName, meta.witchName,
        meta.winner, meta.winReason, meta.totalRounds, meta.gameVersion, meta.mode, meta.playersJson,
        meta.ttlSeconds,
      ]);
      for (const r of rounds) {
        runMutation(`
          INSERT INTO game_replay_rounds (game_id, round_num, pre_state_json, steps_json, final_entities_json)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (game_id, round_num) DO NOTHING
        `, [meta.gameId, r.roundNum, r.preStateJson, r.stepsJson, r.finalEntitiesJson ?? null]);
      }
    });
    run();
  },
  listForPlayer(playerId) {
    return query(`
      SELECT game_id, room_id, hero_player_id, witch_player_id, hero_name, witch_name,
             winner, win_reason, total_rounds, game_version, mode, players_json, pinned,
             created_at, expires_at
      FROM   completed_games
      WHERE  hero_player_id = $1 OR witch_player_id = $1
             OR players_json LIKE '%' || $1 || '%'
      ORDER  BY created_at DESC
    `, [playerId]);
  },
  listRounds(gameId) {
    return query(`
      SELECT round_num, pre_state_json, steps_json, final_entities_json
      FROM   game_replay_rounds
      WHERE  game_id = $1
      ORDER  BY round_num ASC
    `, [gameId]);
  },
  get(gameId) {
    return query('SELECT * FROM completed_games WHERE game_id = $1', [gameId])[0] ?? null;
  },
  setPinned({ gameId, playerId, pinned, ttlSeconds }) {
    const { changes } = runMutation(`
      UPDATE completed_games
      SET pinned = $1,
          expires_at = CASE WHEN $1 = 1 THEN NULL
                            ELSE EXTRACT(EPOCH FROM NOW())::BIGINT + $2 END
      WHERE game_id = $3 AND (hero_player_id = $4 OR witch_player_id = $4
            OR players_json LIKE '%' || $4 || '%')
    `, [pinned ? 1 : 0, ttlSeconds, gameId, playerId]);
    return changes > 0;
  },
  delete({ gameId, playerId }) {
    const { changes } = runMutation(`
      DELETE FROM completed_games
      WHERE game_id = $1 AND (hero_player_id = $2 OR witch_player_id = $2
            OR players_json LIKE '%' || $2 || '%')
    `, [gameId, playerId]);
    if (changes > 0) {
      runMutation('DELETE FROM game_replay_rounds WHERE game_id = $1', [gameId]);
    }
    return changes > 0;
  },
  pruneExpired() {
    const expired = query(`
      SELECT game_id FROM completed_games
      WHERE pinned = 0 AND expires_at IS NOT NULL
        AND expires_at < EXTRACT(EPOCH FROM NOW())::BIGINT
    `);
    const run = transaction(() => {
      for (const { game_id } of expired) {
        runMutation('DELETE FROM completed_games WHERE game_id = $1', [game_id]);
        runMutation('DELETE FROM game_replay_rounds WHERE game_id = $1', [game_id]);
      }
    });
    run();
    return expired.length;
  },
  listBattles(limit) {
    return query(`
      SELECT game_id, room_id, hero_name, witch_name,
             winner, win_reason, total_rounds, game_version, mode,
             players_json, created_at
      FROM   completed_games
      WHERE  mode = 'battle'
      ORDER  BY created_at DESC
      LIMIT  $1
    `, [limit]);
  },
  listBattlesForPlayer(playerId, limit) {
    return query(`
      SELECT game_id, room_id, hero_name, witch_name,
             winner, win_reason, total_rounds, game_version, mode,
             players_json, created_at
      FROM   completed_games
      WHERE  mode = 'battle'
        AND  (hero_player_id = $1 OR witch_player_id = $1
              OR players_json LIKE '%' || $1 || '%')
      ORDER  BY created_at DESC
      LIMIT  $2
    `, [playerId, limit]);
  },
  listAllAdmin() {
    return query(`
      SELECT game_id, room_id, hero_player_id, witch_player_id,
             hero_name, witch_name, winner, win_reason, total_rounds,
             game_version, mode, players_json, pinned, created_at, expires_at
      FROM   completed_games
      ORDER  BY created_at DESC
    `);
  },
};
