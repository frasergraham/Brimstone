// Battle for Caleb's Hollow — weekly game lifecycle scheduler.
// Creates a new battle room every Monday at midnight PST.
// Checks for and resolves expired battles.

import { createBattleRoom, getActiveBattleRoom, getBattleStatus } from './lobby.js';
import { sendPush, getAllPlayerIdsWithTokens } from './push.js';

// ── Time helpers ────────────────────────────────────────────────────────────

/** Get the current time in America/Los_Angeles. */
function _nowPST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

/** Get next Monday at 00:00 PST as a Unix timestamp (seconds). */
function _nextMondayPST() {
  const now = _nowPST();
  const day = now.getDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
  const next = new Date(now);
  next.setDate(next.getDate() + daysUntilMonday);
  next.setHours(0, 0, 0, 0);
  return Math.floor(next.getTime() / 1000);
}

/** Get today's 8pm PST as a Unix timestamp (seconds). */
export function todayDeadlinePST() {
  const now = _nowPST();
  const deadline = new Date(now);
  deadline.setHours(20, 0, 0, 0);
  // If past 8pm, deadline is tomorrow's 8pm
  if (now >= deadline) {
    deadline.setDate(deadline.getDate() + 1);
  }
  return Math.floor(deadline.getTime() / 1000);
}

/** Get the next Sunday at 8pm PST as the battle end time. */
function _sundayEndPST() {
  const now = _nowPST();
  const day = now.getDay(); // 0=Sun
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  const sunday = new Date(now);
  sunday.setDate(sunday.getDate() + daysUntilSunday);
  sunday.setHours(20, 0, 0, 0);
  // If it's already past Sunday 8pm, push to next Sunday
  if (now >= sunday) {
    sunday.setDate(sunday.getDate() + 7);
  }
  return Math.floor(sunday.getTime() / 1000);
}

// ── Battle lifecycle ────────────────────────────────────────────────────────

/**
 * Check if a new battle should be created.
 * Called on server startup and periodically by the background checker.
 */
export function ensureBattleExists() {
  const existing = getActiveBattleRoom();
  if (existing) {
    console.log(`[battle-scheduler] Active battle exists: ${existing.id}`);
    return existing.id;
  }

  // Check if it's a reasonable time to create one (any day is fine on startup)
  const endsAt = _sundayEndPST();
  const roomId = createBattleRoom({ endsAt });
  console.log(`[battle-scheduler] Created new battle ${roomId}, ends ${new Date(endsAt * 1000).toISOString()}`);

  // Notify all registered players
  _notifyBattleStarted(roomId).catch(err =>
    console.error('[battle-scheduler] Failed to send battle start notifications:', err)
  );

  return roomId;
}

/**
 * Periodic check — called every 30 seconds by the main deadline loop.
 * Ensures there is always exactly one active battle on the server.
 * When a battle expires, it triggers game-over and immediately creates the next one.
 */
export function checkBattleLifecycle() {
  const room = getActiveBattleRoom();
  if (!room) {
    // No active battle — create one immediately (ends next Sunday 8pm PST)
    ensureBattleExists();
    return;
  }

  // Check if the battle has expired
  const endsAt = room.state?.battleConfig?.endsAt;
  if (endsAt && Math.floor(Date.now() / 1000) >= endsAt && !room.state.winner) {
    console.log(`[battle-scheduler] Battle ${room.id} has expired, triggering final checkVictory`);
    room.state.checkVictory();
    // The next cycle of checkBattleLifecycle will see no active battle and create a new one
  }
}

// ── Push notifications ──────────────────────────────────────────────────────

async function _notifyBattleStarted(roomId) {
  let playerIds;
  try {
    playerIds = getAllPlayerIdsWithTokens();
  } catch {
    console.log('[battle-scheduler] Could not query device tokens for broadcast');
    return;
  }

  for (const playerId of playerIds) {
    try {
      await sendPush(playerId, {
        title: 'The Battle for Caleb\'s Hollow has begun!',
        body: 'A new week-long 10v10 battle awaits. Join now and fight for your faction!',
        roomId,
      });
    } catch (err) {
      // Individual push failures are non-fatal
    }
  }
  console.log(`[battle-scheduler] Sent battle-started notification to ${playerIds.length} players`);
}
