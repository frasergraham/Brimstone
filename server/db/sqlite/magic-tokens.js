// Magic link tokens domain.
import { prepare } from './client.js';

const _insert = prepare(
  'INSERT INTO magic_tokens (token, email, player_id, expires_at) VALUES (?, ?, ?, ?)'
);
const _getUnused = prepare(
  'SELECT * FROM magic_tokens WHERE token = ? AND used = 0'
);
const _markUsed = prepare(
  'UPDATE magic_tokens SET used = 1 WHERE token = ?'
);
const _prune = prepare(
  'DELETE FROM magic_tokens WHERE expires_at < ? OR used = 1'
);

export const magicTokens = {
  create({ token, email, playerId, expiresAt }) {
    _insert.run(token, email, playerId, expiresAt);
  },
  getUnused(token) {
    return _getUnused.get(token) ?? null;
  },
  markUsed(token) {
    _markUsed.run(token);
  },
  prune(nowMs) {
    _prune.run(nowMs);
  },
};
