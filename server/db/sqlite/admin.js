// Admin dashboard queries that cross multiple tables.
import { prepare } from './client.js';

// Paginated completed-games query (source of admin game listing — active and
// saved games are served from memory in the calling code).
const _completedPage = prepare(`
  SELECT game_id AS id, 'completed_mp' AS source, hero_name, witch_name,
         total_rounds AS round, NULL AS phase, winner, win_reason,
         game_version, mode, players_json,
         created_at AS updated_at, created_at
  FROM completed_games
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const _completedCount = prepare('SELECT COUNT(*) AS cnt FROM completed_games');

export const admin = {
  /** Paginated fetch of completed multiplayer games for the admin dashboard. */
  listCompletedPage({ limit, offset }) {
    return _completedPage.all(limit, offset);
  },
  countCompleted() {
    return _completedCount.get().cnt;
  },
};
