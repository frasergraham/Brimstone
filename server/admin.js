// Admin API helpers — open access (no authentication required).
import db from './db.js';

/** All registered players with full stats, newest first. */
export function getAllPlayers(limit = 500) {
  return db.prepare(`
    SELECT id, username, wins, losses, draws, created_at,
           ROUND(CAST(wins AS REAL) / MAX(wins + losses + draws, 1) * 100, 1) AS win_pct
    FROM   players
    ORDER  BY wins DESC, created_at DESC
    LIMIT  ?
  `).all(limit);
}

/** All persisted saves — lightweight rows (no state_json), newest-first. */
export function getAllSaves() {
  return db.prepare(`
    SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
           round, phase, game_version, updated_at, created_at
    FROM   game_saves
    ORDER  BY updated_at DESC
  `).all();
}

/** Full save row for a specific room, with state_json parsed to an object. */
export function getSaveWithState(roomId) {
  const row = db.prepare(`SELECT * FROM game_saves WHERE room_id = ?`).get(roomId);
  if (!row) return null;
  return { ...row, state: JSON.parse(row.state_json) };
}
