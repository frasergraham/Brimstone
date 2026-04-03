// Notifications for async games.
// Push notifications (APNS) are preferred when the player has a registered
// device. Email via Resend API is the fallback for players without devices.

import db from './db.js';
import { sendPush, hasDeviceTokens, getDeviceTokens } from './push.js';

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

function _logNotifyAttempt(fn, playerId, roomId, opts) {
  const tokens = getDeviceTokens(playerId);
  const email = _getPlayerEmail(playerId);
  console.log(`[Notify] ${fn} player=${playerId} room=${roomId} isAsync=${opts?.isAsync} devices=${tokens.length} tokens=[${tokens.map(t => t.token.slice(0, 8) + '…').join(',')}] email=${email || 'none'}`);
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

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Should we send a notification for this game?
 * Returns false if the game is not async or the player is currently connected.
 */
export function shouldNotify(roomId, playerId, { isAsync, isConnected } = {}) {
  if (!isAsync) { console.log(`[Notify] shouldNotify=false: not async`); return false; }
  if (isConnected && typeof isConnected === 'function') {
    const connected = isConnected(playerId);
    if (connected) console.log(`[Notify] shouldNotify=false: player ${playerId} is connected`);
    return !connected;
  }
  if (typeof isConnected === 'boolean') {
    if (isConnected) console.log(`[Notify] shouldNotify=false: isConnected=true`);
    return !isConnected;
  }
  return true;
}

/**
 * Notify the last unsubmitted player that everyone else has submitted.
 * "Waiting on you!"
 */
export async function notifyWaitingOnYou(playerId, gameInfo, opts) {
  _logNotifyAttempt('notifyWaitingOnYou', playerId, gameInfo.roomId, opts);
  if (!shouldNotify(gameInfo.roomId, playerId, opts)) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'waiting_on_you')) { console.log(`[Notify] dedup suppressed waiting_on_you`); return; }
  _record(gameInfo.roomId, playerId, 'waiting_on_you');

  if (hasDeviceTokens(playerId)) {
    console.log(`[Notify] sending push for waiting_on_you to player=${playerId}`);
    await sendPush(playerId, {
      title: 'Waiting on you!',
      body: "Everyone else has submitted. Your turn to plan!",
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId}, skipping`); return; }
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      "Caleb's Hollow — Waiting on you!",
      `Everyone else has submitted their plan. Your turn!\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify a player that a new round is ready (everyone submitted, resolution done).
 */
export async function notifyRoundReady(playerId, gameInfo, opts) {
  _logNotifyAttempt('notifyRoundReady', playerId, gameInfo.roomId, opts);
  if (!shouldNotify(gameInfo.roomId, playerId, opts)) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'round_ready')) { console.log(`[Notify] dedup suppressed round_ready`); return; }
  _record(gameInfo.roomId, playerId, 'round_ready');

  if (hasDeviceTokens(playerId)) {
    console.log(`[Notify] sending push for round_ready to player=${playerId}`);
    await sendPush(playerId, {
      title: `Round ${gameInfo.round} is ready`,
      body: 'Everyone submitted. A new round has begun.',
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId}, skipping`); return; }
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      `Caleb's Hollow — Round ${gameInfo.round} is ready`,
      `Everyone submitted. A new round has begun.\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify unsubmitted players that the deadline is approaching.
 * "You have ~N minutes to submit your plan!"
 */
export async function notifyDeadlineApproaching(playerId, gameInfo, opts) {
  _logNotifyAttempt('notifyDeadlineApproaching', playerId, gameInfo.roomId, opts);
  if (!shouldNotify(gameInfo.roomId, playerId, opts)) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'deadline_approaching')) { console.log(`[Notify] dedup suppressed deadline_approaching`); return; }
  _record(gameInfo.roomId, playerId, 'deadline_approaching');

  const mins = gameInfo.minutesLeft ?? 10;

  if (hasDeviceTokens(playerId)) {
    console.log(`[Notify] sending push for deadline_approaching to player=${playerId}`);
    await sendPush(playerId, {
      title: 'Deadline approaching',
      body: `You have ~${mins} minutes to submit your plan!`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId}, skipping`); return; }
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      "Caleb's Hollow — Deadline approaching",
      `You have ~${mins} minutes to submit your plan!\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify a player that the game is over.
 */
export async function notifyGameOver(playerId, gameInfo, opts) {
  _logNotifyAttempt('notifyGameOver', playerId, gameInfo.roomId, opts);
  if (!shouldNotify(gameInfo.roomId, playerId, opts)) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'game_over')) { console.log(`[Notify] dedup suppressed game_over`); return; }
  _record(gameInfo.roomId, playerId, 'game_over');

  const winnerLabel = gameInfo.winner === 'hero' ? 'The Hero' : 'The Witch';

  if (hasDeviceTokens(playerId)) {
    console.log(`[Notify] sending push for game_over to player=${playerId}`);
    await sendPush(playerId, {
      title: 'Game Over',
      body: `${winnerLabel} wins! ${gameInfo.winReason || ''}`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId}, skipping`); return; }
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
    `${gameInfo.hostName} has invited you to a game of Caleb's Hollow.\n\nClick the link below to join:\n${url}\n\nIf you don't have an account, one will be created for you automatically.`
  );
}

/**
 * Notify a player that the game was abandoned due to inactivity.
 */
export async function notifyGameAbandoned(playerId, gameInfo) {
  _logNotifyAttempt('notifyGameAbandoned', playerId, gameInfo.roomId, { isAsync: true });

  if (hasDeviceTokens(playerId)) {
    const opponent = _playerName(gameInfo.opponentId);
    console.log(`[Notify] sending push for game_abandoned to player=${playerId}`);
    await sendPush(playerId, {
      title: 'Game abandoned',
      body: `Your game against ${opponent} was abandoned due to inactivity.`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId}, skipping`); return; }
    const opponent = _playerName(gameInfo.opponentId);
    await _sendEmail(email,
      "Caleb's Hollow — Game abandoned",
      `Your async game against ${opponent} has been abandoned due to inactivity (3 consecutive rounds with no submissions from either player).`
    );
  }
}
