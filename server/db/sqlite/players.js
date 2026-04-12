// Players domain — CRUD + leaderboard queries.
import { prepare } from './client.js';

const _getByToken = prepare('SELECT * FROM players WHERE token = ?');
const _getById    = prepare('SELECT * FROM players WHERE id = ?');
const _getByNameDisc = prepare(
  'SELECT id FROM players WHERE username = ? COLLATE NOCASE AND discriminator = ?'
);
const _listByName = prepare(
  'SELECT id FROM players WHERE username = ? COLLATE NOCASE'
);
const _insert = prepare(
  'INSERT INTO players (id, username, discriminator, token) VALUES (?, ?, ?, ?)'
);
const _setAdmin = prepare('UPDATE players SET is_admin = ? WHERE id = ?');

const _updateName     = prepare('UPDATE players SET username = ? WHERE id = ?');
const _updateNameDisc = prepare('UPDATE players SET username = ?, discriminator = ? WHERE id = ?');

const _incWin  = prepare('UPDATE players SET wins   = wins   + 1 WHERE id = ?');
const _incLoss = prepare('UPDATE players SET losses = losses + 1 WHERE id = ?');
const _incDraw = prepare('UPDATE players SET draws  = draws  + 1 WHERE id = ?');

const _leaderboard = prepare(`
  SELECT username, wins, losses, draws,
         ROUND(CAST(wins AS REAL) / MAX(wins + losses + draws, 1) * 100, 1) AS win_pct
  FROM   players
  WHERE  wins + losses + draws > 0
  ORDER  BY wins DESC, win_pct DESC
  LIMIT  ?
`);

const _getStats = prepare(
  'SELECT username, wins, losses, draws FROM players WHERE id = ?'
);

const _listTop = prepare(`
  SELECT id, username, wins, losses, draws, created_at,
         ROUND(CAST(wins AS REAL) / MAX(wins + losses + draws, 1) * 100, 1) AS win_pct
  FROM   players
  ORDER  BY wins DESC, created_at DESC
  LIMIT  ?
`);

const _listDetailed = prepare(`
  SELECT p.id, p.username, p.discriminator, p.token, p.wins, p.losses, p.draws,
         p.is_admin, p.created_at,
         ROUND(CAST(p.wins AS REAL) / MAX(p.wins + p.losses + p.draws, 1) * 100, 1) AS win_pct
  FROM   players p
  ORDER  BY p.created_at DESC
`);

export const players = {
  getByToken(token)                 { return _getByToken.get(token) ?? null; },
  getById(id)                       { return _getById.get(id) ?? null; },
  getByNameDisc(username, disc)     { return _getByNameDisc.get(username, disc) ?? null; },
  listByName(username)              { return _listByName.all(username); },
  insert({ id, username, discriminator, token }) {
    _insert.run(id, username, discriminator, token);
  },
  setAdmin(id, isAdmin)             { _setAdmin.run(isAdmin ? 1 : 0, id); },
  updateName(id, username)          { _updateName.run(username, id); },
  updateNameAndDisc(id, username, disc) { _updateNameDisc.run(username, disc, id); },
  incrementWin(id)                  { _incWin.run(id); },
  incrementLoss(id)                 { _incLoss.run(id); },
  incrementDraw(id)                 { _incDraw.run(id); },
  leaderboard(limit)                { return _leaderboard.all(limit); },
  getStats(id)                      { return _getStats.get(id) ?? null; },
  listTop(limit)                    { return _listTop.all(limit); },
  listDetailed()                    { return _listDetailed.all(); },
};
