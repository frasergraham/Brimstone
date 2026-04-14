// Remote AI Battle — admin-controlled battle roster with manual turn timing.
//
// Helper functions callable from:
//   1. Admin panel REST API (server.js)
//   2. CLI script (scripts/remote-battle.js)
//
// Turn data is persisted to disk alongside the database file in
// data/remote-battles/<battleId>/.

import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { GameState, GameMode, computeActionsForPlayer, countHeldNodes } from '../src/game.js';
import { HERO_PERSONALITIES, WITCH_PERSONALITIES } from '../src/ai.js';
import { WitchAIEngine } from '../src/ai-engine.js';
import { HeroAIEngine }  from '../src/hero-ai-engine.js';
import { serializeState, deserializeState } from './state-sync.js';
import { resolvePlansMP, ResEventType } from './resolver.js';
import { generateBattleStarts, generateMultipleStarts } from '../src/map.js';
import { PlanActionType } from '../src/planner.js';
import { compileTurnBattleSummary } from '../src/battle-utils.js';
import { pickAIName } from '../src/ai-names.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DB_PATH
  ? join(dirname(process.env.DB_PATH), 'remote-battles')
  : join(__dirname, '..', 'data', 'remote-battles');

// ── In-memory registry ──────────────────────────────────────────────────────

/** @type {Map<string, RemoteBattle>} */
const battles = new Map();

/**
 * @typedef {object} RosterEntry
 * @property {string}  playerId
 * @property {string}  name
 * @property {string}  faction   - 'hero' | 'witch'
 * @property {string}  type      - 'ai' | 'llm'
 * @property {string|null} personality - AI personality key (for type=ai)
 * @property {string|null} llmEndpoint - URL to call (for type=llm)
 * @property {string|null} llmPrompt   - System/user prompt template (for type=llm)
 * @property {object|null} ai          - Live AI engine instance (transient, not persisted)
 * @property {Array|null}  lastPlan    - Most recently generated plan
 * @property {string}  status    - 'active' | 'resigned'
 */

/**
 * @typedef {object} RemoteBattle
 * @property {string}  id
 * @property {string}  name          - Human-readable label
 * @property {string}  mapSize
 * @property {number}  playersPerSide
 * @property {GameState} state
 * @property {RosterEntry[]} roster
 * @property {number}  round         - Current round (mirrors state.round)
 * @property {string}  phase         - 'setup' | 'planning' | 'ready' | 'resolved' | 'game_over'
 * @property {object}  pendingPlans  - { playerId → PlanAction[] }
 * @property {Array}   history       - Per-round resolution summaries
 * @property {number}  createdAt
 */

// ── Disk persistence helpers ────────────────────────────────────────────────

function battleDir(battleId) {
  return join(DATA_DIR, battleId);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function saveBattleConfig(battle) {
  const dir = battleDir(battle.id);
  ensureDir(dir);
  const config = {
    id:             battle.id,
    name:           battle.name,
    mapSize:        battle.mapSize,
    playersPerSide: battle.playersPerSide,
    createdAt:      battle.createdAt,
    roster: battle.roster.map(r => ({
      playerId:    r.playerId,
      name:        r.name,
      faction:     r.faction,
      type:        r.type,
      personality: r.personality,
      llmEndpoint: r.llmEndpoint,
      llmPrompt:   r.llmPrompt,
      status:      r.status,
    })),
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function saveBattleState(battle) {
  const dir = battleDir(battle.id);
  ensureDir(dir);
  const snap = {
    phase:   battle.phase,
    round:   battle.round,
    state:   serializeState(battle.state),
    pendingPlans: Object.fromEntries(
      Object.entries(battle.pendingPlans).map(([k, v]) => [k, v])
    ),
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(snap));
}

function saveRoundData(battle, roundNum, data) {
  const dir = battleDir(battle.id);
  ensureDir(dir);
  writeFileSync(
    join(dir, `round-${String(roundNum).padStart(4, '0')}.json`),
    JSON.stringify(data),
  );
}

function loadBattleFromDisk(battleId) {
  const dir = battleDir(battleId);
  if (!existsSync(join(dir, 'config.json')) || !existsSync(join(dir, 'state.json'))) {
    return null;
  }
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const snap   = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));

  const state = deserializeState(snap.state);
  const battle = {
    id:             config.id,
    name:           config.name,
    mapSize:        config.mapSize,
    playersPerSide: config.playersPerSide,
    state,
    roster:         [],
    round:          snap.round,
    phase:          snap.phase,
    pendingPlans:   snap.pendingPlans || {},
    history:        _loadHistory(dir),
    createdAt:      config.createdAt,
  };

  // Rebuild roster with live AI instances
  for (const entry of config.roster) {
    const rosterEntry = {
      ...entry,
      ai:       null,
      lastPlan: null,
    };
    if (entry.type === 'ai' && entry.status === 'active') {
      rosterEntry.ai = _makeAI(state, entry.faction, entry.playerId, entry.personality);
    }
    battle.roster.push(rosterEntry);
  }

  battles.set(battleId, battle);
  return battle;
}

function _loadHistory(dir) {
  const history = [];
  try {
    const files = readdirSync(dir).filter(f => f.startsWith('round-') && f.endsWith('.json')).sort();
    for (const f of files) {
      history.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    }
  } catch { /* empty */ }
  return history;
}

// ── AI helpers ──────────────────────────────────────────────────────────────

function _makeAI(state, faction, playerId, personality = null) {
  const registry = faction === 'witch' ? WITCH_PERSONALITIES : HERO_PERSONALITIES;
  const AICls    = registry[personality] ?? (faction === 'witch' ? WitchAIEngine : HeroAIEngine);
  return new AICls(state, () => {}, 0, playerId);
}

function _availablePersonalities(faction) {
  const registry = faction === 'witch' ? WITCH_PERSONALITIES : HERO_PERSONALITIES;
  return Object.keys(registry);
}

// ── LLM helpers ─────────────────────────────────────────────────────────────

/**
 * Call an external LLM endpoint to generate a plan.
 * Sends serialized game state + valid context as the prompt body.
 * Expects the LLM to return a JSON array of PlanAction objects.
 */
async function _callLLM(battle, entry) {
  const state = battle.state;
  const serialized = serializeState(state);

  // Build context for the LLM
  const playerEntities = state.entities
    .filter(e => e.alive && e.ownerId === entry.playerId)
    .map(e => ({
      id: e.id, type: e.type, name: e.name,
      col: e.col, row: e.row,
      hp: e.hp, maxHp: e.maxHp,
      attack: e.attack, defense: e.defense,
    }));

  const budget = state.playerActionsLeft?.get(entry.playerId) ?? 0;

  const context = {
    round:     state.round,
    phase:     state.phase,
    faction:   entry.faction,
    playerId:  entry.playerId,
    budget,
    myEntities: playerEntities,
    allEntities: serialized.entities,
    tiles:     serialized.tiles,
    nodeScore: serialized.nodeScore,
    inventory: serialized.inventory,
    planActionTypes: Object.values(PlanActionType),
  };

  const promptTemplate = entry.llmPrompt || DEFAULT_LLM_PROMPT;
  const systemPrompt = promptTemplate
    .replace('{{FACTION}}', entry.faction)
    .replace('{{ROUND}}', String(state.round))
    .replace('{{BUDGET}}', String(budget));

  const requestBody = {
    system: systemPrompt,
    context,
  };

  const resp = await fetch(entry.llmEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    throw new Error(`LLM endpoint returned ${resp.status}: ${await resp.text()}`);
  }

  const result = await resp.json();

  // The LLM should return { plan: PlanAction[] } or just PlanAction[]
  const plan = Array.isArray(result) ? result : (result.plan ?? []);
  return plan;
}

const DEFAULT_LLM_PROMPT = `You are playing as the {{FACTION}} faction in a hex-grid strategy game called Brimstone.
It is round {{ROUND}} and you have {{BUDGET}} actions available.

Analyze the game context provided and return a JSON object with a "plan" key containing an array of plan actions.
Each action should have: { type, entityId, toCol?, toRow?, targetId? }

Valid action types: MOVE, BATTLE_UNIT, BATTLE_HEX, SUMMON, USE_ITEM, EQUIP_WEAPON, EXPLORE, FORTIFY, USE_ABILITY

Prioritize controlling power nodes and keeping your leader alive.`;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new remote battle with an empty roster.
 * @param {object} opts
 * @param {string} [opts.name]           - Display name
 * @param {string} [opts.mapSize]        - 'skirmish' | 'standard' | 'regional' | 'campaign'
 * @param {number} [opts.playersPerSide] - 1–10
 * @returns {RemoteBattle}
 */
export function createBattle(opts = {}) {
  const id   = randomUUID();
  const name = opts.name || `Remote Battle ${id.slice(0, 8)}`;
  const mapSize        = opts.mapSize || 'standard';
  const playersPerSide = Math.max(1, Math.min(10, opts.playersPerSide ?? 2));

  // Create game state — no pre-built players (we add them via addPlayer)
  const state = new GameState(false, false, mapSize);
  state.fogOfWar   = 'none';
  state.gameMode   = GameMode.BATTLE;
  state.battleConfig = { endsAt: 0, maxPlayersPerSide: playersPerSide };

  // Clear default entities/players — roster is populated manually
  state.entities = [];
  state.players  = [];
  state.hero     = null;
  state.witch    = null;

  const battle = {
    id,
    name,
    mapSize,
    playersPerSide,
    state,
    roster:       [],
    round:        0,
    phase:        'setup',
    pendingPlans: {},
    history:      [],
    createdAt:    Date.now(),
  };

  battles.set(id, battle);
  saveBattleConfig(battle);
  saveBattleState(battle);

  console.log(`[remote-battle] Created "${name}" (${id.slice(0, 8)}) — ${mapSize} ${playersPerSide}v${playersPerSide}`);
  return battle;
}

/**
 * Add a player to the battle roster.
 * @param {string} battleId
 * @param {object} opts
 * @param {string}  opts.faction      - 'hero' | 'witch'
 * @param {string}  [opts.type]       - 'ai' | 'llm' (default 'ai')
 * @param {string}  [opts.personality] - AI personality key
 * @param {string}  [opts.name]       - Display name
 * @param {string}  [opts.llmEndpoint] - URL for LLM provider
 * @param {string}  [opts.llmPrompt]   - Prompt template
 * @returns {{ ok: boolean, playerId?: string, error?: string }}
 */
export function addPlayer(battleId, opts) {
  const battle = _getBattle(battleId);
  if (!battle) return { ok: false, error: 'Battle not found.' };

  const faction = opts.faction;
  if (faction !== 'hero' && faction !== 'witch') {
    return { ok: false, error: 'Faction must be "hero" or "witch".' };
  }

  const currentCount = battle.roster.filter(r => r.faction === faction && r.status === 'active').length;
  if (currentCount >= battle.playersPerSide) {
    return { ok: false, error: `${faction} side is full (${battle.playersPerSide} max).` };
  }

  const playerType = opts.type || 'ai';
  if (playerType !== 'ai' && playerType !== 'llm') {
    return { ok: false, error: 'Player type must be "ai" or "llm".' };
  }

  if (playerType === 'llm' && !opts.llmEndpoint) {
    return { ok: false, error: 'LLM players require an llmEndpoint.' };
  }

  const playerId = randomUUID();
  const usedNames = new Set(battle.roster.map(r => r.name));
  const displayName = opts.name || pickAIName(faction, usedNames);

  // Spawn the leader entity on the map
  const state = battle.state;
  const existingStarts = state.entities
    .filter(e => (e.type === 'hero' || e.type === 'witch') && e.owner === faction)
    .map(e => ({ col: e.col, row: e.row }));

  let spawnPos;
  if (existingStarts.length === 0) {
    // First player on this faction — use battle start positions
    const starts = generateBattleStarts(state.tiles, faction, 1, 2);
    spawnPos = starts[0] || { col: 0, row: 0 };
  } else {
    // Subsequent players — find a spot near existing starts
    const starts = generateMultipleStarts(state.tiles, existingStarts[0], currentCount + 1, 2, 5);
    spawnPos = starts[starts.length - 1] || existingStarts[0];
  }

  state.addPlayer(playerId, displayName, faction, spawnPos.col, spawnPos.row, true);

  const entry = {
    playerId,
    name:        displayName,
    faction,
    type:        playerType,
    personality: playerType === 'ai' ? (opts.personality || 'balanced') : null,
    llmEndpoint: playerType === 'llm' ? opts.llmEndpoint : null,
    llmPrompt:   playerType === 'llm' ? (opts.llmPrompt || null) : null,
    ai:          null,
    lastPlan:    null,
    status:      'active',
  };

  if (playerType === 'ai') {
    entry.ai = _makeAI(state, faction, playerId, entry.personality);
  }

  battle.roster.push(entry);
  saveBattleConfig(battle);
  saveBattleState(battle);

  console.log(`[remote-battle] Added ${faction} ${playerType} "${displayName}" to ${battle.name}`);
  return { ok: true, playerId };
}

/**
 * Resign/remove a player from the battle.
 * Their units are scattered and they can no longer take turns.
 * @returns {{ ok: boolean, error?: string }}
 */
export function resignPlayer(battleId, playerId) {
  const battle = _getBattle(battleId);
  if (!battle) return { ok: false, error: 'Battle not found.' };

  const entry = battle.roster.find(r => r.playerId === playerId);
  if (!entry) return { ok: false, error: 'Player not found in roster.' };
  if (entry.status === 'resigned') return { ok: false, error: 'Player already resigned.' };

  entry.status = 'resigned';
  entry.ai = null;

  // Scatter their units
  const state = battle.state;
  if (state.scatterPlayerUnits) {
    state.scatterPlayerUnits(playerId);
  }

  // Remove leader entity
  state.entities = state.entities.filter(
    e => e.ownerId !== playerId || (e.type !== 'hero' && e.type !== 'witch')
  );

  // Remove from state.players
  state.players = state.players.filter(p => p.id !== playerId);

  // Remove any pending plan
  delete battle.pendingPlans[playerId];

  state.addLog(`${entry.name} has been removed from the battle.`);

  saveBattleConfig(battle);
  saveBattleState(battle);

  console.log(`[remote-battle] Resigned ${entry.name} from ${battle.name}`);
  return { ok: true };
}

/**
 * Start the first planning phase. Call after adding all initial players.
 * @returns {{ ok: boolean, error?: string }}
 */
export function startBattle(battleId) {
  const battle = _getBattle(battleId);
  if (!battle) return { ok: false, error: 'Battle not found.' };

  const activeHeroes  = battle.roster.filter(r => r.faction === 'hero'  && r.status === 'active');
  const activeWitches = battle.roster.filter(r => r.faction === 'witch' && r.status === 'active');
  if (activeHeroes.length === 0 || activeWitches.length === 0) {
    return { ok: false, error: 'Need at least one active player on each faction.' };
  }

  battle.state.startPlanning();
  battle.phase = 'planning';
  battle.round = battle.state.round;
  battle.pendingPlans = {};

  saveBattleState(battle);
  console.log(`[remote-battle] Started ${battle.name} — round ${battle.round}`);
  return { ok: true };
}

/**
 * Generate a plan for a single player (AI or LLM).
 * Does NOT submit it — the admin can review and then call submitTurn or resolveRound.
 * @returns {Promise<{ ok: boolean, plan?: Array, error?: string }>}
 */
export async function generateTurn(battleId, playerId) {
  const battle = _getBattle(battleId);
  if (!battle) return { ok: false, error: 'Battle not found.' };
  if (battle.phase !== 'planning') return { ok: false, error: `Cannot generate turn in phase "${battle.phase}".` };

  const entry = battle.roster.find(r => r.playerId === playerId && r.status === 'active');
  if (!entry) return { ok: false, error: 'Active player not found in roster.' };

  // Build ally context from already-generated plans on this faction
  const allyContext = { claimedNodes: new Set(), allyPositions: [] };
  for (const [pid, plan] of Object.entries(battle.pendingPlans)) {
    const peer = battle.roster.find(r => r.playerId === pid);
    if (peer && peer.faction === entry.faction) {
      const leader = battle.state.entities.find(
        e => e.alive && e.ownerId === pid && (e.type === 'hero' || e.type === 'witch')
      );
      if (leader) allyContext.allyPositions.push({ col: leader.col, row: leader.row });
    }
  }

  let plan;
  try {
    if (entry.type === 'ai') {
      if (!entry.ai) {
        entry.ai = _makeAI(battle.state, entry.faction, entry.playerId, entry.personality);
      }
      plan = entry.ai.generatePlan(allyContext);
    } else if (entry.type === 'llm') {
      plan = await _callLLM(battle, entry);
    }
  } catch (err) {
    console.error(`[remote-battle] Plan generation failed for ${entry.name}:`, err);
    return { ok: false, error: `Plan generation failed: ${err.message}` };
  }

  entry.lastPlan = plan;
  battle.pendingPlans[playerId] = plan;
  saveBattleState(battle);

  console.log(`[remote-battle] Generated ${plan.length} actions for ${entry.name} (round ${battle.round})`);
  return { ok: true, plan };
}

/**
 * Generate plans for ALL active players who don't have a pending plan yet.
 * @returns {Promise<{ ok: boolean, results: object[] }>}
 */
export async function generateAllTurns(battleId) {
  const battle = _getBattle(battleId);
  if (!battle) return { ok: false, results: [], error: 'Battle not found.' };
  if (battle.phase !== 'planning') return { ok: false, results: [], error: `Cannot generate turns in phase "${battle.phase}".` };

  const results = [];
  // Process each faction sequentially so ally context accumulates properly
  for (const faction of ['hero', 'witch']) {
    const factionPlayers = battle.roster.filter(
      r => r.faction === faction && r.status === 'active' && !battle.pendingPlans[r.playerId]
    );
    for (const entry of factionPlayers) {
      const result = await generateTurn(battleId, entry.playerId);
      results.push({ playerId: entry.playerId, name: entry.name, ...result });
    }
  }

  return { ok: true, results };
}

/**
 * Submit a manually-crafted plan for a player (e.g. from external tool or LLM override).
 * @returns {{ ok: boolean, error?: string }}
 */
export function submitCustomPlan(battleId, playerId, plan) {
  const battle = _getBattle(battleId);
  if (!battle) return { ok: false, error: 'Battle not found.' };
  if (battle.phase !== 'planning') return { ok: false, error: `Cannot submit plan in phase "${battle.phase}".` };

  const entry = battle.roster.find(r => r.playerId === playerId && r.status === 'active');
  if (!entry) return { ok: false, error: 'Active player not found in roster.' };

  entry.lastPlan = plan;
  battle.pendingPlans[playerId] = plan;
  saveBattleState(battle);

  return { ok: true };
}

/**
 * Resolve the current round. All active players must have pending plans.
 * If some don't, they get empty plans (pass turn).
 * @returns {{ ok: boolean, steps?: Array, error?: string }}
 */
export function resolveRound(battleId) {
  const battle = _getBattle(battleId);
  if (!battle) return { ok: false, error: 'Battle not found.' };
  if (battle.phase !== 'planning') return { ok: false, error: `Cannot resolve in phase "${battle.phase}".` };

  const state = battle.state;

  // Build player entries — use pending plans or empty plan for missing
  const playerEntries = [];
  for (const entry of battle.roster) {
    if (entry.status !== 'active') continue;
    const plan = battle.pendingPlans[entry.playerId] || [];
    state.submitPlayerPlan(entry.playerId, plan);
    playerEntries.push({
      playerId: entry.playerId,
      faction:  entry.faction,
      plan,
    });
  }

  // Snapshot pre-state
  const preStateJson = JSON.stringify(serializeState(state));

  // Run resolution
  battle.phase = 'resolving';
  let steps;
  try {
    steps = resolvePlansMP(state, playerEntries);
  } catch (err) {
    console.error(`[remote-battle] Resolution error:`, err);
    battle.phase = 'planning';
    return { ok: false, error: `Resolution failed: ${err.message}` };
  }

  // Post-resolution bookkeeping
  const summaryLines = compileTurnBattleSummary(steps, state.entities, ResEventType, PlanActionType);
  for (const line of summaryLines) state.log.push(line);

  state.updateNodeDiscovery();
  if (state.checkAndLogNodeControlChanges) state.checkAndLogNodeControlChanges();
  state.updateExploredHexes();
  state.endRound();

  const finalState = serializeState(state);

  // Save round data to disk
  const roundData = {
    roundNum:    state.round - 1,
    preStateJson,
    stepsJson:   JSON.stringify(steps),
    finalState,
    plans: Object.fromEntries(
      playerEntries.map(pe => [pe.playerId, pe.plan])
    ),
  };
  saveRoundData(battle, state.round - 1, roundData);
  battle.history.push(roundData);

  // Check for game over
  if (state.gameOver) {
    battle.phase = 'game_over';
    console.log(`[remote-battle] ${battle.name} — Game Over! Winner: ${state.winner}, reason: ${state.winReason}`);
  } else {
    // Start next planning phase
    state.startPlanning();
    battle.phase = 'planning';
    battle.round = state.round;

    // Refresh AI instances so they see updated state
    for (const entry of battle.roster) {
      if (entry.type === 'ai' && entry.status === 'active') {
        entry.ai = _makeAI(state, entry.faction, entry.playerId, entry.personality);
      }
    }
  }

  battle.pendingPlans = {};
  saveBattleConfig(battle);
  saveBattleState(battle);

  console.log(`[remote-battle] Resolved round ${state.round - 1} of ${battle.name} (${steps.length} steps)`);
  return { ok: true, steps, finalState };
}

/**
 * Get full status of a battle.
 * @returns {object|null}
 */
export function getBattleStatus(battleId) {
  const battle = _getBattle(battleId);
  if (!battle) return null;

  const state = battle.state;
  return {
    id:             battle.id,
    name:           battle.name,
    mapSize:        battle.mapSize,
    playersPerSide: battle.playersPerSide,
    phase:          battle.phase,
    round:          battle.round,
    createdAt:      battle.createdAt,
    gameOver:       state.gameOver || false,
    winner:         state.winner || null,
    winReason:      state.winReason || null,
    nodeScore:      state.nodeScore || null,
    currentPhase:   state.phase,
    roster: battle.roster.map(r => ({
      playerId:    r.playerId,
      name:        r.name,
      faction:     r.faction,
      type:        r.type,
      personality: r.personality,
      llmEndpoint: r.llmEndpoint,
      status:      r.status,
      hasPlan:     !!battle.pendingPlans[r.playerId],
      planLength:  battle.pendingPlans[r.playerId]?.length ?? 0,
      leader:      _leaderSummary(state, r.playerId),
      entityCount: state.entities.filter(e => e.alive && e.ownerId === r.playerId).length,
    })),
    entities: state.entities.filter(e => e.alive).map(e => ({
      id: e.id, type: e.type, ownerId: e.ownerId, name: e.name,
      col: e.col, row: e.row, hp: e.hp, maxHp: e.maxHp,
    })),
    log: (state.log || []).slice(-20),
    roundCount: battle.history.length,
  };
}

/**
 * List all remote battles (in-memory + on-disk).
 * @returns {object[]}
 */
export function listBattles() {
  // First load any on-disk battles not yet in memory
  _loadAllFromDisk();

  return [...battles.values()].map(b => ({
    id:             b.id,
    name:           b.name,
    mapSize:        b.mapSize,
    playersPerSide: b.playersPerSide,
    phase:          b.phase,
    round:          b.round,
    createdAt:      b.createdAt,
    rosterCount:    b.roster.filter(r => r.status === 'active').length,
    gameOver:       b.state.gameOver || false,
    winner:         b.state.winner || null,
  }));
}

/**
 * Get available AI personalities for a faction.
 * @param {string} faction - 'hero' | 'witch'
 * @returns {string[]}
 */
export function getPersonalities(faction) {
  return _availablePersonalities(faction);
}

/**
 * Delete a remote battle from memory and optionally from disk.
 * @returns {{ ok: boolean, error?: string }}
 */
export function deleteBattle(battleId) {
  const battle = battles.get(battleId);
  if (!battle) return { ok: false, error: 'Battle not found.' };
  battles.delete(battleId);
  // We don't delete from disk — preserved as history
  return { ok: true };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function _getBattle(battleId) {
  let battle = battles.get(battleId);
  if (!battle) {
    // Try loading from disk
    battle = loadBattleFromDisk(battleId);
  }
  return battle || null;
}

function _leaderSummary(state, playerId) {
  const p = state.players.find(pl => pl.id === playerId);
  if (!p) return null;
  const leader = state.entities.find(e => e.id === p.leaderId && e.alive);
  if (!leader) return { alive: false };
  return {
    alive: true,
    hp: leader.hp,
    maxHp: leader.maxHp,
    col: leader.col,
    row: leader.row,
  };
}

function _loadAllFromDisk() {
  try {
    if (!existsSync(DATA_DIR)) return;
    const dirs = readdirSync(DATA_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const dirName of dirs) {
      if (!battles.has(dirName)) {
        loadBattleFromDisk(dirName);
      }
    }
  } catch { /* ignore */ }
}
