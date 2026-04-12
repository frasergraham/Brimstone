// Token-based player auth — no passwords, no email required.
// Supports optional email linking via magic links for cross-device access.
// All SQL lives behind server/db/*; this module is the business-logic facade.

import { randomUUID } from 'crypto';
import db from './db.js';

// Admin email allow list — players with a verified email on this list get is_admin = 1
const ADMIN_EMAILS = ['frasergraham@me.com'];

/** Generate a random 4-digit discriminator (1000–9999) that is unique for the given username. */
function _randomDiscriminator(username) {
  for (let i = 0; i < 100; i++) {
    const disc = 1000 + Math.floor(Math.random() * 9000);
    if (!db.players.getByNameDisc(username, disc)) return disc;
  }
  for (let disc = 1000; disc <= 9999; disc++) {
    if (!db.players.getByNameDisc(username, disc)) return disc;
  }
  throw new Error('Could not find unique discriminator');
}

/**
 * Authenticate an existing player (by token) or register a new one (by username).
 * Returns { ok, player } or { ok: false, error }.
 */
export function registerOrLogin({ username, token } = {}) {
  if (token) {
    const player = db.players.getByToken(token);
    if (player) return { ok: true, player };
    if (!username) {
      return { ok: false, error: 'Session expired. Please sign in again.' };
    }
  }

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
  db.players.insert({ id, username: name, discriminator: disc, token: newToken });
  const player = db.players.getById(id);
  return { ok: true, player };
}

export function getPlayerByToken(token) {
  return db.players.getByToken(token);
}

export function getPlayerById(id) {
  return db.players.getById(id);
}

// ── Auto-create by email (invite flow) ──────────────────────────────────────

/**
 * Find an existing player by linked email, or create a new account and link it.
 * Used when an invite link is clicked — the email is implicitly verified.
 */
export function getOrCreateByEmail(email) {
  const normalised = email.toLowerCase().trim();
  const existing = db.identities.get({ provider: 'email', providerId: normalised });
  if (existing) {
    const player = db.players.getById(existing.player_id);
    if (player) return { ok: true, player, isNew: false };
  }

  const name = normalised.split('@')[0].replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 16) || 'player';
  const disc = _randomDiscriminator(name);

  const id       = randomUUID();
  const newToken = randomUUID();
  db.players.insert({ id, username: name, discriminator: disc, token: newToken });
  db.identities.insert({ playerId: id, provider: 'email', providerId: normalised });
  grantAdminIfEligible(id);

  const player = db.players.getById(id);
  return { ok: true, player, isNew: true };
}

// ── Email identity linking ───────────────────────────────────────────────────

/** Link an email to an existing player account. */
export function linkEmail(playerId, email) {
  const normalised = email.toLowerCase().trim();

  const existing = db.identities.get({ provider: 'email', providerId: normalised });
  if (existing) {
    if (existing.player_id === playerId) return { ok: true };
    return { ok: false, error: 'This email is already linked to another account.' };
  }

  const player = db.players.getById(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };

  db.identities.insert({ playerId, provider: 'email', providerId: normalised });
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
  const rows = db.players.listByName(name);
  return rows.some(r => db.identities.getEmailForPlayer(r.id) != null);
}

/** Look up a player by email identity. Returns the player row or null. */
export function getPlayerByEmail(email) {
  const normalised = email.toLowerCase().trim();
  const identity = db.identities.get({ provider: 'email', providerId: normalised });
  if (!identity) return null;
  return db.players.getById(identity.player_id);
}

/** Get all linked identities for a player. */
export function getPlayerIdentities(playerId) {
  return db.identities.listForPlayer(playerId);
}

/** Log in via a verified magic link. */
export function loginByEmail(playerId) {
  const player = db.players.getById(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  return { ok: true, player };
}

// ── Admin helpers ────────────────────────────────────────────────────────────

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(email.toLowerCase().trim());
}

export function setAdmin(playerId, isAdmin) {
  db.players.setAdmin(playerId, isAdmin);
}

/**
 * Grant admin if any of the player's linked emails are on the admin allow list.
 */
export function grantAdminIfEligible(playerId) {
  const identities = db.identities.listForPlayer(playerId);
  const hasAdminEmail = identities.some(
    i => i.provider === 'email' && ADMIN_EMAILS.includes(i.provider_id)
  );
  if (hasAdminEmail) db.players.setAdmin(playerId, true);
}

// ── Game Center identity linking ────────────────────────────────────────────

/** Find or create a player by Game Center ID. */
export function getOrCreateByGameCenter(gameCenterId, displayName) {
  const existing = db.identities.get({ provider: 'gamecenter', providerId: gameCenterId });
  if (existing) {
    const player = db.players.getById(existing.player_id);
    if (!player) return { ok: false, error: 'Player not found.' };

    const name = _sanitizeUsername(displayName);
    if (name && name !== player.username) {
      db.players.updateName(player.id, name);
    }

    const updated = db.players.getById(player.id);
    return { ok: true, player: updated, isNew: false };
  }

  // New player — use GC display name directly, NULL discriminator (GC names are unique)
  const name = _sanitizeUsername(displayName) || 'player';

  const id       = randomUUID();
  const newToken = randomUUID();
  db.players.insert({ id, username: name, discriminator: null, token: newToken });
  db.identities.insert({ playerId: id, provider: 'gamecenter', providerId: gameCenterId });

  const player = db.players.getById(id);
  return { ok: true, player, isNew: true };
}

/** Link a Game Center ID to an existing player account. */
export function linkGameCenter(playerId, gameCenterId) {
  const existing = db.identities.get({ provider: 'gamecenter', providerId: gameCenterId });
  if (existing) {
    if (existing.player_id === playerId) return { ok: true };
    return { ok: false, error: 'This Game Center account is already linked to another player.' };
  }

  const player = db.players.getById(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };

  db.identities.insert({ playerId, provider: 'gamecenter', providerId: gameCenterId });
  return { ok: true };
}

/**
 * Given a list of Game Center gamePlayerIDs, return the matching Brimstone players.
 */
export function getPlayersByGameCenterIds(gamePlayerIDs) {
  if (!Array.isArray(gamePlayerIDs) || gamePlayerIDs.length === 0) return [];
  const ids = gamePlayerIDs.slice(0, 100); // cap to prevent abuse
  return db.identities.lookupGameCenterBatch(ids);
}

/** Sanitize a display name to a valid Brimstone username. */
function _sanitizeUsername(raw) {
  return (raw || '').replace(/[^a-zA-Z0-9_\- ]/g, '').trim().slice(0, 20) || '';
}

/** Change a player's username. Returns { ok, player } or { ok: false, error }. */
export function changeUsername(playerId, newUsername) {
  const name = (newUsername || '').trim();
  if (name.length < 2 || name.length > 20) {
    return { ok: false, error: 'Username must be 2–20 characters.' };
  }
  if (!/^[a-zA-Z0-9_\- ]+$/.test(name)) {
    return { ok: false, error: 'Username may only contain letters, numbers, spaces, hyphens, and underscores.' };
  }

  const player = db.players.getById(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };

  // GC accounts keep NULL discriminator — just update the name
  if (player.discriminator === null) {
    db.players.updateName(playerId, name);
  } else {
    const disc = _randomDiscriminator(name);
    db.players.updateNameAndDisc(playerId, name, disc);
  }

  const updated = db.players.getById(playerId);
  return { ok: true, player: updated };
}
