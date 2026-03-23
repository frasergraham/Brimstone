// Win / loss / draw tracking and leaderboard queries
import db from './db.js';

const _win  = db.prepare('UPDATE players SET wins   = wins   + 1 WHERE id = ?');
const _loss = db.prepare('UPDATE players SET losses = losses + 1 WHERE id = ?');
const _draw = db.prepare('UPDATE players SET draws  = draws  + 1 WHERE id = ?');

export function recordResult(playerId, result) {
  if (result === 'win')  _win.run(playerId);
  if (result === 'loss') _loss.run(playerId);
  if (result === 'draw') _draw.run(playerId);
}

export function getLeaderboard(limit = 20) {
  return db.prepare(`
    SELECT username, wins, losses, draws,
           ROUND(CAST(wins AS REAL) / MAX(wins + losses + draws, 1) * 100, 1) AS win_pct
    FROM   players
    WHERE  wins + losses + draws > 0
    ORDER  BY wins DESC, win_pct DESC
    LIMIT  ?
  `).all(limit);
}

export function getPlayerStats(playerId) {
  return db.prepare(
    'SELECT username, wins, losses, draws FROM players WHERE id = ?'
  ).get(playerId) ?? null;
}
