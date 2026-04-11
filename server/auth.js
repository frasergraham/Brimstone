// Token-based player auth — no passwords, no email required.
// Supports optional email linking via magic links for cross-device access.
import { randomUUID } from 'crypto';
import db from './db.js';

// Admin email allow list — players with a verified email on this list get is_admin = 1
const ADMIN_EMAILS = ['frasergraham@me.com'];

const _getByToken = db.prepare('SELECT * FROM players WHERE token = ?');
const _getById    = db.prepare('SELECT * FROM players WHERE id = ?');
const _getByNameDisc = db.prepare('SELECT id FROM players WHERE username = ? COLLATE NOCASE AND discriminator = ?');
const _getAllByName = db.prepare('SELECT id FROM players WHERE username = ? COLLATE NOCASE');
const _hasEmailForPlayer = db.prepare(
  "SELECT 1 FROM player_identities WHERE player_id = ? AND provider = 'email' LIMIT 1"
);
const _insert     = db.prepare('INSERT INTO players (id, username, discriminator, token) VALUES (?, ?, ?, ?)');

/** Generate a random 4-digit discriminator (1000–9999) that is unique for the given username. */
function _randomDiscriminator(username) {
  for (let i = 0; i < 100; i++) {
    const disc = 1000 + Math.floor(Math.random() * 9000);
    if (!_getByNameDisc.get(username, disc)) return disc;
  }
  // Extremely unlikely fallback — try sequential
  for (let disc = 1000; disc <= 9999; disc++) {
    if (!_getByNameDisc.get(username, disc)) return disc;
  }
  throw new Error('Could not find unique discriminator');
}
const _setAdmin   = db.prepare('UPDATE players SET is_admin = ? WHERE id = ?');

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

  // Block username reuse when an existing account with this name has a linked
  // email identity — the real owner must sign in via email rather than let a
  // stranger squat on their display name.
  if (isUsernameLinkedToEmail(name)) {
    return {
      ok: false,
      err_code: 'username_linked',
      error: 'This username is linked to an email. Please sign in with email instead.',
    };
  }

  const disc     = _randomDiscriminator(name);
  const id       = randomUUID();
  const newToken = randomUUID();
  _insert.run(id, name, disc, newToken);
  const player = _getById.get(id);
  return { ok: true, player };
}

export function getPlayerByToken(token) {
  return _getByToken.get(token) ?? null;
}

export function getPlayerById(id) {
  return _getById.get(id) ?? null;
}

// ── Auto-create by email (invite flow) ──────────────────────────────────────

/**
 * Find an existing player by linked email, or create a new account and link it.
 * Used when an invite link is clicked — the email is implicitly verified.
 * Returns { ok, player, isNew } or { ok: false, error }.
 */
export function getOrCreateByEmail(email) {
  const normalised = email.toLowerCase().trim();
  const existing = _getIdentity.get('email', normalised);
  if (existing) {
    const player = _getById.get(existing.player_id);
    if (player) return { ok: true, player, isNew: false };
  }

  // Derive a username from the email prefix — discriminator handles uniqueness
  const name = normalised.split('@')[0].replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 16) || 'player';
  const disc = _randomDiscriminator(name);

  const id       = randomUUID();
  const newToken = randomUUID();
  _insert.run(id, name, disc, newToken);
  _insertIdentity.run(id, 'email', normalised);
  grantAdminIfEligible(id);

  const player = _getById.get(id);
  return { ok: true, player, isNew: true };
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
  grantAdminIfEligible(playerId);
  return { ok: true };
}

/**
 * Return true if any existing player with this exact username (case-insensitive)
 * has a linked email identity. Used by registerOrLogin to block squatters.
 */
export function isUsernameLinkedToEmail(username) {
  const name = (username || '').trim();
  if (!name) return false;
  const rows = _getAllByName.all(name);
  return rows.some(r => !!_hasEmailForPlayer.get(r.id));
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

// ── Admin helpers ────────────────────────────────────────────────────────────

/** Check if an email is on the admin allow list. */
export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(email.toLowerCase().trim());
}

/**
 * Explicitly set admin status for a player.
 * Used by admin panel to grant/revoke admin on other players.
 */
export function setAdmin(playerId, isAdmin) {
  _setAdmin.run(isAdmin ? 1 : 0, playerId);
}

/**
 * Grant admin if any of the player's linked emails are on the admin allow list.
 * Called after email linking to auto-promote eligible players.
 */
export function grantAdminIfEligible(playerId) {
  const identities = _getIdentities.all(playerId);
  const hasAdminEmail = identities.some(
    i => i.provider === 'email' && ADMIN_EMAILS.includes(i.provider_id)
  );
  if (hasAdminEmail) {
    _setAdmin.run(1, playerId);
  }
}

// ── Game Center identity linking ────────────────────────────────────────────

/**
 * Find an existing player by Game Center ID, or create a new account and link it.
 * On returning logins, syncs the display name to the player's username.
 * Returns { ok, player, isNew } or { ok: false, error }.
 */
export function getOrCreateByGameCenter(gameCenterId, displayName) {
  const existing = _getIdentity.get('gamecenter', gameCenterId);
  if (existing) {
    const player = _getById.get(existing.player_id);
    if (!player) return { ok: false, error: 'Player not found.' };

    // Sync display name on every login — no collision risk with NULL discriminator
    const name = _sanitizeUsername(displayName);
    if (name && name !== player.username) {
      _updateUsername.run(name, player.id);
    }

    const updated = _getById.get(player.id);
    return { ok: true, player: updated, isNew: false };
  }

  // New player — use GC display name directly, NULL discriminator (GC names are unique)
  const name = _sanitizeUsername(displayName) || 'player';

  const id       = randomUUID();
  const newToken = randomUUID();
  _insert.run(id, name, null, newToken);
  _insertIdentity.run(id, 'gamecenter', gameCenterId);

  const player = _getById.get(id);
  return { ok: true, player, isNew: true };
}

/**
 * Link a Game Center ID to an existing player account.
 * Returns { ok } or { ok: false, error }.
 */
export function linkGameCenter(playerId, gameCenterId) {
  const existing = _getIdentity.get('gamecenter', gameCenterId);
  if (existing) {
    if (existing.player_id === playerId) return { ok: true };
    return { ok: false, error: 'This Game Center account is already linked to another player.' };
  }

  const player = _getById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };

  _insertIdentity.run(playerId, 'gamecenter', gameCenterId);
  return { ok: true };
}

/**
 * Given a list of Game Center gamePlayerIDs, return the matching Brimstone
 * players (i.e. GC friends who also have the game and an account).
 * Returns [{ gamePlayerID, playerId, username }].
 */
export function getPlayersByGameCenterIds(gamePlayerIDs) {
  if (!Array.isArray(gamePlayerIDs) || gamePlayerIDs.length === 0) return [];
  const ids = gamePlayerIDs.slice(0, 100); // cap to prevent abuse
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT pi.provider_id AS gamePlayerID, p.id AS playerId, p.username
    FROM player_identities pi
    JOIN players p ON p.id = pi.player_id
    WHERE pi.provider = 'gamecenter' AND pi.provider_id IN (${placeholders})
  `).all(...ids);
}

/** Sanitize a display name to a valid Brimstone username. */
function _sanitizeUsername(raw) {
  return (raw || '').replace(/[^a-zA-Z0-9_\- ]/g, '').trim().slice(0, 20) || '';
}

/**
 * Change a player's username. Returns { ok, player } or { ok: false, error }.
 * Assigns a new random discriminator for the new name.
 */
const _updateUsername     = db.prepare('UPDATE players SET username = ? WHERE id = ?');
const _updateUsernameDisc = db.prepare('UPDATE players SET username = ?, discriminator = ? WHERE id = ?');

export function changeUsername(playerId, newUsername) {
  const name = (newUsername || '').trim();
  if (name.length < 2 || name.length > 20) {
    return { ok: false, error: 'Username must be 2–20 characters.' };
  }
  if (!/^[a-zA-Z0-9_\- ]+$/.test(name)) {
    return { ok: false, error: 'Username may only contain letters, numbers, spaces, hyphens, and underscores.' };
  }

  const player = _getById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };

  // GC accounts keep NULL discriminator — just update the name
  if (player.discriminator === null) {
    _updateUsername.run(name, playerId);
  } else {
    const disc = _randomDiscriminator(name);
    _updateUsernameDisc.run(name, disc, playerId);
  }

  const updated = _getById.get(playerId);
  return { ok: true, player: updated };
}
