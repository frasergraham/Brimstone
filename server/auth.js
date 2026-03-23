// Token-based player auth — no passwords, no email
import { randomUUID } from 'crypto';
import db from './db.js';

const _getByToken = db.prepare('SELECT * FROM players WHERE token = ?');
const _getById    = db.prepare('SELECT * FROM players WHERE id = ?');
const _getByName  = db.prepare('SELECT id FROM players WHERE username = ? COLLATE NOCASE');
const _insert     = db.prepare('INSERT INTO players (id, username, token) VALUES (?, ?, ?)');

/**
 * Authenticate an existing player (by token) or register a new one (by username).
 * Returns { ok, player } or { ok: false, error }.
 */
export function registerOrLogin({ username, token } = {}) {
  // Returning player — validate their token
  if (token) {
    const player = _getByToken.get(token);
    if (player) return { ok: true, player };
  }

  // New registration
  const name = (username || '').trim();
  if (name.length < 2 || name.length > 20) {
    return { ok: false, error: 'Username must be 2–20 characters.' };
  }
  if (!/^[a-zA-Z0-9_\- ]+$/.test(name)) {
    return { ok: false, error: 'Username may only contain letters, numbers, spaces, hyphens, and underscores.' };
  }

  if (_getByName.get(name)) {
    return { ok: false, error: 'That username is already taken. Pick another or re-enter your token.' };
  }

  const id       = randomUUID();
  const newToken = randomUUID();
  _insert.run(id, name, newToken);
  const player = _getById.get(id);
  return { ok: true, player };
}

export function getPlayerByToken(token) {
  return _getByToken.get(token) ?? null;
}

export function getPlayerById(id) {
  return _getById.get(id) ?? null;
}
