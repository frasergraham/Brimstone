// Notifications for async games.
// Push notifications (APNS) are preferred when the player has a registered
// device. Email via Resend API is the fallback for players without devices.

import db from './db.js';
import { sendPush, hasDeviceTokens } from './push.js';

// ── Configuration ────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM     = process.env.EMAIL_FROM || "Caleb's Hollow <noreply@calebshollow.com>";
const DEDUP_WINDOW_S = 3600; // 1 hour — don't resend same notification type

function _baseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

// ── Prepared statements ─────────────────────────────────────────────────────

const _getEmail = db.prepare(`
  SELECT provider_id FROM player_identities
  WHERE  player_id = ? AND provider = 'email'
  LIMIT  1
`);

const _recentNotif = db.prepare(`
  SELECT 1 FROM async_notifications
  WHERE  room_id = ? AND player_id = ? AND type = ? AND sent_at > ?
  LIMIT  1
`);

const _insertNotif = db.prepare(`
  INSERT INTO async_notifications (room_id, player_id, type)
  VALUES (?, ?, ?)
`);

const _getUsername = db.prepare(`SELECT username FROM players WHERE id = ?`);

// ── Helpers ─────────────────────────────────────────────────────────────────

function _getPlayerEmail(playerId) {
  const row = _getEmail.get(playerId);
  return row ? row.provider_id : null;
}

function _shouldSend(roomId, playerId, type) {
  const cutoff = Math.floor(Date.now() / 1000) - DEDUP_WINDOW_S;
  return !_recentNotif.get(roomId, playerId, type, cutoff);
}

function _record(roomId, playerId, type) {
  _insertNotif.run(roomId, playerId, type);
}

async function _sendEmail(to, subject, body) {
  if (!RESEND_API_KEY) {
    console.log(`[Notify] ${subject} → ${to}`);
    console.log(`  ${body.split('\n')[0]}`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text: body }),
    });
    if (!res.ok) {
      console.error('[Notify] Resend error:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[Notify] Send error:', err.message);
  }
}

function _playerName(playerId) {
  const row = _getUsername.get(playerId);
  return row?.username ?? 'your opponent';
}

// ── Constants ───────────────────────────────────────────────────────────────

// Only send notifications for games with turn timeout >= 1 hour
const NOTIFY_MIN_INTERVAL_MS = 3_600_000;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a player has an active WebSocket connection.
 * Supports both the legacy asyncSessions Map and the unified room system.
 * @param {Map|null} asyncSessions - legacy async sessions map
 * @param {string} roomId
 * @param {string} playerId
 * @param {object} [opts] - extra options from unified system
 * @param {Function} [opts.isConnected] - (playerId) => boolean check from lobby room
 */
function _isOnline(asyncSessions, roomId, playerId, opts) {
  // Unified room check (takes precedence)
  if (opts?.isConnected) return opts.isConnected(playerId);
  // Legacy asyncSessions check
  const room = asyncSessions?.get(roomId);
  if (!room) return false;
  const ws = room.get(playerId);
  return ws && ws.readyState === 1; // WebSocket.OPEN
}

/**
 * Should we send a notification for this game?
 * Returns false if the player is connected or the game's timeout is too short.
 */
export function shouldNotify(roomId, playerId, { asyncSessions, turnIntervalMs, isConnected } = {}) {
  if (turnIntervalMs != null && turnIntervalMs < NOTIFY_MIN_INTERVAL_MS) return false;
  return !_isOnline(asyncSessions, roomId, playerId, { isConnected });
}

/**
 * Notify a player that their opponent has joined and round 1 is ready.
 * @param {object} [opts] - { turnIntervalMs, isConnected } for unified system
 */
export async function notifyOpponentJoined(playerId, gameInfo, asyncSessions, opts) {
  if (!shouldNotify(gameInfo.roomId, playerId, { asyncSessions, ...opts })) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'opponent_joined')) return;
  _record(gameInfo.roomId, playerId, 'opponent_joined');

  const opponent = _playerName(gameInfo.opponentId);

  if (hasDeviceTokens(playerId)) {
    await sendPush(playerId, {
      title: 'Your opponent has joined!',
      body: `${opponent} has joined your game. Round 1 is ready.`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) return;
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      "Caleb's Hollow — Your opponent has joined!",
      `${opponent} has joined your game. Round 1 is ready.\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify a player that a new round is ready (after resolution).
 * @param {object} [opts] - { turnIntervalMs, isConnected } for unified system
 */
export async function notifyTurnReady(playerId, gameInfo, asyncSessions, opts) {
  if (!shouldNotify(gameInfo.roomId, playerId, { asyncSessions, ...opts })) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'turn_ready')) return;
  _record(gameInfo.roomId, playerId, 'turn_ready');

  const opponent = _playerName(gameInfo.opponentId);

  if (hasDeviceTokens(playerId)) {
    await sendPush(playerId, {
      title: `Round ${gameInfo.round} is ready`,
      body: `Your game against ${opponent} has a new round.`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) return;
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      `Caleb's Hollow — Round ${gameInfo.round} is ready`,
      `A new round has begun in your game against ${opponent}.\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify a player that their opponent submitted a plan (nudge).
 * @param {object} [opts] - { turnIntervalMs, isConnected } for unified system
 */
export async function notifyOpponentSubmitted(playerId, gameInfo, asyncSessions, opts) {
  if (!shouldNotify(gameInfo.roomId, playerId, { asyncSessions, ...opts })) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'opponent_submitted')) return;
  _record(gameInfo.roomId, playerId, 'opponent_submitted');

  const opponent = _playerName(gameInfo.opponentId);

  if (hasDeviceTokens(playerId)) {
    await sendPush(playerId, {
      title: 'Your move!',
      body: `${opponent} has submitted their plan. Waiting on you!`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) return;
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      "Caleb's Hollow — Your opponent submitted their turn",
      `${opponent} has submitted their plan. Waiting on you!\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify a player that the game is over.
 * @param {object} [opts] - { turnIntervalMs, isConnected } for unified system
 */
export async function notifyGameOver(playerId, gameInfo, asyncSessions, opts) {
  if (!shouldNotify(gameInfo.roomId, playerId, { asyncSessions, ...opts })) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'game_over')) return;
  _record(gameInfo.roomId, playerId, 'game_over');

  const winnerLabel = gameInfo.winner === 'hero' ? 'The Hero' : 'The Witch';

  if (hasDeviceTokens(playerId)) {
    await sendPush(playerId, {
      title: 'Game Over',
      body: `${winnerLabel} wins! ${gameInfo.winReason || ''}`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) return;
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      "Caleb's Hollow — Game Over",
      `${winnerLabel} wins! ${gameInfo.winReason || ''}\n\nView the result: ${url}`
    );
  }
}

/**
 * Send a game invite to an email address. No dedup — sent once at creation.
 * The invite link auto-creates an account if the recipient doesn't have one.
 */
export async function sendGameInvite(email, gameInfo) {
  const url = `${_baseUrl()}/invite?code=${encodeURIComponent(gameInfo.code)}`;
  await _sendEmail(email,
    `Caleb's Hollow — ${gameInfo.hostName} has challenged you!`,
    `${gameInfo.hostName} has invited you to an async game of Caleb's Hollow.\n\nClick the link below to join:\n${url}\n\nIf you don't have an account, one will be created for you automatically.`
  );
}

/**
 * Notify a player that the game was abandoned due to inactivity.
 */
export async function notifyGameAbandoned(playerId, gameInfo) {
  const opponent = _playerName(gameInfo.opponentId);

  if (hasDeviceTokens(playerId)) {
    await sendPush(playerId, {
      title: 'Game abandoned',
      body: `Your game against ${opponent} was abandoned due to inactivity.`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) return;
    await _sendEmail(email,
      "Caleb's Hollow — Game abandoned",
      `Your async game against ${opponent} has been abandoned due to inactivity (3 consecutive rounds with no submissions from either player).`
    );
  }
}
