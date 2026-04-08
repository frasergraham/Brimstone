// Battle for Caleb's Hollow — weekly game lifecycle scheduler.
// Creates a new battle room on startup (recovering from DB if possible).
// Checks for expired battles and triggers end-of-week scoring.

import { createBattleRoom, getActiveBattleRoom, recoverRoom, destroyRoom } from './lobby.js';
import { sendPush, getAllPlayerIdsWithTokens } from './push.js';
import { notifyBattleEnded } from './notifications.js';
import { getActiveBattleSaves, deleteSave, createCompletedGame, getSaveRounds } from './saves.js';
import { randomUUID } from 'crypto';
import { VERSION } from '../src/version.js';

// ── Time helpers ────────────────────────────────────────────────────────────

/** Get the current time in America/Los_Angeles. */
function _nowPST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

/** Get today's 8pm PST as a Unix timestamp (seconds). */
export function todayDeadlinePST() {
  const now = _nowPST();
  const deadline = new Date(now);
  deadline.setHours(20, 0, 0, 0);
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
  if (now >= sunday) {
    sunday.setDate(sunday.getDate() + 7);
  }
  return Math.floor(sunday.getTime() / 1000);
}

// ── Battle lifecycle ────────────────────────────────────────────────────────

/**
 * Ensure a battle room exists in memory.
 * 1. Check in-memory rooms first.
 * 2. Try to recover from DB (survives server restarts).
 * 3. If nothing found, create a fresh one.
 */
export function ensureBattleExists() {
  // Already in memory?
  const existing = getActiveBattleRoom();
  if (existing) {
    console.log(`[battle-scheduler] Active battle in memory: ${existing.id}`);
    return existing.id;
  }

  // Try recovering from DB
  try {
    const battleSaves = getActiveBattleSaves();
    for (const save of battleSaves) {
      // Check if the battle hasn't expired
      try {
        const cfg = JSON.parse(save.config_json || '{}');
        const battleConfig = save.state?.battleConfig;
        if (battleConfig?.endsAt && Math.floor(Date.now() / 1000) < battleConfig.endsAt) {
          const room = recoverRoom(save.room_id);
          if (room) {
            console.log(`[battle-scheduler] Recovered battle ${room.id} from DB (round ${room.state.round})`);
            return room.id;
          }
        } else {
          // Expired battle in DB — clean it up
          console.log(`[battle-scheduler] Pruning expired battle save ${save.room_id}`);
          deleteSave(save.room_id);
        }
      } catch (err) {
        console.error(`[battle-scheduler] Failed to recover battle ${save.room_id}:`, err);
      }
    }
  } catch (err) {
    console.error('[battle-scheduler] Failed to query battle saves:', err);
  }

  // Nothing to recover — create fresh
  const endsAt = _sundayEndPST();
  const roomId = createBattleRoom({ endsAt });
  console.log(`[battle-scheduler] Created new battle ${roomId}, ends ${new Date(endsAt * 1000).toISOString()}`);

  _notifyBattleStarted(roomId).catch(err =>
    console.error('[battle-scheduler] Failed to send battle start notifications:', err)
  );

  return roomId;
}

/**
 * Periodic check — called every 30 seconds.
 * Ensures there is always exactly one active battle on the server.
 */
export function checkBattleLifecycle() {
  const room = getActiveBattleRoom();
  if (!room) {
    ensureBattleExists();
    return;
  }

  const endsAt = room.state?.battleConfig?.endsAt;
  if (endsAt && Math.floor(Date.now() / 1000) >= endsAt && !room.state.winner) {
    _endBattle(room);
  }
}

/**
 * Admin action: forcibly end the current battle and start a new one.
 * Triggers all end-of-battle flows (scoring, notifications, cleanup).
 * Returns the new battle's roomId, or null if no active battle.
 */
export function endBattleEarly() {
  const room = getActiveBattleRoom();
  if (!room) return null;

  console.log(`[battle-scheduler] Admin ending battle ${room.id} early`);
  _endBattle(room);

  // Create the next battle immediately
  return ensureBattleExists();
}

// ── Internal ────────────────────────────────────────────────────────────────

function _endBattle(room) {
  console.log(`[battle-scheduler] Battle ${room.id} ending`);

  // Force the time-based victory check
  const origEndsAt = room.state.battleConfig?.endsAt;
  if (room.state.battleConfig) {
    room.state.battleConfig.endsAt = Math.floor(Date.now() / 1000) - 1;
  }
  room.state.checkVictory();
  if (room.state.battleConfig) {
    room.state.battleConfig.endsAt = origEndsAt;
  }

  // Notify all participants
  const gameInfo = {
    roomId: room.id,
    winner: room.state.winner,
    heroScore: room.state.nodeScore?.hero ?? 0,
    witchScore: room.state.nodeScore?.witch ?? 0,
  };
  for (const seat of room.players) {
    if (!seat.isAI) {
      notifyBattleEnded(seat.playerId, gameInfo).catch(() => {});
    }
  }

  // Save as a completed game with full replay for later viewing.
  // Replay rounds may be in memory (replayRounds) or only in DB (save_replay_rounds).
  try {
    let rounds = room.replayRounds ?? [];
    if (rounds.length === 0) {
      // Recovered room — replay rounds are in the DB, not in memory
      const dbRounds = getSaveRounds(room.id);
      rounds = dbRounds.map(r => ({
        roundNum:     r.round_num,
        preStateJson: r.pre_state_json,
        stepsJson:    r.steps_json,
      }));
    }

    if (rounds.length > 0) {
      const gameId = randomUUID();
      const firstHero  = room.players.find(s => s.faction === 'hero'  && !s.isAI);
      const firstWitch = room.players.find(s => s.faction === 'witch' && !s.isAI);
      const heroName   = room.players.find(s => s.faction === 'hero')?.name  ?? '';
      const witchName  = room.players.find(s => s.faction === 'witch')?.name ?? '';

      createCompletedGame(gameId, room.id, {
        heroPlayerId:  firstHero?.playerId  ?? null,
        witchPlayerId: firstWitch?.playerId ?? null,
        heroName,
        witchName,
        winner:      room.state.winner      ?? '',
        winReason:   room.state.winReason   ?? '',
        totalRounds: room.state.round - 1,
        gameVersion: VERSION,
        mode:        'battle',
        playersJson: JSON.stringify(room.players.map(s => ({
          playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI,
        }))),
      }, rounds);

      console.log(`[battle-scheduler] Saved completed battle ${gameId} (${rounds.length} rounds)`);
    }
  } catch (err) {
    console.error(`[battle-scheduler] createCompletedGame error:`, err);
  }

  // Clean up the in-progress save
  try { deleteSave(room.id); } catch {}

  // Destroy the room
  destroyRoom(room);
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
    } catch {
      // Individual push failures are non-fatal
    }
  }
  console.log(`[battle-scheduler] Sent battle-started notification to ${playerIds.length} players`);
}
