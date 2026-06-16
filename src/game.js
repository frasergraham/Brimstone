// Central game state and turn management
import { generateMap } from './map.js';
import { createHero, createWitch, createMinion, createSurvivor, resetRoster, survivorRosterIndexByName, bumpEntityId as _bumpModuleEntityId, EntityType, SurvivorAbility, ENTITY_COLOR, isLeaderType } from './entities.js';
import { BuildingType, ResourceType, hasBuilding, isRiver } from './tiles.js';
import { hexKey, hexDistance, getNeighbors, setMapDimensions, MAP_COLS, MAP_ROWS } from './hex.js';
import { applyPostRoundEffects, attritionForCycle } from './post-round-effects.js';
import { sightRange, computeLineOfSight, hasLineOfSight } from './actions.js';
import { getFaction, allFactions, getFactionsForSide, sightRangeForEntity } from './factions.js';
import { allSides } from './sides.js';

/**
 * Determine which faction controls a power node cluster based on majority hex occupation.
 * Multiple units on the same hex count as one occupied hex.
 * @returns {string} faction id of controller, or 'contested' | 'neutral'
 */
export function nodeController(obj, entities) {
  const hexSet = new Set(obj.hexes.map(h => hexKey(h.col, h.row)));
  // Build per-faction sets of occupied hexes
  const factionHexes = new Map(); // factionId → Set<hexKey>
  for (const e of entities) {
    if (!e.alive) continue;
    const k = hexKey(e.col, e.row);
    if (!hexSet.has(k)) continue;
    if (!factionHexes.has(e.owner)) factionHexes.set(e.owner, new Set());
    factionHexes.get(e.owner).add(k);
  }
  if (factionHexes.size === 0) return 'neutral';
  // Find faction(s) with the most occupied hexes
  let bestFaction = null;
  let bestCount = 0;
  let tied = false;
  for (const [faction, hexes] of factionHexes) {
    if (hexes.size > bestCount) {
      bestFaction = faction;
      bestCount = hexes.size;
      tied = false;
    } else if (hexes.size === bestCount) {
      tied = true;
    }
  }
  return tied ? 'contested' : bestFaction;
}

/**
 * Count how many power nodes a faction currently controls.
 * @param {'hero'|'witch'} faction
 * @param {Array} witchObjectives - power node cluster array
 * @param {Array} entities - all entities
 * @returns {number}
 */
export function countHeldNodes(faction, witchObjectives, entities) {
  let count = 0;
  for (const obj of witchObjectives) {
    if (nodeController(obj, entities) === faction) count++;
  }
  return count;
}

// Game mode enum — 'standard' for regular games, 'battle' for persistent weekly battles.
export const GameMode = Object.freeze({
  STANDARD: 'standard',
  BATTLE:   'battle',
});

// Win reason strings (shown in game-over overlay)
export const WIN_REASON = {
  WITCH_SLAIN:      'The hero hunted down the witch and ended the curse!',
  HERO_SLAIN:       'The hero fell in battle. Caleb\'s Hollow is lost to darkness.',
  SCORE_WITCH:      'The witch dominates the Power Nodes across three cycles — the ritual is complete!',
  SCORE_HERO:       'The hero holds the Power Nodes through the darkness — the curse is broken!',
  BATTLE_HERO:      'The week-long Battle for Caleb\'s Hollow ends — the heroes prevail!',
  BATTLE_WITCH:     'The week-long Battle for Caleb\'s Hollow ends — the witches claim victory!',
  BATTLE_DRAW:      'The Battle for Caleb\'s Hollow ends in a stalemate — neither side prevails.',
};

// ── Phase cycle ─────────────────────────────────────────────────────────────
// Default cycle = 8 rounds: DAWN(1) → DAY(3) → DUSK(1) → NIGHT(3)
// Campaign missions may override this with a custom cycleConfig.
// Attrition schedule lives in src/post-round-effects.js (attritionForCycle).
const CYCLE_LENGTH = 8;

export const Phase = Object.freeze({
  DAWN:  'dawn',
  DAY:   'day',
  DUSK:  'dusk',
  NIGHT: 'night',
});

/** Default 8-step phase sequence — used when no custom cycleConfig is set. */
export const DEFAULT_CYCLE_PHASES = Object.freeze([
  Phase.DAWN, Phase.DAY, Phase.DAY, Phase.DAY,
  Phase.DUSK, Phase.NIGHT, Phase.NIGHT, Phase.NIGHT,
]);

/** Effective cycle length, respecting custom cycleConfig if present. */
export function getCycleLength(cycleConfig = null) {
  return cycleConfig?.phases?.length ?? CYCLE_LENGTH;
}

/** @deprecated Use string literals 'hero'/'witch' or getFaction(id) instead. */
export const Player = Object.freeze({ HERO: 'hero', WITCH: 'witch' });

// Calculate actions for a player at the start of their turn.
// Hero  — base 3 + 1 in DAWN/DAY + 1 per survivor (cap +5) + 1 per held power node; hard cap 8
// Witch — base 3 + 1 in NIGHT + 1 per unit (cap +3) + 1 per held power node; hard cap 10
export function computeActions(player, phase, entities, nodeBonus = 0) {
  const faction    = getFaction(player);
  const extras     = entities.filter(e => e.alive && e.owner === faction.id && e.type !== faction.leaderType).length;
  return faction.computeBudget(phase, extras, nodeBonus);
}

/**
 * Compute the action budget for one specific player (multiplayer path).
 * Counts only entities owned by that player (ownerId match), not the whole faction.
 */
export function computeActionsForPlayer(playerId, faction, phase, entities, nodeBonus = 0) {
  const factionObj = getFaction(faction);
  const extras = entities.filter(
    e => e.alive && e.ownerId === playerId && e.type !== factionObj.leaderType
  ).length;
  return factionObj.computeBudget(phase, extras, nodeBonus);
}

function phaseForRound(round, cycleConfig = null) {
  if (!cycleConfig) {
    const r = (round - 1) % CYCLE_LENGTH;
    if (r === 0)            return Phase.DAWN;
    if (r >= 1 && r <= 3)  return Phase.DAY;
    if (r === 4)            return Phase.DUSK;
    return Phase.NIGHT;
  }
  const { phases, loop } = cycleConfig;
  const idx = round - 1;
  if (loop) return phases[idx % phases.length];
  return phases[Math.min(idx, phases.length - 1)];
}

const PHASE_ICON = {
  [Phase.DAWN]:  '🌅',
  [Phase.DAY]:   '☀',
  [Phase.DUSK]:  '🌇',
  [Phase.NIGHT]: '🌙',
};

export { PHASE_ICON, phaseForRound, CYCLE_LENGTH };

export class GameState {
  /**
   * @param {boolean} witchIsAI
   * @param {boolean} heroIsAI
   * @param {string}  mapSize
   * @param {number|null} nodeCount
   * @param {object|null} mapDataOverride  Pre-built map data (e.g. from tutorial or campaign configs).
   *   When provided, generateMap() is skipped. Must include { tiles, witchObjectives,
   *   heroStart, witchStart, mapSize, survivorCounts, cols?, rows? }.
   */
  constructor(witchIsAI = true, heroIsAI = false, mapSize = 'standard', nodeCount = null, mapDataOverride = null) {
    // Per-instance entity/roster/dice state. Previously module-level globals
    // in entities.js which caused cross-game collisions on the server.
    this.nextEntityId       = 1;
    this.forcedDice         = [];
    this.usedRosterIndices  = new Set();

    // Legacy: also reset the module-level roster used by editor previews and
    // tests that call createSurvivor() without a state. Can be removed once
    // those callsites are migrated.
    resetRoster();

    let mapData;
    if (mapDataOverride) {
      if (mapDataOverride.cols && mapDataOverride.rows) {
        setMapDimensions(mapDataOverride.cols, mapDataOverride.rows);
      }
      mapData = mapDataOverride;
    } else {
      mapData = generateMap(undefined, mapSize, nodeCount);
    }
    this.tiles     = mapData.tiles;
    this.entities  = [];
    this.witchIsAI = witchIsAI;
    this.heroIsAI  = heroIsAI;

    // Fog of war mode: 'none' | 'partial'
    //   none    — everything visible
    //   partial — terrain visible, enemies hidden outside sight range
    this.fogOfWar = (witchIsAI || heroIsAI) ? 'partial' : 'none';

    // Hexes that have been seen at least once per faction (full fog memory).
    // { [factionId]: Set<hexKey> } — persisted via state-sync.
    this.exploredHexes = Object.fromEntries(allFactions().map(f => [f.id, new Set()]));

    // Per-mission loot table overrides (campaign only). null = use defaults.
    // Shape: { remove?: string[], buildings?: {[key]: table}, terrain?: {[key]: table} }
    this.lootOverrides = null;

    // Human-vs-AI difficulty tier: 'easy' | 'normal' | 'hard'. Scales how many
    // actions AI engines plan per round (see AI_DIFFICULTY_BUDGET_DELTA in
    // src/ai.js). 'normal' is the tuned balance baseline.
    this.aiDifficulty = 'normal';

    // ── Player registry (multiplayer) ──────────────────────────────────────
    // Each entry: { id, name, faction, isAI, leaderId }
    // Populated by addPlayer() for online games; pre-populated here for offline.
    this.players = [];

    // Offline / legacy path: create one hero and one witch with synthetic player IDs.
    const heroName = mapDataOverride?.heroName ?? 'Ishmael Charger';
    const witchName = mapDataOverride?.witchName ?? 'Witch';
    this.hero  = getFaction('hero').createLeader(mapData.heroStart.col,  mapData.heroStart.row, 'hero', this);
    this.hero.name = heroName;
    this.entities.push(this.hero);
    this.players.push({ id: 'hero',  name: heroName,  faction: 'hero',  isAI: heroIsAI,  leaderId: this.hero.id });

    // Witch is optional — campaign missions may omit the witch entity entirely.
    if (mapDataOverride?.noWitch) {
      this.witch = null;
      this.players.push({ id: 'witch', name: witchName, faction: 'witch', isAI: true, leaderId: null });
    } else {
      this.witch = getFaction('witch').createLeader(mapData.witchStart.col, mapData.witchStart.row, 'witch', this);
      this.witch.name = witchName;
      this.entities.push(this.witch);
      this.players.push({ id: 'witch', name: witchName, faction: 'witch', isAI: witchIsAI, leaderId: this.witch.id });
    }
    // Persistent mission-mode flag. Consumers (AI sight, pursuit radius) must
    // check this rather than probing live entity state, so a witch dying
    // mid-mission in some future scenario doesn't silently flip behaviour.
    this.noWitchMission = !!mapDataOverride?.noWitch;

    this.inventory = {
      hero:  { ...getFaction('hero').getStartingResources() },
      witch: { ...getFaction('witch').getStartingResources() },
    };

    this.mapSize       = mapData.mapSize;
    this.season        = mapData.season ?? null;
    this._survivorCounts = mapData.survivorCounts;
    this.witchObjectives = mapData.witchObjectives;
    this.missionTargetHex = mapData.targetHex
      ? { col: mapData.targetHex.col, row: mapData.targetHex.row,
          color: '#d4a857', label: 'Objective', seen: false }
      : null;
    this._heroStart  = { col: mapData.heroStart.col,  row: mapData.heroStart.row };
    this._witchStart = mapData.witchStart
      ? { col: mapData.witchStart.col, row: mapData.witchStart.row }
      : null;
    this._placeHiddenSurvivors();
    this.updateNodeDiscovery();

    this.round        = 1;
    this.phase        = Phase.DAWN;
    this.activePlayer = 'hero';
    this.actionsLeft  = computeActions('hero', Phase.DAWN, []);
    this.log = [
      `🌅 Dawn breaks over Caleb's Hollow. ${this.hero.displayName} stirs at the Inn.`,
    ];
    if (this.witchObjectives.length > 0) {
      this.log.push(
        `${this.witchObjectives.length} Power Node${this.witchObjectives.length !== 1 ? 's' : ''}: ${this.witchObjectives.map(o => o.label).join(', ')}.`,
        `⚔ Hold 2+ nodes at each dawn/dusk to score. First to 4 points wins. Three cycles — then darkness claims Caleb's Hollow.`,
      );
    }

    this.selectedEntity    = null;
    this.pendingAction     = null;
    this.winner            = null;
    this.winReason         = null;
    this.postRoundEvents   = []; // structured PostRoundEvent[] from post-round-effects pipeline
    this.nodeSpawnedSurvivors = []; // encounter objects for survivors spawned at power nodes

    // ── Cumulative stats counters (for game-stats tracking) ──────────────────
    this.heroKills        = 0; // entities killed by hero side (combat + hazards)
    this.witchKills       = 0; // entities killed by witch side (combat + hazards)
    this.witchSummonCount = 0; // total summons performed by witch side
    this.heroRevealedByHorn = false; // true when hero sounded horn this round

    // Cumulative node scoring: each dawn/dusk majority scores 1 point; first to 4 wins.
    this.nodeScore = { hero: 0, witch: 0 };
    // When true, skip dawn/dusk node scoring and hide the score track UI.
    this.disableScoring = !!mapDataOverride?.disableScoring;
    // When true, hide the day/night cycle indicator pill above the score bar.
    // Independent of disableScoring so a mission can show the cycle without
    // exposing point-based scoring (campaign missions with phase-based wins).
    this.disableCycleBar = !!mapDataOverride?.disableCycleBar;
    // Score threshold for the standard "first to N points wins" rule.
    // Defaults to 4 (multiplayer baseline); campaign missions can raise it.
    this.nodeScoreThreshold = mapDataOverride?.nodeScoreThreshold ?? 4;
    // When true, the engine's built-in "first to N points wins" rule is
    // disabled — the mission's victory delegate drives win/lose entirely
    // (e.g. M7 — kill the witch before she scores 5 points; her hitting 5
    // is a *loss* condition, not a win).
    this.disableScoreWin = !!mapDataOverride?.disableScoreWin;

    // Max survivors discoverable from hidden-survivor tiles (null = unlimited).
    this.maxDiscoverableSurvivors = mapDataOverride?.maxDiscoverableSurvivors ?? null;
    this.discoveredSurvivorCount  = 0;

    // True only for single-player campaign missions. Gates campaign-only
    // mechanics (XP/veterancy via awardXP). Set by main.js at mission start and
    // round-tripped through state-sync so mid-mission resume preserves it.
    // Left false for normal/online/skirmish games.
    this.isCampaign = false;

    // ── Game mode ──────────────────────────────────────────────────────────
    // 'standard' = normal game; 'battle' = persistent weekly Battle for Caleb's Hollow.
    this.gameMode = mapDataOverride?.gameMode ?? GameMode.STANDARD;

    // Battle-mode config (only meaningful when gameMode === 'battle').
    // endsAt: unix timestamp (seconds) when the week-long battle ends.
    // maxPlayersPerSide: hard cap on players per faction.
    this.battleConfig = mapDataOverride?.battleConfig ?? null;

    // ── Campaign / custom victory ──────────────────────────────────────────
    // When set, checked first by checkVictory(). Return { winner, winReason, log? } or null.
    this.victoryDelegate = null;

    // ── Mission logic graph (docs/09) ──────────────────────────────────────
    // Optional event→action engine driving scripted mission content. Null for
    // every normal/online game, so the pump points below are byte-identical
    // no-ops unless a mission opts in via a `logic` block. The engine is
    // re-attached by the mission loader on resume; its runtime state rides
    // along in state-sync as `logicState`.
    this.logicEngine = null;
    // Presentation events emitted by SHOW/SIM nodes, drained + animated by the
    // client orchestrator (main.js). Transient — never serialized.
    this.logicPresentation = [];

    // Custom phase cycle (campaign missions). null = use default 8-step cycle.
    // Shape: { phases: string[], loop: boolean }
    this.cycleConfig = null;

    // Attrition level: hazard damage dealt to exposed units (see attritionForCycle).
    this.attritionLevel    = 1;
    this.attritionChanged  = false; // true for exactly one planning phase after a level-up

    // ── Simultaneous-turn planning state ──────────────────────────────────
    // planningPhase: true while both sides are building their action plans.
    // resolving:     true while the resolver is executing paired steps.
    //
    // Legacy 2-player fields (offline mode / backward compat):
    this.planningPhase  = false;
    this.resolving      = false;
    this.heroPlan       = null;
    this.witchPlan      = null;
    this.heroReady      = false;
    this.witchReady     = false;
    this.heroActionsLeft  = 0;
    this.witchActionsLeft = 0;
    //
    // Multiplayer per-player fields:
    // playerPlans: Map<playerId, PlanAction[]>
    // playerReady: Map<playerId, bool>
    // playerActionsLeft: Map<playerId, number>
    this.playerPlans        = new Map();
    this.playerReady        = new Map();
    this.playerActionsLeft  = new Map();
    // Deadline timestamp for the current planning phase (ms since epoch, or null)
    this.planningDeadline   = null;
  }

  // ── Turn management ────────────────────────────────────────────────────

  get actionsAvailable() {
    return this.actionsLeft;
  }

  spendAction(cost = 1) {
    this.actionsLeft = Math.max(0, this.actionsLeft - cost);
  }

  // ── Entity ID / dice / roster (per-instance, concurrent-game-safe) ─────

  /** Next entity ID number. Entity constructor prefixes with "e". */
  allocateEntityId() {
    const id = this.nextEntityId++;
    // Keep the module-level legacy counter at or above this state's counter
    // so standalone createFoo() calls (no state) never collide with state
    // entities. Tests and editor previews rely on this invariant.
    _bumpModuleEntityId(id);
    return id;
  }

  /** Ensure the next allocated id is greater than the given numeric id. */
  bumpEntityId(minNumericId) {
    if (minNumericId >= this.nextEntityId) this.nextEntityId = minNumericId + 1;
    _bumpModuleEntityId(minNumericId);
  }

  /** Queue forced dice values for scripted (tutorial) combat outcomes. */
  setForcedDice(...values) {
    this.forcedDice = [...values];
  }

  /** Pop the next forced die, or roll a random 1..sides. */
  nextDie(sides) {
    if (this.forcedDice.length > 0) return this.forcedDice.shift();
    return Math.ceil(Math.random() * sides);
  }

  /** Clear the used-roster tracker (call at game start / between missions). */
  resetRoster() {
    this.usedRosterIndices.clear();
  }

  /** Mark a survivor roster index as used (by the name shown in the roster). */
  markRosterUsedByName(name) {
    const idx = survivorRosterIndexByName(name);
    if (idx >= 0) this.usedRosterIndices.add(idx);
  }

  // ── Player registry (multiplayer) ──────────────────────────────────────

  /**
   * Register a player and create their leader entity at the given position.
   * Used by the multiplayer lobby when building a room with N players.
   * Returns the created leader entity.
   *
   * @param {string} playerId  - UUID of the player
   * @param {string} name      - Display name
   * @param {'hero'|'witch'} faction
   * @param {number} col
   * @param {number} row
   * @param {boolean} isAI
   */
  /**
   * Add a player and create their leader entity.
   *
   * @param {string} playerId
   * @param {string} name
   * @param {string} faction    side-default faction id ('hero' or 'witch') — wire-compat
   * @param {number} col
   * @param {number} row
   * @param {boolean} [isAI=false]
   * @param {string} [factionId=null]  specific faction id (e.g. 'rogue'). Defaults
   *                                   to `faction`. When set to a stub faction
   *                                   id, the leader gets the stub's entity type
   *                                   and stats via Faction.createLeader.
   */
  addPlayer(playerId, name, faction, col, row, isAI = false, factionId = null) {
    const def = getFaction(factionId ?? faction);
    const leader = def.createLeader(col, row, playerId, this);
    leader.name = name;
    this.entities.push(leader);
    this.players.push({ id: playerId, name, faction, isAI, leaderId: leader.id, factionId: def.id });
    // Keep legacy singleton refs pointing at the first hero/witch leader for
    // offline compat. Stub-faction leaders also satisfy these — `state.hero`
    // continues to mean "the day-side leader" regardless of specific faction.
    if (faction === 'hero'  && !this.hero)  this.hero  = leader;
    if (faction === 'witch' && !this.witch) this.witch = leader;
    return leader;
  }

  /** Return the display name of the primary leader for a faction. */
  factionName(faction) {
    const leader = faction === 'hero' ? this.hero : this.witch;
    return leader?.displayName ?? (faction === 'hero' ? 'Ishmael Charger' : 'The Witch');
  }

  // ── Side-keyed accessors ───────────────────────────────────────────────
  // Side ('day' | 'night') is the level at which inventory, actions, kills,
  // and node scoring are pooled. New factions on the same side share this
  // pool. These accessors today route to the legacy `hero` / `witch` storage
  // keys via `_storageKeyForSide()`; the storage rename is queued behind
  // the save-schema bump in PR 4. See docs/design/faction-expansion.md.

  _storageKeyForSide(sideId) {
    if (sideId === 'day')   return 'hero';
    if (sideId === 'night') return 'witch';
    throw new Error(`Unknown side: ${sideId}`);
  }

  /**
   * Swap a leader entity in place to match the supplied faction id.
   *
   * By default targets the constructor-pre-populated side singleton
   * (`'day'` → `state.hero`, `'night'` → `state.witch`); callers may pass
   * `targetEntity` to re-stat an extra-seat leader on the same side (the
   * headless runner uses this).
   *
   * No-op when:
   *  - `factionId` is falsy
   *  - the faction id isn't registered on the given side
   *  - the target leader is already on this faction
   *
   * Mutates the live leader in place — id, position, ownerId, color are
   * preserved so downstream references (state.hero, plan-action target
   * lookups, save/replay round entity ids) continue to resolve. Copies
   * the new faction's `type`, base stats (HP/ATK/DEF), `range`,
   * `agility`, `factionId`, and the `Faction.createLeader`-stamped
   * abilities. Clears `name` so `Entity.displayName` falls through to
   * the new type's default.
   *
   * Does NOT copy `attackBonus`, `defenseBonus`, `weapon`, `items`, or
   * any per-turn flags — latent if anyone ever calls swap mid-game;
   * currently safe because seats are constructed fresh.
   *
   * @param {string} sideId — 'day' | 'night'
   * @param {string} factionId — any faction id registered on the side
   * @param {object|null} targetEntity — leader to mutate (defaults to side singleton)
   */
  swapLeaderToFaction(sideId, factionId, targetEntity = null) {
    if (!factionId) return;
    const def = getFactionsForSide(sideId).find(f => f.id === factionId);
    if (!def) return;

    const leader = targetEntity ?? (sideId === 'day' ? this.hero : this.witch);
    if (!leader) return;

    // No-op when swapping to the leader's current faction — preserves
    // assigned name and avoids redundant ability re-stamping.
    if (leader.factionId === def.id || leader.type === def.leaderType) return;

    const fresh = def.createLeader(leader.col, leader.row, leader.ownerId, this);
    leader.type      = fresh.type;
    leader.maxHp     = fresh.maxHp;
    leader.hp        = fresh.maxHp;       // full-heal on swap (game just started)
    leader.attack    = fresh.attack;
    leader.defense   = fresh.defense;
    leader.agility   = fresh.agility;
    // Adopt the new faction's starting weapon (Paladin sword → Rogue bow,
    // etc.). The fresh leader already has it equipped in its items; route the
    // id through equipWeapon so range/stats recompose from the new weapon.
    leader.equipWeapon(fresh.getEquippedWeaponId());
    leader.factionId = fresh.factionId;
    // Faction.createLeader already stamped innate abilities on `fresh`.
    // Replace the leader's ability list to drop any abilities that the
    // new faction has stripped (e.g. RogueFaction returning [] strips
    // sound_horn from a paladin → rogue swap), then re-add survivor-style
    // abilities the leader had picked up at runtime (none today, but
    // this is the natural extension point).
    leader.abilities = [...(fresh.abilities || [])];
    // Clear the constructor-assigned name ('Ishmael Charger' for the day
    // side default, 'Witch' for night) so Entity.displayName falls through
    // to the new type's default (e.g. 'Mercy Sloane' for ROGUE).
    leader.name = null;
  }

  /** Resource inventory shared by all factions on the given side. */
  inventoryForSide(sideId)   { return this.inventory[this._storageKeyForSide(sideId)]; }

  /** Actions remaining for the given side this planning phase (legacy 2-player budget). */
  actionsLeftForSide(sideId) {
    return sideId === 'day' ? this.heroActionsLeft : this.witchActionsLeft;
  }

  /** Cumulative kills credited to the given side. */
  killsForSide(sideId)       { return sideId === 'day' ? this.heroKills : this.witchKills; }

  /** Increment the kill counter for the given side by `n` (default 1). */
  recordKillForSide(sideId, n = 1) {
    if (sideId === 'day')   this.heroKills  += n;
    if (sideId === 'night') this.witchKills += n;
  }

  /** Cumulative summons performed by the given side. (Day side: 0 today.) */
  summonsForSide(sideId)     { return sideId === 'night' ? this.witchSummonCount : 0; }

  /** Increment the summon counter for the given side by `n` (default 1). */
  recordSummonForSide(sideId, n = 1) {
    if (sideId === 'night') this.witchSummonCount += n;
    // Day side has no summon mechanic today — counter is not tracked.
  }

  /** Cumulative node-scoring points held by the given side. */
  nodeScoreForSide(sideId)   { return this.nodeScore[this._storageKeyForSide(sideId)]; }

  /** Return the leader entity for a given playerId (or null if dead/missing). */
  getLeader(playerId) {
    const p = this.players.find(pl => pl.id === playerId);
    if (!p) return null;
    return this.entities.find(e => e.id === p.leaderId && e.alive) ?? null;
  }

  /** Return all entities owned by a given playerId. */
  getPlayerEntities(playerId) {
    return this.entities.filter(e => e.alive && e.ownerId === playerId);
  }

  /** Return true if every player on the given faction is eliminated. */
  factionEliminated(faction) {
    const factionPlayers = this.players.filter(p => p.faction === faction);
    // A faction with no leader (e.g. no-witch campaign mission) cannot be eliminated.
    if (factionPlayers.every(p => p.leaderId === null)) return false;
    return factionPlayers
      .every(p => p.leaderId === null || !this.entities.some(e => e.id === p.leaderId && e.alive));
  }

  // ── Simultaneous-turn planning API ─────────────────────────────────────

  /**
   * Begin a new planning phase.
   * Populates both the legacy 2-player fields (heroActionsLeft / witchActionsLeft)
   * and the per-player maps used by the multiplayer resolver.
   */
  startPlanning() {
    // First-round hook: final player count is now known (all addPlayer calls
    // have completed). Scale the hidden-survivor pool to the team size so
    // NvN hero teams don't compound recruitment from a fixed 1v1 pool.
    if (this.round === 1) this._rebalanceHiddenSurvivorsForTeamSize();

    this.planningPhase    = true;
    this.resolving        = false;
    this.heroPlan         = null;
    this.witchPlan        = null;
    this.heroReady        = false;
    this.witchReady       = false;
    this.heroRevealedByHorn = false;

    // Power-node bonus: +1 action per node the faction controls
    const heroNodeBonus  = countHeldNodes('hero',  this.witchObjectives, this.entities);
    const witchNodeBonus = countHeldNodes('witch', this.witchObjectives, this.entities);

    // Legacy faction-level budgets (offline mode)
    this.heroActionsLeft  = computeActions('hero',  this.phase, this.entities, heroNodeBonus);
    this.witchActionsLeft = computeActions('witch', this.phase, this.entities, witchNodeBonus);

    // Per-player budgets (multiplayer)
    this.playerPlans       = new Map();
    this.playerReady       = new Map();
    this.playerActionsLeft = new Map();

    // Battle mode: spawn respawning players before computing budgets
    if (this.gameMode === GameMode.BATTLE) {
      this._spawnRespawningPlayers();
    }

    // Battle mode: compute faction imbalance bonus
    // Each player on the smaller faction gets +1 per missing-player deficit
    let battleBonus = { hero: 0, witch: 0 };
    if (this.gameMode === GameMode.BATTLE) {
      const heroAlive  = this.players.filter(p => p.faction === 'hero'  && this.getLeader(p.id)).length;
      const witchAlive = this.players.filter(p => p.faction === 'witch' && this.getLeader(p.id)).length;
      const diff = Math.abs(heroAlive - witchAlive);
      if (heroAlive < witchAlive) battleBonus.hero  = diff;
      if (witchAlive < heroAlive) battleBonus.witch = diff;
    }

    for (const p of this.players) {
      // Battle mode: skip dead players (no leader alive, not respawning this round)
      if (this.gameMode === GameMode.BATTLE && !this.getLeader(p.id)) {
        this.playerReady.set(p.id, true); // auto-ready (can't plan)
        this.playerActionsLeft.set(p.id, 0);
        continue;
      }
      this.playerReady.set(p.id, false);
      const nb = p.faction === 'hero' ? heroNodeBonus : witchNodeBonus;
      let budget = computeActionsForPlayer(p.id, p.faction, this.phase, this.entities, nb);
      budget += battleBonus[p.faction] ?? 0;
      this.playerActionsLeft.set(p.id, budget);
    }

    const heroNB  = heroNodeBonus  ? ` (incl. +${heroNodeBonus} node)` : '';
    const witchNB = witchNodeBonus ? ` (incl. +${witchNodeBonus} node)` : '';
    const heroBB  = battleBonus.hero  ? ` (+${battleBonus.hero} underdog)` : '';
    const witchBB = battleBonus.witch ? ` (+${battleBonus.witch} underdog)` : '';
    this.addLog(
      `📋 Planning phase — Hero: ${this.heroActionsLeft} actions${heroNB}${heroBB}, ` +
      `Witch: ${this.witchActionsLeft} actions${witchNB}${witchBB}.`
    );
  }

  /**
   * Battle mode: spawn fresh leaders for players who requested respawn last round.
   * Called at the start of each planning phase.
   */
  _spawnRespawningPlayers() {
    for (const p of this.players) {
      if (p.respawnRound && p.respawnRound <= this.round) {
        // Pick a spawn position in the faction's starting columns
        const spawnPos = this._pickBattleSpawn(p.faction);
        if (spawnPos) {
          const leader = getFaction(p.faction).createLeader(spawnPos.col, spawnPos.row, p.id, this);
          leader.name = p.name;
          this.entities.push(leader);
          p.leaderId = leader.id;
          this.addLog(`⚡ ${p.name} has rejoined the battle!`);
        }
        delete p.respawnRound;
      }
    }
  }

  /**
   * Pick a spawn tile at a faction building for battle-mode respawns.
   * Heroes respawn at INNs; witches at GRAVEYARDs.
   * Prefers unoccupied building tiles; falls back to a neighbor of a building.
   */
  _pickBattleSpawn(faction) {
    const targetBuilding = faction === 'hero' ? BuildingType.INN : BuildingType.GRAVEYARD;
    const buildings = [];
    for (const [, t] of this.tiles) {
      if (hasBuilding(t) && t.building === targetBuilding) {
        buildings.push({ col: t.col, row: t.row });
      }
    }

    // Fallback to edge-column logic if no faction buildings exist
    if (buildings.length === 0) {
      const cols = faction === 'hero' ? [0, 1, 2] : [MAP_COLS - 3, MAP_COLS - 2, MAP_COLS - 1];
      const candidates = [];
      for (const [, t] of this.tiles) {
        if (!cols.includes(t.col) || isRiver(t)) continue;
        const occupied = this.entities.some(e => e.alive && e.col === t.col && e.row === t.row);
        if (!occupied) candidates.push({ col: t.col, row: t.row });
      }
      return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    }

    // Shuffle buildings for randomness
    for (let i = buildings.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [buildings[i], buildings[j]] = [buildings[j], buildings[i]];
    }

    // Prefer an unoccupied building tile
    for (const b of buildings) {
      const occupied = this.entities.some(e => e.alive && e.col === b.col && e.row === b.row);
      if (!occupied) return b;
    }

    // All buildings occupied — pick an unoccupied neighbor of any building
    for (const b of buildings) {
      for (const n of getNeighbors(b.col, b.row)) {
        const t = this.tiles.get(hexKey(n.col, n.row));
        if (!t || isRiver(t)) continue;
        const occupied = this.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
        if (!occupied) return { col: n.col, row: n.row };
      }
    }

    return buildings[0]; // last resort
  }

  /**
   * Submit a faction's plan (legacy offline / 2-player path).
   * @param {'hero'|'witch'} faction
   * @param {import('./planner.js').PlanAction[]} plan
   * @returns {boolean} true when both factions have submitted
   */
  submitPlan(faction, plan) {
    if (!this.planningPhase) throw new Error('Not in planning phase.');
    if (faction === 'hero') {
      this.heroPlan  = plan;
      this.heroReady = true;
      this.addLog(`⚔ Hero submits their plan (${plan.length} step${plan.length !== 1 ? 's' : ''}).`);
    } else {
      this.witchPlan  = plan;
      this.witchReady = true;
      this.addLog(`✦ Witch submits their plan (${plan.length} step${plan.length !== 1 ? 's' : ''}).`);
    }
    if (this.heroReady && this.witchReady) {
      this.planningPhase = false;
      this.resolving     = true;
      return true;
    }
    return false;
  }

  /**
   * Submit an individual player's plan (multiplayer path).
   * @param {string} playerId
   * @param {import('./planner.js').PlanAction[]} plan
   * @returns {boolean} true when ALL players have submitted
   */
  submitPlayerPlan(playerId, plan) {
    // Note: the planningPhase guard is intentionally removed here — the server
    // uses room.phase (RoomPhase enum) as the single source of truth.  Checking
    // state.planningPhase caused desync crashes when the legacy flag drifted
    // out of sync with room.phase.
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error(`Unknown player: ${playerId}`);
    if (this.playerReady.get(playerId)) {
      // Silently ignore duplicate submissions instead of throwing
      return [...this.playerReady.values()].every(Boolean);
    }

    this.playerPlans.set(playerId, plan);
    this.playerReady.set(playerId, true);

    const icon = player.faction === 'hero' ? '⚔' : '✦';
    this.addLog(`${icon} ${player.name} submits their plan (${plan.length} step${plan.length !== 1 ? 's' : ''}).`);

    return [...this.playerReady.values()].every(Boolean);
  }

  /** True if every registered player has submitted their plan. */
  get allPlayersReady() {
    return this.players.length > 0 && [...this.playerReady.values()].every(Boolean);
  }

  /**
   * Post-resolution finalization shared by the offline (`src/main.js`) and
   * online (`server/lobby.js`) orchestrators so the two cannot drift. Runs the
   * fixed sequence of node-discovery → control-change logging → explored-hex
   * update → endRound. Both call sites previously inlined these four calls; if
   * one path added a step the other would silently miss it.
   */
  finalizeRound() {
    this.updateNodeDiscovery();
    this.checkAndLogNodeControlChanges();
    this.updateExploredHexes();
    this.endRound(); // invokes _waveProcessor before checkVictory (see below)
  }

  /**
   * Apply end-of-round effects after resolution: rest healing, night/day node
   * spawns, phase advance, hazards, attrition, and node scoring.
   * Works for both 1v1 (offline) and N-vs-N (online multiplayer).
   */
  endRound() {
    this.resolving = false;

    // Side-level end-of-round effects (healing, spawning, etc.). With stub
    // factions inheriting their parent side's behaviour, iterating
    // `allFactions()` here would fire each side's effects once per faction
    // on that side — see PR 5 of docs/design/faction-expansion.md. We
    // iterate sides instead and dispatch on each side's primary faction.
    for (const sideId of allSides()) {
      const primary = getFactionsForSide(sideId)[0];
      if (primary) primary.applyEndOfRoundEffects(this);
    }

    // Advance round and phase.
    this.entities.forEach(e => e.resetTurn());
    this.round++;
    const prevPhase = this.phase;
    this.phase = phaseForRound(this.round, this.cycleConfig);

    if (this.phase !== prevPhase) {
      this._announcePhaseChange(prevPhase, this.phase);
    } else {
      this.addLog(
        `Round ${this.round} — ${PHASE_ICON[this.phase]} ${this.phase.toUpperCase()}`
      );
    }

    // Post-round effects (night attrition, etc.)
    this.postRoundEvents = applyPostRoundEffects(this);

    if (this.phase === Phase.DAWN) {
      const effectiveCycleLength = this.cycleConfig?.phases?.length ?? CYCLE_LENGTH;
      const cycle    = Math.ceil(this.round / effectiveCycleLength);
      const newLevel = attritionForCycle(cycle);
      this.attritionChanged = newLevel !== this.attritionLevel;
      this.attritionLevel   = newLevel;
      if (this.attritionChanged && newLevel > 0) {
        this.addLog(`🌅 A new dawn — cycle ${cycle}. The curse deepens! Hazard damage rises to ${newLevel}.`);
      } else {
        this.addLog(`🌅 A new dawn — cycle ${cycle}.`);
      }
      for (const [, t] of this.tiles) t.explored = false;
      if (!this.disableScoring) this._checkNodeObjectives(Phase.DAWN);
    }
    if (this.phase === Phase.DUSK) {
      if (!this.disableScoring) this._checkNodeObjectives(Phase.DUSK);
    }

    // Mission opt-in: score on additional phases (e.g. NIGHT for "prolonged
    // night" missions). Inert when cycleConfig is absent or doesn't list extras.
    const extraScoring = this.cycleConfig?.extraScoringPhases;
    if (extraScoring && !this.disableScoring
        && this.phase !== Phase.DAWN && this.phase !== Phase.DUSK
        && extraScoring.includes(this.phase)) {
      this._checkNodeObjectives(this.phase);
    }

    // Battle mode: score every round (not just dawn/dusk)
    if (this.gameMode === GameMode.BATTLE && !this.disableScoring
        && this.phase !== Phase.DAWN && this.phase !== Phase.DUSK) {
      this._checkBattleNodeScoring();
    }

    // Campaign wave processor — runs BEFORE checkVictory so triggered spawns
    // (e.g. Mission 1's kill-triggered golem) can pre-empt an `eliminate_all`
    // win that would otherwise fire when the last existing enemy dies on the
    // same round the wave should spawn. Non-campaign games don't set this.
    if (this._waveProcessor) {
      const waveLogs = this._waveProcessor();
      if (waveLogs) for (const msg of waveLogs) this.addLog(msg);
    }

    // Mission logic graph — post-resolution events (kill counts, area transitions,
    // faction deaths). Runs BEFORE checkVictory so graph-driven spawns can pre-empt
    // a premature win, exactly like the wave processor. Inert without an engine.
    if (this.logicEngine) this.pumpMissionLogic('postResolution');

    this.checkVictory();
  }

  /** Attach a MissionLogicEngine (docs/09). The engine's WorldContext should
   *  push presentation events onto this.logicPresentation. */
  attachLogicEngine(engine) { this.logicEngine = engine; }

  /**
   * Fire the mission-logic events appropriate to a lifecycle hook and return the
   * presentation events newly queued (the caller drains + animates them):
   *   'missionStart'   — once, at mission init.
   *   'roundStart'     — at each planning-phase start (round/phase/area-enter).
   *   'postResolution' — after a round resolves (kills, area, faction deaths).
   * No-op without an attached engine.
   */
  pumpMissionLogic(hook) {
    const eng = this.logicEngine;
    if (!eng) return [];
    const start = this.logicPresentation.length;
    if (hook === 'missionStart') {
      eng.dispatch('missionStart', {});
      this._dispatchActorTransitions(); // OnSpawn for pre-placed ref'd units
    } else if (hook === 'roundStart') {
      eng.dispatch('roundStart', { round: this.round, phase: this.phase });
      eng.dispatch('phase', { phase: this.phase });
      this._dispatchAreaTransitions();
      this._dispatchActorTransitions();
    } else if (hook === 'postResolution') {
      eng.dispatch('killCount', { faction: 'hero', count: this.heroKills });
      eng.dispatch('killCount', { faction: 'witch', count: this.witchKills });
      this._dispatchAreaTransitions();
      this._dispatchActorTransitions(); // OnDeath for ref'd units that died
      // onAllUnitsDead = zero ALIVE units of the faction (works for missions with
      // no faction leader, e.g. a zombie-only board); onLeaderDead = leader gone.
      for (const f of ['hero', 'witch']) {
        if (this.entities.every(e => !(e.alive && e.owner === f))) eng.dispatch('factionAllDead', { faction: f });
        if (this.factionEliminated(f)) eng.dispatch('factionLeaderDead', { faction: f });
      }
    }
    return this.logicPresentation.slice(start);
  }

  /** Dispatch areaEnter/areaExit for units that crossed an Area Trigger boundary
   *  since the last check (true OnEnter/OnExit, so triggers don't re-fire while a
   *  unit lingers). Occupancy is tracked lazily (not serialized — a resume may
   *  re-fire OnEnter once, which the graph's Do Once gates absorb). */
  _dispatchAreaTransitions() {
    const eng = this.logicEngine;
    const hexKeys = eng.areaHexKeys();
    if (!hexKeys || hexKeys.size === 0) return;
    if (!this._logicAreaState) this._logicAreaState = new Map();
    for (const e of this.entities) {
      if (!e.alive) continue;
      const inside = hexKeys.has(`${e.col},${e.row}`);
      const was = this._logicAreaState.get(e.id) ?? false;
      if (inside && !was) eng.dispatch('areaEnter', { unit: e, hex: { col: e.col, row: e.row } });
      else if (!inside && was) eng.dispatch('areaExit', { unit: e, hex: { col: e.col, row: e.row } });
      this._logicAreaState.set(e.id, inside);
    }
  }

  /** Dispatch actorSpawn/actorDeath for units watched by Actor nodes (matched by
   *  entity.ref or entity.npcId). Tracks per-ref alive state so each fires once. */
  _dispatchActorTransitions() {
    const eng = this.logicEngine;
    const refs = eng.actorRefs();
    if (!refs || refs.size === 0) return;
    if (!this._logicActorState) this._logicActorState = new Map();
    const aliveByRef = new Map();
    for (const e of this.entities) {
      const ref = e.ref ?? e.npcId;
      if (ref != null && refs.has(ref) && e.alive) aliveByRef.set(ref, e);
    }
    for (const ref of refs) {
      const e = aliveByRef.get(ref);
      const was = this._logicActorState.get(ref) ?? false;
      if (e && !was) eng.dispatch('actorSpawn', { ref, entity: e, hex: { col: e.col, row: e.row } });
      else if (!e && was) eng.dispatch('actorDeath', { ref });
      this._logicActorState.set(ref, !!e);
    }
  }

  _announcePhaseChange(from, to) {
    const hName = this.factionName('hero');
    const wName = this.factionName('witch');
    const messages = {
      [`${Phase.DAWN}->${Phase.DAY}`]:
        `☀ The sun rises. Daylight favors ${hName}.`,
      [`${Phase.DAY}->${Phase.DUSK}`]:
        `🌇 Dusk falls. Seek shelter before night. Neither side has advantage.`,
      [`${Phase.DUSK}->${Phase.NIGHT}`]:
        `🌙 Night descends! ${wName} grows powerful. Survivors in the open will suffer!`,
      [`${Phase.NIGHT}->${Phase.DAWN}`]:
        `🌅 Dawn breaks. The darkness retreats. Find cover for the coming night.`,
    };
    const key = `${from}->${to}`;
    this.addLog(messages[key] || `Phase changed: ${to.toUpperCase()}`);
    this.addLog(
      `Round ${this.round} — ${PHASE_ICON[to]} ${to.toUpperCase()}` +
      ` (${hName}: ${this.actionsLeft} actions)`
    );
  }

  // ── Victory conditions ─────────────────────────────────────────────────

  checkVictory() {
    // Custom victory delegate (campaign missions) takes priority
    if (this.victoryDelegate) {
      const result = this.victoryDelegate(this);
      if (result) {
        this.winner    = result.winner;
        this.winReason = result.winReason;
        if (result.log) this.addLog(result.log);
        return;
      }
    }

    // Battle mode: check time-based end condition only (no kill wins)
    if (this.gameMode === GameMode.BATTLE) {
      this._checkBattleEnd();
      return;
    }

    // All witch leaders eliminated → heroes win (skip if no witch in this game)
    if (this.witch !== null && this.factionEliminated('witch')) {
      this.winner    = 'hero';
      this.winReason = WIN_REASON.WITCH_SLAIN;
      this.addLog(`☀ ${this.factionName('witch')} has been defeated! Caleb's Hollow is saved!`, 'hero');
      return;
    }
    // All hero leaders eliminated → witches win
    if (this.factionEliminated('hero')) {
      this.winner    = 'witch';
      this.winReason = WIN_REASON.HERO_SLAIN;
      this.addLog(`🌙 ${this.factionName('hero')} has fallen. Darkness descends on Caleb's Hollow forever…`, 'witch');
    }
  }

  /**
   * Battle mode end-of-week check.
   * Called by checkVictory() — the battle ends when the current time passes endsAt.
   * The server also checks this; the client trusts the server's authoritative timing.
   */
  _checkBattleEnd() {
    if (!this.battleConfig?.endsAt) return;
    const now = Math.floor(Date.now() / 1000);
    if (now < this.battleConfig.endsAt) return;

    const hs = this.nodeScore.hero;
    const ws = this.nodeScore.witch;
    if (hs > ws) {
      this.winner    = 'hero';
      this.winReason = WIN_REASON.BATTLE_HERO;
      this.addLog(`☀ The Battle for Caleb's Hollow ends! Heroes win ${hs}–${ws}!`, 'hero');
    } else if (ws > hs) {
      this.winner    = 'witch';
      this.winReason = WIN_REASON.BATTLE_WITCH;
      this.addLog(`🌙 The Battle for Caleb's Hollow ends! Witches win ${ws}–${hs}!`, 'witch');
    } else {
      // Tiebreak: faction with more living leaders
      const heroAlive  = this.players.filter(p => p.faction === 'hero'  && this.getLeader(p.id)).length;
      const witchAlive = this.players.filter(p => p.faction === 'witch' && this.getLeader(p.id)).length;
      if (heroAlive > witchAlive) {
        this.winner    = 'hero';
        this.winReason = WIN_REASON.BATTLE_HERO;
        this.addLog(`☀ The Battle ends tied ${hs}–${ws}, but more heroes stand — they win!`, 'hero');
      } else if (witchAlive > heroAlive) {
        this.winner    = 'witch';
        this.winReason = WIN_REASON.BATTLE_WITCH;
        this.addLog(`🌙 The Battle ends tied ${ws}–${hs}, but more witches remain — they win!`, 'witch');
      } else {
        this.winner    = 'draw';
        this.winReason = WIN_REASON.BATTLE_DRAW;
        this.addLog(`⚖ The Battle for Caleb's Hollow ends in a ${hs}–${ws} draw!`);
      }
    }
  }

  /**
   * Scatter all units owned by the given player when their leader is killed.
   * Called by the resolver immediately when a leader entity is slain.
   *
   * Standard mode:
   *   Survivors → hidden-survivor at current hex; summons removed.
   *
   * Battle mode:
   *   Survivors → hidden-survivor at nearest building (full HP).
   *   Zombies   → hidden-survivor at nearest building (converted back to discoverable).
   *   Minions/Golems → removed.
   */
  scatterPlayerUnits(ownerId) {
    const isBattle = this.gameMode === GameMode.BATTLE;
    const toScatter = this.entities.filter(
      e => e.ownerId === ownerId && !isLeaderType(e.type)
    );
    for (const unit of toScatter) {
      if (isBattle) {
        // Battle mode: survivors and zombies go to nearest building as hidden survivors
        if (unit.type === EntityType.SURVIVOR || unit.type === EntityType.ZOMBIE) {
          const buildingTile = this._findNearestBuilding(unit.col, unit.row);
          if (buildingTile) {
            buildingTile.hiddenSurvivor = true;
          } else {
            // Fallback: hide at current position
            const t = this.tiles.get(hexKey(unit.col, unit.row));
            if (t) t.hiddenSurvivor = true;
          }
        }
        // Minions and golems just vanish in battle mode (same as standard)
      } else {
        // Standard mode: survivors return to current hex
        if (unit.type === EntityType.SURVIVOR) {
          const t = this.tiles.get(hexKey(unit.col, unit.row));
          if (t) t.hiddenSurvivor = true;
        }
      }
      // Remove the entity
      this.entities = this.entities.filter(e => e.id !== unit.id);
    }
    const player = this.players.find(p => p.id === ownerId);
    if (player) {
      // Prefer the live leader's displayName (picks up stub names like
      // "Mercy Sloane" automatically), fall back to the side default.
      const leader = this.entities.find(e => e.id === player.leaderId);
      const label = player.name ?? leader?.displayName ?? this.factionName(player.faction);
      if (toScatter.length > 0) {
        this.addLog(`💨 ${label}'s companions scatter into the wilderness…`);
      }
    }
  }

  /**
   * Find the nearest tile with a building to the given position (BFS).
   * Returns the tile object or null if none found.
   */
  _findNearestBuilding(col, row) {
    const visited = new Set();
    const queue = [{ col, row, dist: 0 }];
    visited.add(hexKey(col, row));

    while (queue.length > 0) {
      const { col: c, row: r } = queue.shift();
      const t = this.tiles.get(hexKey(c, r));
      if (t && t.building) return t;

      for (const n of getNeighbors(c, r)) {
        const nk = hexKey(n.col, n.row);
        if (visited.has(nk)) continue;
        if (!this.tiles.has(nk)) continue;
        visited.add(nk);
        queue.push({ col: n.col, row: n.row });
      }
    }
    return null;
  }

  _checkNodeObjectives(phase) {
    const isBattle   = this.gameMode === GameMode.BATTLE;
    const isDawn     = phase === Phase.DAWN;
    const phaseLabel = isDawn ? 'dawn' : 'dusk';

    let witchCount = 0, heroCount = 0;
    for (const obj of this.witchObjectives) {
      const ctrl = nodeController(obj, this.entities);
      if (ctrl === 'witch') witchCount++;
      if (ctrl === 'hero')  heroCount++;
    }

    // Scoring: whoever controls more nodes scores 1 point (ties score nothing)
    if (witchCount > heroCount) {
      this.nodeScore.witch++;
      this.addLog(`🌙 At ${phaseLabel}: ${this.factionName('witch')} leads ${witchCount}–${heroCount}. Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`);
      // Mission opt-in: prolong the night. Each witch score appends extra
      // phases to the active cycle (e.g. another 'night' turn). Inert when
      // cycleConfig is absent or extendOnWitchScore is unset.
      const extend = this.cycleConfig?.extendOnWitchScore;
      if (extend && extend.length) {
        this.cycleConfig.phases.push(...extend);
        this.addLog(`🌑 The night deepens — the dawn slips further away.`);
      }
      // Score threshold win (disabled in battle mode — runs until time expires)
      if (!isBattle && !this.disableScoreWin && this.nodeScore.witch >= this.nodeScoreThreshold) {
        this.winner    = 'witch';
        this.winReason = WIN_REASON.SCORE_WITCH;
        this.addLog(`🌙 ${this.factionName('witch')} has claimed ${this.nodeScoreThreshold} ritual moments — Caleb's Hollow falls to darkness!`);
      }
    } else if (heroCount > witchCount) {
      this.nodeScore.hero++;
      this.addLog(`☀ At ${phaseLabel}: ${this.factionName('hero')} leads ${heroCount}–${witchCount}. Score — Hero ${this.nodeScore.hero} / Witch ${this.nodeScore.witch}`);
      if (!isBattle && !this.disableScoreWin && this.nodeScore.hero >= this.nodeScoreThreshold) {
        this.winner    = 'hero';
        this.winReason = WIN_REASON.SCORE_HERO;
        this.addLog(`☀ ${this.factionName('hero')} has broken the ritual ${this.nodeScoreThreshold} times — Caleb's Hollow is saved!`);
      }
    } else {
      this.addLog(`⚖ At ${phaseLabel}: nodes tied (${witchCount}–${heroCount}). Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`);
    }
  }

  /**
   * Battle mode: score node control on non-dawn/dusk rounds.
   * Same logic as _checkNodeObjectives but with generic round-based labels.
   */
  _checkBattleNodeScoring() {
    let witchCount = 0, heroCount = 0;
    for (const obj of this.witchObjectives) {
      const ctrl = nodeController(obj, this.entities);
      if (ctrl === 'witch') witchCount++;
      if (ctrl === 'hero')  heroCount++;
    }

    if (witchCount > heroCount) {
      this.nodeScore.witch++;
      this.addLog(`🌙 Round ${this.round}: Witches lead nodes ${witchCount}–${heroCount}. Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`, 'witch');
    } else if (heroCount > witchCount) {
      this.nodeScore.hero++;
      this.addLog(`☀ Round ${this.round}: Heroes lead nodes ${heroCount}–${witchCount}. Score — Hero ${this.nodeScore.hero} / Witch ${this.nodeScore.witch}`, 'hero');
    } else {
      this.addLog(`⚖ Round ${this.round}: nodes tied (${witchCount}–${heroCount}). Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`);
    }
  }

  /**
   * Check if any node's control state changed since last call and add log entries.
   * Should be called after resolution completes each round.
   */
  checkAndLogNodeControlChanges() {
    for (const obj of this.witchObjectives) {
      const ctrl = nodeController(obj, this.entities);
      if (ctrl !== obj.prevCtrl) {
        if (ctrl === 'contested')
          this.addLog(`⚡ ${obj.label} is now contested!`);
        else if (ctrl === 'hero')
          this.addLog(`🔵 ${this.factionName('hero')} claims ${obj.label}.`, 'hero');
        else if (ctrl === 'witch')
          this.addLog(`🔴 ${this.factionName('witch')} seizes ${obj.label}.`, 'witch');
        else if (ctrl === 'neutral')
          this.addLog(`⭕ ${obj.label} is no longer held.`);
        obj.prevCtrl = ctrl;
      }
    }
  }

  /**
   * Permanently mark nodes as discovered by factions whose units can currently see them.
   * A node is "seen" if any of its hexes is within sightRange of any faction entity.
   * Should be called after resolution and at game start.
   */
  updateNodeDiscovery() {
    for (const obj of this.witchObjectives) {
      for (const fac of allFactions()) {
        const key = fac.getNodeSeenKey();
        if (obj[key]) continue; // already discovered
        obj[key] = this.entities.some(e => {
          if (!e.alive || e.owner !== fac.id) return false;
          const range = sightRangeForEntity(e, this.phase);
          return obj.hexes.some(h =>
            hexDistance(e.col, e.row, h.col, h.row) <= range
            && hasLineOfSight(this, e.col, e.row, h.col, h.row)
          );
        });
      }
    }
  }

  /** Merge a set of hex keys into a faction's explored-hex memory. */
  markExplored(faction, hexKeys) {
    const set = this.exploredHexes[faction];
    if (!set) return;
    for (const k of hexKeys) set.add(k);
  }

  /**
   * Compute visible hexes for each faction based on current entity positions
   * and merge them into exploredHexes. Call this server-side (and offline)
   * after resolution and at the start of planning so that fog-of-war memory
   * persists across turns without relying on the renderer.
   */
  updateExploredHexes() {
    for (const factionObj of allFactions()) {
      const factionId = factionObj.id;
      const visible = computeLineOfSight(this, factionId);
      this.markExplored(factionId, visible);
    }
  }

  get gameOver() { return this.winner !== null; }

  /**
   * Look up the player color for an entity — the owning leader's assigned color,
   * falling back to the faction default from ENTITY_COLOR.
   */
  playerColorFor(entity) {
    if (!entity) return null;
    if (entity.ownerId) {
      const leader = this.entities.find(e =>
        e.ownerId === entity.ownerId && isLeaderType(e.type)
      );
      if (leader?.color) return leader.color;
    }
    if (entity.owner === 'hero')  return ENTITY_COLOR[EntityType.PALADIN];
    if (entity.owner === 'witch') return ENTITY_COLOR[EntityType.WITCH];
    return null;
  }

  addLog(msg, owner = null, color = null) {
    if (owner || color) {
      const entry = { text: msg };
      if (owner) entry.owner = owner;
      if (color) entry.color = color;
      this.log.push(entry);
    } else {
      this.log.push(msg);
    }
    if (this.log.length > 100) this.log.shift();
  }

  playerEntities(player) {
    return this.entities.filter(e => e.owner === player && e.alive);
  }

  // Scatter hidden survivors across the map (count varies by map size).
  // Each tile can hold at most one; they reveal when any unit steps onto the tile.
  // Survivors are never placed within MIN_SURVIVOR_DIST hexes of a start position.
  _placeHiddenSurvivors() {
    const MIN_SURVIVOR_DIST = 3;
    const tooClose = (t) => {
      if (this._heroStart &&
          hexDistance(t.col, t.row, this._heroStart.col, this._heroStart.row) < MIN_SURVIVOR_DIST) return true;
      if (this._witchStart &&
          hexDistance(t.col, t.row, this._witchStart.col, this._witchStart.row) < MIN_SURVIVOR_DIST) return true;
      return false;
    };

    const buildings = [];
    const terrain   = [];
    for (const t of this.tiles.values()) {
      if (isRiver(t)) continue;
      if (tooClose(t)) continue;
      if (hasBuilding(t)) buildings.push(t);
      else terrain.push(t);
    }

    const shuffle = arr => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    const sc = this._survivorCounts ?? { buildings: 5, terrain: 2 };
    const totalNeeded = sc.buildings + sc.terrain;
    const pickedBuildings = shuffle(buildings).slice(0, sc.buildings);
    pickedBuildings.forEach(t => { t.hiddenSurvivor = true; });
    // If not enough buildings were available, spill the remainder into terrain
    const terrainNeeded = totalNeeded - pickedBuildings.length;
    shuffle(terrain).slice(0, terrainNeeded).forEach(t => { t.hiddenSurvivor = true; });
  }

  // Currently a no-op — retained as a hook for NvN-aware survivor tuning.
  // Previous iterations scaled the pool up or down here; the current balance
  // comes from scaled minion cap + NvN loot bonus, which raises witch-side
  // density without needing additional hero survivors.
  _rebalanceHiddenSurvivorsForTeamSize() {
    if (this._survivorsRebalanced) return;
    this._survivorsRebalanced = true;
  }

  toJSON() {
    return JSON.stringify({
      round: this.round,
      phase: this.phase,
      activePlayer: this.activePlayer,
      actionsLeft: this.actionsLeft,
      inventory: this.inventory,
      nodeScore: this.nodeScore,
      attritionLevel: this.attritionLevel,
      log: this.log.slice(-20),
    });
  }
}
