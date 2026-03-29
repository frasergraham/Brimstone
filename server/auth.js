// Token-based player auth — no passwords, no email required.
// Supports optional email linking via magic links for cross-device access.
import { randomUUID } from 'crypto';
import db from './db.js';

const _getByToken = db.prepare('SELECT * FROM players WHERE token = ?');
const _getById    = db.prepare('SELECT * FROM players WHERE id = ?');
const _getByName  = db.prepare('SELECT id FROM players WHERE username = ? COLLATE NOCASE');
const _insert     = db.prepare('INSERT INTO players (id, username, token) VALUES (?, ?, ?)');

// Identity linking
const _insertIdentity = db.prepare(
  'INSERT OR IGNORE INTO player_identities (player_id, provider, provider_id) VALUES (?, ?, ?)'
);
const _getIdentity = db.prepare(
  'SELECT * FROM player_identities WHERE provider = ? AND provider_id = ?'
);
const _getIdentities = db.prepare(
  'SELECT provider, provider_id, created_at FROM player_identities WHERE player_id = ?'
);

/**
 * Authenticate an existing player (by token) or register a new one (by username).
 * Returns { ok, player } or { ok: false, error }.
 */
export function registerOrLogin({ username, token } = {}) {
  // Returning player — validate their token
  if (token) {
    const player = _getByToken.get(token);
    if (player) return { ok: true, player };
    // Token provided but not found — session expired / DB was reset
    if (!username) {
      return { ok: false, error: 'Session expired. Please sign in again.' };
    }
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

// ── Email identity linking ───────────────────────────────────────────────────

/**
 * Link an email to an existing player account.
 * Returns { ok } or { ok: false, error }.
 */
export function linkEmail(playerId, email) {
  const normalised = email.toLowerCase().trim();

  // Check if this email is already linked to another account
  const existing = _getIdentity.get('email', normalised);
  if (existing) {
    if (existing.player_id === playerId) {
      return { ok: true }; // already linked to this player
    }
    return { ok: false, error: 'This email is already linked to another account.' };
  }

  const player = _getById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };

  _insertIdentity.run(playerId, 'email', normalised);
  return { ok: true };
}

/**
 * Look up a player by email identity. Returns the player row or null.
 */
export function getPlayerByEmail(email) {
  const normalised = email.toLowerCase().trim();
  const identity = _getIdentity.get('email', normalised);
  if (!identity) return null;
  return _getById.get(identity.player_id) ?? null;
}

/**
 * Get all linked identities for a player.
 * Returns array of { provider, provider_id, created_at }.
 */
export function getPlayerIdentities(playerId) {
  return _getIdentities.all(playerId);
}

/**
 * Log in via a verified magic link. Generates a fresh session token for the player.
 * Returns { ok, player } or { ok: false, error }.
 */
export function loginByEmail(playerId) {
  const player = _getById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  return { ok: true, player };
}

/**
 * Change a player's username. Returns { ok, player } or { ok: false, error }.
 */
const _updateUsername = db.prepare('UPDATE players SET username = ? WHERE id = ?');

export function changeUsername(playerId, newUsername) {
  const name = (newUsername || '').trim();
  if (name.length < 2 || name.length > 20) {
    return { ok: false, error: 'Username must be 2–20 characters.' };
  }
  if (!/^[a-zA-Z0-9_\- ]+$/.test(name)) {
    return { ok: false, error: 'Username may only contain letters, numbers, spaces, hyphens, and underscores.' };
  }

  const existing = _getByName.get(name);
  if (existing && existing.id !== playerId) {
    return { ok: false, error: 'That username is already taken.' };
  }

  _updateUsername.run(name, playerId);
  const player = _getById.get(playerId);
  return { ok: true, player };
}
