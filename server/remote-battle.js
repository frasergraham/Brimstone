// Remote AI Battle — admin-controlled AI players in existing battle rooms.
//
// Adds AI players to the existing "Battle for Caleb's Hollow" rooms with
// manual turn control.  Plans are only generated when an admin clicks
// "Take Turn" — the normal auto-submission is skipped for these seats.
//
// Helper functions callable from:
//   1. Admin panel REST API (server.js)
//   2. CLI script (scripts/remote-battle.js)
//
// Turn data is persisted to disk alongside the database file in
// data/remote-battles/<roomId>/.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { HERO_PERSONALITIES, WITCH_PERSONALITIES } from '../src/ai.js';
import { PlanActionType } from '../src/planner.js';
import { serializeState } from './state-sync.js';
import {
  getRoom,
  getActiveBattleRooms,
  addRemoteAI,
  generateRemoteAIPlan,
  submitRemoteAIPlan,
  resignRemoteAI,
  listRemoteAIs,
} from './lobby.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DB_PATH
  ? join(dirname(process.env.DB_PATH), 'remote-battles')
  : join(__dirname, '..', 'data', 'remote-battles');

// ── Disk persistence helpers ────────────────────────────────────────────────

function _ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function _saveTurnData(roomId, playerId, round, plan) {
  const dir = join(DATA_DIR, roomId);
  _ensureDir(dir);
  const data = { playerId, round, plan, generatedAt: Date.now() };
  writeFileSync(
    join(dir, `round-${String(round).padStart(4, '0')}-${playerId.slice(0, 8)}.json`),
    JSON.stringify(data, null, 2),
  );
}

// ── LLM integration ─────────────────────────────────────────────────────────

/**
 * @typedef {object} LLMConfig
 * @property {string} endpoint - URL to POST to
 * @property {string} [prompt] - Prompt template (supports {{FACTION}}, {{ROUND}}, {{BUDGET}})
 */

/** In-memory map of playerId → LLMConfig for LLM-backed players. */
const llmConfigs = new Map();

const DEFAULT_LLM_PROMPT = `You are playing as the {{FACTION}} faction in a hex-grid strategy game called Brimstone.
It is round {{ROUND}} and you have {{BUDGET}} actions available.

Analyze the game context provided and return a JSON object with a "plan" key containing an array of plan actions.
Each action should have: { type, entityId, toCol?, toRow?, targetId? }

Valid action types: MOVE, BATTLE_UNIT, BATTLE_HEX, SUMMON, USE_ITEM, EQUIP_WEAPON, EXPLORE, FORTIFY, USE_ABILITY

Prioritize controlling power nodes and keeping your leader alive.`;

/**
 * Call an external LLM endpoint to generate a plan.
 * Sends serialized game state + valid context as the prompt body.
 * Expects the LLM to return a JSON array of PlanAction objects.
 */
async function _callLLM(room, playerId, llmConfig) {
  const state = room.state;
  const serialized = serializeState(state);

  const playerEntities = state.entities
    .filter(e => e.alive && e.ownerId === playerId)
    .map(e => ({
      id: e.id, type: e.type, name: e.name,
      col: e.col, row: e.row,
      hp: e.hp, maxHp: e.maxHp,
      attack: e.attack, defense: e.defense,
    }));

  const seat = room.players.find(s => s.playerId === playerId);
  const budget = state.playerActionsLeft?.get(playerId) ?? 0;

  const context = {
    round:     state.round,
    phase:     state.phase,
    faction:   seat?.faction,
    playerId,
    budget,
    myEntities: playerEntities,
    allEntities: serialized.entities,
    tiles:     serialized.tiles,
    nodeScore: serialized.nodeScore,
    inventory: serialized.inventory,
    planActionTypes: Object.values(PlanActionType),
  };

  const promptTemplate = llmConfig.prompt || DEFAULT_LLM_PROMPT;
  const systemPrompt = promptTemplate
    .replace('{{FACTION}}', seat?.faction || 'unknown')
    .replace('{{ROUND}}', String(state.round))
    .replace('{{BUDGET}}', String(budget));

  const resp = await fetch(llmConfig.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: systemPrompt, context }),
  });

  if (!resp.ok) {
    throw new Error(`LLM endpoint returned ${resp.status}: ${await resp.text()}`);
  }

  const result = await resp.json();
  return Array.isArray(result) ? result : (result.plan ?? []);
}

// ── Public API ──────────────────────────────────────────────────────────────

// Personality registries by faction id. Keyed lookup keeps this file free of
// per-faction string checks; registries live in ai.js.
const PERSONALITY_REGISTRIES = {
  hero:  HERO_PERSONALITIES,
  witch: WITCH_PERSONALITIES,
};

/**
 * Get available AI personalities for a faction.
 */
export function getPersonalities(faction) {
  return Object.keys(PERSONALITY_REGISTRIES[faction] || {});
}

function _countByFaction(players) {
  const counts = {};
  for (const s of players) counts[s.faction] = (counts[s.faction] || 0) + 1;
  return counts;
}

/**
 * List active battle rooms that can accept remote AI players.
 */
export function listBattleRooms() {
  return getActiveBattleRooms().map(room => {
    const counts = _countByFaction(room.players);
    return {
      roomId:         room.id,
      round:          room.state.round,
      phase:          room.phase,
      gameOver:       room.state.gameOver || false,
      heroCount:      counts.hero || 0,
      witchCount:     counts.witch || 0,
      maxPerSide:     room.state.battleConfig?.maxPlayersPerSide ?? 10,
      remoteAIs:      room.players.filter(s => s.adminControlled).length,
    };
  });
}

/**
 * Add an admin-controlled AI player to an existing battle room.
 * @param {string} roomId
 * @param {object} opts
 * @param {string} opts.faction       - 'hero' | 'witch'
 * @param {string} [opts.type]        - 'ai' | 'llm' (default 'ai')
 * @param {string} [opts.personality] - AI personality key (for type=ai)
 * @param {string} [opts.name]        - Display name
 * @param {string} [opts.llmEndpoint] - URL for LLM provider (for type=llm)
 * @param {string} [opts.llmPrompt]   - Prompt template (for type=llm)
 */
export function addPlayer(roomId, opts) {
  const playerType = opts.type || 'ai';

  if (playerType === 'llm' && !opts.llmEndpoint) {
    return { ok: false, error: 'LLM players require an llmEndpoint.' };
  }
  if (playerType !== 'ai' && playerType !== 'llm') {
    return { ok: false, error: 'Player type must be "ai" or "llm".' };
  }

  // For LLM type, we still create the player as a built-in AI (so it has a
  // fallback plan generator) but store the LLM config for manual turn calls.
  const result = addRemoteAI(roomId, opts.faction, {
    personality: opts.personality,
    name:        opts.name,
  });

  if (result.ok && playerType === 'llm') {
    llmConfigs.set(result.playerId, {
      endpoint: opts.llmEndpoint,
      prompt:   opts.llmPrompt || null,
    });
  }

  if (result.ok) {
    result.type = playerType;
  }

  return result;
}

/**
 * Generate and submit a turn for one admin-controlled AI player.
 * Uses the LLM endpoint if configured, otherwise the built-in AI engine.
 * @param {string} roomId
 * @param {string} playerId
 */
export async function takeTurn(roomId, playerId) {
  const llmConfig = llmConfigs.get(playerId);

  if (llmConfig) {
    // LLM path — call external endpoint, then submit the plan
    const room = getRoom(roomId);
    if (!room) return { ok: false, error: 'Room not found.' };

    let plan;
    try {
      plan = await _callLLM(room, playerId, llmConfig);
    } catch (err) {
      console.error(`[remote-ai] LLM call failed for ${playerId}:`, err);
      return { ok: false, error: `LLM call failed: ${err.message}` };
    }

    const submitResult = submitRemoteAIPlan(roomId, playerId, plan);
    if (!submitResult.ok) return submitResult;

    _saveTurnData(roomId, playerId, room.state.round, plan);
    console.log(`[remote-ai] LLM generated ${plan.length} actions for ${playerId.slice(0, 8)} (round ${room.state.round})`);
    return { ok: true, plan };
  }

  // Built-in AI path
  const result = generateRemoteAIPlan(roomId, playerId);
  if (result.ok) {
    _saveTurnData(roomId, playerId, getRoom(roomId)?.state?.round ?? 0, result.plan);
  }
  return result;
}

/**
 * Generate and submit turns for ALL admin-controlled AI players in a room
 * that haven't submitted yet this round.
 */
export async function takeAllTurns(roomId) {
  const room = getRoom(roomId);
  if (!room) return { ok: false, results: [], error: 'Room not found.' };

  const remotes = room.players.filter(
    s => s.adminControlled && !room.state.playerReady?.get(s.playerId)
  );

  const results = [];
  for (const seat of remotes) {
    const result = await takeTurn(roomId, seat.playerId);
    results.push({ playerId: seat.playerId, name: seat.name, faction: seat.faction, ...result });
  }

  return { ok: true, results };
}

/**
 * Submit an externally-crafted plan for an admin-controlled player.
 */
export function submitPlan(roomId, playerId, plan) {
  return submitRemoteAIPlan(roomId, playerId, plan);
}

/**
 * Resign/remove an admin-controlled AI player from a battle room.
 */
export function resignPlayer(roomId, playerId) {
  llmConfigs.delete(playerId);
  return resignRemoteAI(roomId, playerId);
}

/**
 * Get the status of all admin-controlled AI players across battle rooms.
 */
export function getRemoteAIStatus() {
  const rooms = listRemoteAIs();
  // Enrich with LLM config info
  for (const entry of rooms) {
    for (const p of entry.remotes) {
      const llm = llmConfigs.get(p.playerId);
      p.type = llm ? 'llm' : 'ai';
      p.llmEndpoint = llm?.endpoint ?? null;
    }
  }
  return rooms;
}

/**
 * Get detailed status for a specific battle room including remote AI players.
 */
export function getRoomRemoteStatus(roomId) {
  const room = getRoom(roomId);
  if (!room) return null;
  if (!room.config.isBattle) return null;

  return {
    roomId:     room.id,
    round:      room.state.round,
    phase:      room.phase,
    gamePhase:  room.state.phase,
    gameOver:   room.state.gameOver || false,
    winner:     room.state.winner || null,
    winReason:  room.state.winReason || null,
    nodeScore:  room.state.nodeScore || null,
    heroCount:  _countByFaction(room.players).hero || 0,
    witchCount: _countByFaction(room.players).witch || 0,
    maxPerSide: room.state.battleConfig?.maxPlayersPerSide ?? 10,
    allPlayers: room.players.map(s => ({
      playerId:        s.playerId,
      name:            s.name,
      faction:         s.faction,
      isAI:            s.isAI,
      adminControlled: !!s.adminControlled,
      personality:     s.personality ?? null,
      type:            llmConfigs.has(s.playerId) ? 'llm' : (s.isAI ? 'ai' : 'human'),
      llmEndpoint:     llmConfigs.get(s.playerId)?.endpoint ?? null,
      submitted:       !!room.state.playerReady?.get(s.playerId),
      leader:          _leaderSummary(room.state, s.playerId),
      entityCount:     room.state.entities.filter(e => e.alive && e.ownerId === s.playerId).length,
    })),
    log: (room.state.log || []).slice(-20),
  };
}

function _leaderSummary(state, playerId) {
  const p = state.players.find(pl => pl.id === playerId);
  if (!p) return null;
  const leader = state.entities.find(e => e.id === p.leaderId && e.alive);
  if (!leader) return { alive: false };
  return { alive: true, hp: leader.hp, maxHp: leader.maxHp, col: leader.col, row: leader.row };
}
