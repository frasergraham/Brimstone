// Apple Push Notification Service (APNS) integration.
// Uses @parse/node-apn to send push notifications to iOS devices.
// Falls back to console.log if APNS is not configured (same pattern as email).

import apn from '@parse/node-apn';
import db  from './db.js';

// ── Configuration ────────────────────────────────────────────────────────────

const APNS_KEY_ID      = process.env.APNS_KEY_ID      || '';
const APNS_TEAM_ID     = process.env.APNS_TEAM_ID     || '';
const APNS_KEY_PATH    = process.env.APNS_KEY_PATH     || '';
const APNS_KEY_CONTENTS = process.env.APNS_KEY_CONTENTS || ''; // base64-encoded .p8
const APNS_PRODUCTION  = process.env.APNS_PRODUCTION === 'true';
const BUNDLE_ID        = 'com.calebshollow.game';

let provider = null;

function _initProvider() {
  if (!APNS_KEY_ID || !APNS_TEAM_ID) return null;

  const opts = {
    token: {
      keyId: APNS_KEY_ID,
      teamId: APNS_TEAM_ID,
    },
    production: APNS_PRODUCTION,
  };

  if (APNS_KEY_CONTENTS) {
    opts.token.key = Buffer.from(APNS_KEY_CONTENTS, 'base64').toString('utf8');
  } else if (APNS_KEY_PATH) {
    opts.token.key = APNS_KEY_PATH; // node-apn reads file path
  } else {
    return null;
  }

  try {
    return new apn.Provider(opts);
  } catch (err) {
    console.error('[Push] Failed to initialize APNS provider:', err.message);
    return null;
  }
}

provider = _initProvider();
if (provider) {
  console.log(`[Push] APNS provider initialized (${APNS_PRODUCTION ? 'production' : 'sandbox'})`);
} else {
  console.log('[Push] APNS not configured — push notifications disabled');
}

// ── Prepared statements ─────────────────────────────────────────────────────

const _upsert = db.prepare(`
  INSERT INTO device_tokens (player_id, token, platform, updated_at)
  VALUES (?, ?, ?, unixepoch())
  ON CONFLICT (player_id, token)
  DO UPDATE SET platform = excluded.platform, updated_at = unixepoch()
`);

const _delete = db.prepare(`
  DELETE FROM device_tokens WHERE player_id = ? AND token = ?
`);

const _getTokens = db.prepare(`
  SELECT token, platform FROM device_tokens WHERE player_id = ?
`);

const _prune = db.prepare(`
  DELETE FROM device_tokens WHERE updated_at < ?
`);

// ── DB helpers (exported for REST endpoints and tests) ──────────────────────

export function upsertDeviceToken(playerId, token, platform = 'ios') {
  _upsert.run(playerId, token, platform);
}

export function deleteDeviceToken(playerId, token) {
  _delete.run(playerId, token);
}

export function getDeviceTokens(playerId) {
  return _getTokens.all(playerId);
}

/** Returns true if the player has at least one registered device token. */
export function hasDeviceTokens(playerId) {
  return _getTokens.all(playerId).length > 0;
}

/** Return all distinct player IDs that have at least one device token. */
export function getAllPlayerIdsWithTokens() {
  const rows = db.prepare('SELECT DISTINCT player_id FROM device_tokens').all();
  return rows.map(r => r.player_id);
}

export function pruneStaleTokens(maxAgeDays = 90) {
  const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);
  const result = _prune.run(cutoff);
  if (result.changes > 0) {
    console.log(`[Push] Pruned ${result.changes} stale device token(s)`);
  }
}

// ── Send push notification ──────────────────────────────────────────────────

/**
 * Send a push notification to all of a player's registered devices.
 * @param {string} playerId
 * @param {{ title: string, body: string, roomId?: string }} payload
 */
export async function sendPush(playerId, { title, body, roomId, joinCode }) {
  const tokens = _getTokens.all(playerId);
  if (tokens.length === 0) return;

  if (!provider) {
    console.log(`[Push] ${title} → ${playerId} (${tokens.length} device(s), APNS not configured)`);
    return;
  }

  const note = new apn.Notification();
  note.alert  = { title, body };
  note.sound  = 'default';
  note.topic  = BUNDLE_ID;
  if (roomId) {
    note.threadId = roomId;
    note.payload  = { roomId };
  }
  if (joinCode) {
    note.payload = { ...(note.payload || {}), joinCode };
  }

  const deviceTokens = tokens.map(t => t.token);

  console.log(`[Push] Sending "${title}" to player=${playerId} tokens=[${deviceTokens.map(t => t.slice(0, 8) + '…').join(',')}]`);

  try {
    const result = await provider.send(note, deviceTokens);
    console.log(`[Push] Result: sent=${result.sent?.length || 0} failed=${result.failed?.length || 0}`);

    // Clean up invalid tokens
    for (const failure of result.failed || []) {
      console.log(`[Push] Failure: device=${failure.device?.slice(0, 8)}… status=${failure.status} reason=${failure.response?.reason}`);
      if (failure.status === '410' || failure.response?.reason === 'BadDeviceToken' ||
          failure.response?.reason === 'Unregistered') {
        console.log(`[Push] Removing invalid token for player ${playerId}`);
        _delete.run(playerId, failure.device);
      }
    }
  } catch (err) {
    console.error('[Push] Send error:', err.message);
  }
}
