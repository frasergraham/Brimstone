// Players domain — Postgres implementation.
import { query, runMutation } from './client.js';

export const players = {
  getByToken(token) {
    return query('SELECT * FROM players WHERE token = $1', [token])[0] ?? null;
  },
  getById(id) {
    return query('SELECT * FROM players WHERE id = $1', [id])[0] ?? null;
  },
  getByNameDisc(username, disc) {
    return query(
      'SELECT id FROM players WHERE username = $1 AND discriminator = $2',
      [username, disc]
    )[0] ?? null;
  },
  listByName(username) {
    return query('SELECT id FROM players WHERE username = $1', [username]);
  },
  insert({ id, username, discriminator, token }) {
    runMutation(
      'INSERT INTO players (id, username, discriminator, token) VALUES ($1, $2, $3, $4)',
      [id, username, discriminator, token]
    );
  },
  setAdmin(id, isAdmin) {
    runMutation('UPDATE players SET is_admin = $1 WHERE id = $2', [isAdmin ? 1 : 0, id]);
  },
  updateName(id, username) {
    runMutation('UPDATE players SET username = $1 WHERE id = $2', [username, id]);
  },
  updateNameAndDisc(id, username, disc) {
    runMutation(
      'UPDATE players SET username = $1, discriminator = $2 WHERE id = $3',
      [username, disc, id]
    );
  },
  incrementWin(id) {
    runMutation('UPDATE players SET wins   = wins   + 1 WHERE id = $1', [id]);
  },
  incrementLoss(id) {
    runMutation('UPDATE players SET losses = losses + 1 WHERE id = $1', [id]);
  },
  incrementDraw(id) {
    runMutation('UPDATE players SET draws  = draws  + 1 WHERE id = $1', [id]);
  },
  leaderboard(limit) {
    return query(`
      SELECT username, wins, losses, draws,
             ROUND((wins::numeric / GREATEST(wins + losses + draws, 1)) * 100, 1) AS win_pct
      FROM   players
      WHERE  wins + losses + draws > 0
      ORDER  BY wins DESC, win_pct DESC
      LIMIT  $1
    `, [limit]);
  },
  getStats(id) {
    return query(
      'SELECT username, wins, losses, draws FROM players WHERE id = $1',
      [id]
    )[0] ?? null;
  },
  listTop(limit) {
    return query(`
      SELECT id, username, wins, losses, draws, created_at,
             ROUND((wins::numeric / GREATEST(wins + losses + draws, 1)) * 100, 1) AS win_pct
      FROM   players
      ORDER  BY wins DESC, created_at DESC
      LIMIT  $1
    `, [limit]);
  },
  listDetailed() {
    return query(`
      SELECT p.id, p.username, p.discriminator, p.token, p.wins, p.losses, p.draws,
             p.is_admin, p.created_at,
             ROUND((p.wins::numeric / GREATEST(p.wins + p.losses + p.draws, 1)) * 100, 1) AS win_pct
      FROM   players p
      ORDER  BY p.created_at DESC
    `);
  },
};
