// Admin cross-table queries — Postgres implementation.
import { query } from './client.js';

export const admin = {
  listCompletedPage({ limit, offset }) {
    return query(`
      SELECT game_id AS id, 'completed_mp' AS source, hero_name, witch_name,
             total_rounds AS round, NULL AS phase, winner, win_reason,
             game_version, mode, players_json,
             created_at AS updated_at, created_at
      FROM completed_games
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
  },
  countCompleted() {
    return Number(query('SELECT COUNT(*) AS cnt FROM completed_games')[0].cnt);
  },
};
