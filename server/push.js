// Apple Push Notification Service (APNS) integration.
// Uses @parse/node-apn to send push notifications to iOS devices.
// Falls back to console.log if APNS is not configured.
// DB access is delegated to db.deviceTokens.

import apn from '@parse/node-apn';
import db  from './db.js';

// ── Configuration ────────────────────────────────────────────────────────────

const APNS_KEY_ID       = process.env.APNS_KEY_ID       || '';
const APNS_TEAM_ID      = process.env.APNS_TEAM_ID      || '';
const APNS_KEY_PATH     = process.env.APNS_KEY_PATH     || '';
const APNS_KEY_CONTENTS = process.env.APNS_KEY_CONTENTS || ''; // base64-encoded .p8
const APNS_PRODUCTION   = process.env.APNS_PRODUCTION === 'true';
const BUNDLE_ID         = 'com.calebshollow.game';

let provider = null;

function _initProvider() {
  if (!APNS_KEY_ID || !APNS_TEAM_ID) return null;

  const opts = {
    token: { keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID },
    production: APNS_PRODUCTION,
  };

  if (APNS_KEY_CONTENTS) {
    opts.token.key = Buffer.from(APNS_KEY_CONTENTS, 'base64').toString('utf8');
  } else if (APNS_KEY_PATH) {
    opts.token.key = APNS_KEY_PATH;
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

// ── DB helpers (exported for REST endpoints and tests) ──────────────────────

export function upsertDeviceToken(playerId, token, platform = 'ios') {
  db.deviceTokens.upsert({ playerId, token, platform });
}

export function deleteDeviceToken(playerId, token) {
  db.deviceTokens.delete(playerId, token);
}

export function getDeviceTokens(playerId) {
  return db.deviceTokens.listForPlayer(playerId);
}

/** Returns true if the player has at least one registered device token. */
export function hasDeviceTokens(playerId) {
  return db.deviceTokens.listForPlayer(playerId).length > 0;
}

/** Return all distinct player IDs that have at least one device token. */
export function getAllPlayerIdsWithTokens() {
  return db.deviceTokens.listDistinctPlayers();
}

export function pruneStaleTokens(maxAgeDays = 90) {
  const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);
  const changes = db.deviceTokens.prune(cutoff);
  if (changes > 0) {
    console.log(`[Push] Pruned ${changes} stale device token(s)`);
  }
}

// ── Send push notification ──────────────────────────────────────────────────

/**
 * Send a push notification to all of a player's registered devices.
 */
export async function sendPush(playerId, { title, body, roomId, joinCode }) {
  const tokens = db.deviceTokens.listForPlayer(playerId);
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

    for (const failure of result.failed || []) {
      console.log(`[Push] Failure: device=${failure.device?.slice(0, 8)}… status=${failure.status} reason=${failure.response?.reason}`);
      if (failure.status === '410' || failure.response?.reason === 'BadDeviceToken' ||
          failure.response?.reason === 'Unregistered') {
        console.log(`[Push] Removing invalid token for player ${playerId}`);
        db.deviceTokens.delete(playerId, failure.device);
      }
    }
  } catch (err) {
    console.error('[Push] Send error:', err.message);
  }
}
