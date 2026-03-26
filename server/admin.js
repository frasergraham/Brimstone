// Admin API helpers — protected by ADMIN_KEY environment variable.
// Set ADMIN_KEY in your environment to enable the admin panel.
// Leave unset to disable all admin endpoints.
import db from './db.js';

export const ADMIN_KEY = process.env.ADMIN_KEY ?? null;

/** Returns true when the supplied key matches the configured ADMIN_KEY. */
export function isValidAdminKey(key) {
  return ADMIN_KEY !== null && typeof key === 'string' && key === ADMIN_KEY;
}

/**
 * Express middleware helper — call at the top of each admin route handler.
 * Writes the 401/403 response and returns false when auth fails;
 * returns true when the caller may proceed.
 */
export function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(403).json({ error: 'Admin panel disabled (ADMIN_KEY not configured).' });
    return false;
  }
  const key = req.query.key || req.headers['x-admin-key'];
  if (!isValidAdminKey(key)) {
    res.status(401).json({ error: 'Invalid admin key.' });
    return false;
  }
  return true;
}

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
