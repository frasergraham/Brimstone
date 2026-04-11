// Notifications for async games.
// Push notifications (APNS) are preferred when the player has a registered
// device. Email via Resend API is the fallback for players without devices.

import db from './db.js';
import { sendPush, hasDeviceTokens, getDeviceTokens } from './push.js';

// ── Configuration ────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM     = process.env.EMAIL_FROM || "Caleb's Hollow <noreply@calebshollow.com>";
const DEDUP_WINDOW_S = 10; // 10 seconds — default for most notification types

// Per-type dedup windows.  Deadline notifications are checked every 60s by
// checkApproachingDeadlines(), so the window must be at least as wide as the
// approach query window to avoid sending a push every poll cycle.
export const DEDUP_WINDOWS = Object.freeze({
  default:              DEDUP_WINDOW_S,
  deadline_approaching: 600,   // 10 minutes — matches standard approach window
  battle_deadline:      3600,  // 60 minutes — matches battle approach window
});

function _baseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _getPlayerEmail(playerId) {
  return db.identities.getEmailForPlayer(playerId);
}

function _shouldSend(roomId, playerId, type) {
  const windowS = DEDUP_WINDOWS[type] ?? DEDUP_WINDOWS.default;
  const sinceUnixSeconds = Math.floor(Date.now() / 1000) - windowS;
  return !db.notifications.hasRecent({ roomId, playerId, type, sinceUnixSeconds });
}

function _record(roomId, playerId, type) {
  db.notifications.record({ roomId, playerId, type });
}

function _logNotifyAttempt(fn, playerId, roomId, opts) {
  const tokens = getDeviceTokens(playerId);
  const email = _getPlayerEmail(playerId);
  const tag = _playerTag(playerId);
  console.log(`[Notify] ${fn} player=${playerId} name=${tag} room=${roomId} isAsync=${opts?.isAsync} devices=${tokens.length} tokens=[${tokens.map(t => t.token.slice(0, 8) + '…').join(',')}] email=${email || 'none'}`);
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

function _playerTag(playerId) {
  const row = db.players.getById(playerId);
  const name = row?.username ?? 'unknown';
  const isGC = db.identities.hasGameCenter(playerId);
  return `${name}${isGC ? ' (GC)' : ''}`;
}

function _playerName(playerId) {
  const row = db.players.getById(playerId);
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
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId} name=${_playerTag(playerId)}, skipping`); return; }
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      "Caleb's Hollow — Waiting on you!",
      `Everyone else has submitted their plan. Your turn!\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify a player that a new round is ready (everyone submitted, resolution done).
 * gameInfo may include `wasIdle` (boolean) and `idleFaction` (string) — when the
 * player's previous turn was auto-submitted empty due to timeout, the notification
 * calls that out explicitly.
 */
export async function notifyRoundReady(playerId, gameInfo, opts) {
  _logNotifyAttempt('notifyRoundReady', playerId, gameInfo.roomId, opts);
  if (!shouldNotify(gameInfo.roomId, playerId, opts)) return;
  if (!_shouldSend(gameInfo.roomId, playerId, 'round_ready')) { console.log(`[Notify] dedup suppressed round_ready`); return; }
  _record(gameInfo.roomId, playerId, 'round_ready');

  const { round, wasIdle, idleFaction } = gameInfo;
  const idleRound = round - 1;
  const body = wasIdle && idleFaction
    ? `Your ${idleFaction} was idle in round ${idleRound}. Round ${round} is ready — don't miss this one!`
    : 'Everyone submitted. A new round has begun.';

  if (hasDeviceTokens(playerId)) {
    console.log(`[Notify] sending push for round_ready to player=${playerId}`);
    await sendPush(playerId, {
      title: `Round ${round} is ready`,
      body,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId} name=${_playerTag(playerId)}, skipping`); return; }
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      `Caleb's Hollow — Round ${round} is ready`,
      `${body}\n\nPlay your turn: ${url}`
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
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId} name=${_playerTag(playerId)}, skipping`); return; }
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
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId} name=${_playerTag(playerId)}, skipping`); return; }
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
 * Notify a player that another player nudged them to take their turn.
 * Uses 'nudge' notification type for dedup.
 */
export async function notifyNudge(playerId, gameInfo, opts) {
  _logNotifyAttempt('notifyNudge', playerId, gameInfo.roomId, opts);
  if (!_shouldSend(gameInfo.roomId, playerId, 'nudge')) { console.log(`[Notify] dedup suppressed nudge`); return; }
  _record(gameInfo.roomId, playerId, 'nudge');

  const from = gameInfo.fromName ?? 'A teammate';

  if (hasDeviceTokens(playerId)) {
    console.log(`[Notify] sending push for nudge to player=${playerId}`);
    await sendPush(playerId, {
      title: `${from} nudged you`,
      body: "It's your turn to plan!",
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId} name=${_playerTag(playerId)}, skipping`); return; }
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      `Caleb's Hollow — ${from} nudged you!`,
      `${from} is waiting for you to submit your plan.\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify a player in a Battle that the daily deadline is approaching.
 * Uses 'battle_deadline' notification type for dedup.
 */
export async function notifyBattleDeadlineApproaching(playerId, gameInfo, opts) {
  _logNotifyAttempt('notifyBattleDeadlineApproaching', playerId, gameInfo.roomId, opts);
  if (!_shouldSend(gameInfo.roomId, playerId, 'battle_deadline')) return;
  _record(gameInfo.roomId, playerId, 'battle_deadline');

  const mins = gameInfo.minutesLeft ?? 60;

  if (hasDeviceTokens(playerId)) {
    await sendPush(playerId, {
      title: 'Battle deadline approaching',
      body: `You have ~${mins} minutes to submit your plan for The Battle for Caleb's Hollow!`,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) return;
    const url = `${_baseUrl()}/#game=${gameInfo.roomId}`;
    await _sendEmail(email,
      "Caleb's Hollow — Battle deadline approaching",
      `You have ~${mins} minutes to submit your plan for The Battle for Caleb's Hollow!\n\nPlay your turn: ${url}`
    );
  }
}

/**
 * Notify a player that The Battle for Caleb's Hollow has ended.
 * Uses 'battle_ended' notification type for dedup.
 */
export async function notifyBattleEnded(playerId, gameInfo) {
  _logNotifyAttempt('notifyBattleEnded', playerId, gameInfo.roomId, { isAsync: true });
  if (!_shouldSend(gameInfo.roomId, playerId, 'battle_ended')) return;
  _record(gameInfo.roomId, playerId, 'battle_ended');

  const winner = gameInfo.winner === 'hero' ? 'Heroes' : gameInfo.winner === 'witch' ? 'Witches' : 'Neither side';
  const body = gameInfo.winner === 'draw'
    ? `The Battle for Caleb's Hollow ended in a draw! ${gameInfo.heroScore}–${gameInfo.witchScore}`
    : `${winner} win The Battle for Caleb's Hollow! ${gameInfo.heroScore}–${gameInfo.witchScore}`;

  if (hasDeviceTokens(playerId)) {
    await sendPush(playerId, {
      title: 'The Battle has ended!',
      body,
      roomId: gameInfo.roomId,
    });
  } else {
    const email = _getPlayerEmail(playerId);
    if (!email) return;
    await _sendEmail(email,
      "Caleb's Hollow — The Battle has ended!",
      `${body}\n\nSee the results: ${_baseUrl()}`
    );
  }
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
    if (!email) { console.log(`[Notify] no device tokens and no email for player=${playerId} name=${_playerTag(playerId)}, skipping`); return; }
    const opponent = _playerName(gameInfo.opponentId);
    await _sendEmail(email,
      "Caleb's Hollow — Game abandoned",
      `Your async game against ${opponent} has been abandoned due to inactivity (3 consecutive rounds with no submissions from either player).`
    );
  }
}
