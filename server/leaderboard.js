// Win / loss / draw tracking and leaderboard queries.
// Thin facade over db.players.
import db from './db.js';

export function recordResult(playerId, result) {
  if (result === 'win')  db.players.incrementWin(playerId);
  if (result === 'loss') db.players.incrementLoss(playerId);
  if (result === 'draw') db.players.incrementDraw(playerId);
}

export function getLeaderboard(limit = 20) {
  return db.players.leaderboard(limit);
}

export function getPlayerStats(playerId) {
  return db.players.getStats(playerId);
}
