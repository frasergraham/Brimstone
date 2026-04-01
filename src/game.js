// Central game state and turn management
import { generateMap } from './map.js';
import { createHero, createWitch, createMinion, createSurvivor, resetRoster, EntityType, SurvivorAbility, ENTITY_COLOR } from './entities.js';
import { BuildingType, ResourceType, TileType } from './tiles.js';
import { hexKey, hexDistance, getNeighbors, setMapDimensions, MAP_COLS, MAP_ROWS } from './hex.js';
import { applyPostRoundEffects, attritionForCycle } from './post-round-effects.js';
import { sightRange } from './actions.js';

/**
 * Determine which faction controls a power node cluster based on majority hex occupation.
 * Multiple units on the same hex count as one occupied hex.
 * @returns {'hero'|'witch'|'contested'|'neutral'}
 */
export function nodeController(obj, entities) {
  const hexSet = new Set(obj.hexes.map(h => hexKey(h.col, h.row)));
  const heroHexes  = new Set();
  const witchHexes = new Set();
  for (const e of entities) {
    if (!e.alive) continue;
    const k = hexKey(e.col, e.row);
    if (!hexSet.has(k)) continue;
    if (e.owner === 'hero')  heroHexes.add(k);
    if (e.owner === 'witch') witchHexes.add(k);
  }
  if (heroHexes.size > witchHexes.size)  return 'hero';
  if (witchHexes.size > heroHexes.size)  return 'witch';
  if (heroHexes.size === 0) return 'neutral';
  return 'contested';
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

// Win reason strings (shown in game-over overlay)
export const WIN_REASON = {
  WITCH_SLAIN:      'The hero hunted down the witch and ended the curse!',
  HERO_SLAIN:       'The hero fell in battle. Salem is lost to darkness.',
  NODES_WITCH:      'The witch seized all Power Nodes at dawn — the ritual is complete!',
  NODES_HERO:       'The hero held all Power Nodes at dawn — the witch\'s ritual is broken!',
  NODES_WITCH_DUSK: 'As dusk falls, the witch holds all Power Nodes — the ritual advances!',
  NODES_HERO_DUSK:  'As dusk falls, the hero holds all Power Nodes — the witch\'s ritual is disrupted!',
  SCORE_WITCH:      'The witch dominates the Power Nodes across three cycles — the ritual is complete!',
  SCORE_HERO:       'The hero holds the Power Nodes through the darkness — the curse is broken!',
};

// ── Phase cycle ─────────────────────────────────────────────────────────────
// One full cycle = 8 rounds: DAWN(1) → DAY(3) → DUSK(1) → NIGHT(3)
// Attrition schedule lives in src/post-round-effects.js (attritionForCycle).
const CYCLE_LENGTH = 8;

export const Phase = Object.freeze({
  DAWN:  'dawn',
  DAY:   'day',
  DUSK:  'dusk',
  NIGHT: 'night',
});

export const Player = Object.freeze({ HERO: 'hero', WITCH: 'witch' });

// Calculate actions for a player at the start of their turn.
// Hero  — base 3 + 1 in DAWN/DAY + 1 per survivor (cap +5) + 1 per held power node
// Witch — base 3 + 1 in NIGHT + 1 per unit (cap +3) + 1 per held power node
export function computeActions(player, phase, entities, nodeBonus = 0) {
  const isHero     = player === Player.HERO;
  const owner      = isHero ? 'hero' : 'witch';
  const leaderType = isHero ? 'hero' : 'witch';
  const extras     = entities.filter(e => e.alive && e.owner === owner && e.type !== leaderType).length;

  if (isHero) {
    const timeBonus = (phase === Phase.DAY || phase === Phase.DAWN) ? 1 : 0;
    return 3 + timeBonus + Math.min(extras, 5) + nodeBonus;
  } else {
    const timeBonus = phase === Phase.NIGHT ? 1 : 0;
    return 3 + timeBonus + Math.min(extras, 3) + nodeBonus;
  }
}

/**
 * Compute the action budget for one specific player (multiplayer path).
 * Counts only entities owned by that player (ownerId match), not the whole faction.
 */
export function computeActionsForPlayer(playerId, faction, phase, entities, nodeBonus = 0) {
  const isHero     = faction === Player.HERO;
  const leaderType = isHero ? EntityType.HERO : EntityType.WITCH;
  // Count non-leader entities belonging to this player specifically
  const extras = entities.filter(
    e => e.alive && e.ownerId === playerId && e.type !== leaderType
  ).length;

  if (isHero) {
    const timeBonus = (phase === Phase.DAY || phase === Phase.DAWN) ? 1 : 0;
    return 3 + timeBonus + Math.min(extras, 5) + nodeBonus;
  } else {
    const timeBonus = phase === Phase.NIGHT ? 1 : 0;
    return 3 + timeBonus + Math.min(extras, 3) + nodeBonus;
  }
}

function phaseForRound(round) {
  const r = (round - 1) % CYCLE_LENGTH;
  if (r === 0)            return Phase.DAWN;
  if (r >= 1 && r <= 3)  return Phase.DAY;
  if (r === 4)            return Phase.DUSK;
  return Phase.NIGHT;
}

const PHASE_ICON = {
  [Phase.DAWN]:  '🌅',
  [Phase.DAY]:   '☀',
  [Phase.DUSK]:  '🌇',
  [Phase.NIGHT]: '🌙',
};

export { PHASE_ICON };

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

    // Fog of war mode: 'none' | 'partial' | 'full'
    //   none    — everything visible
    //   partial — terrain visible, enemies hidden outside sight range
    //   full    — hexes outside movement+sight range are black; explored hexes dimmed
    this.fogOfWar = (witchIsAI || heroIsAI) ? 'partial' : 'none';

    // Hexes that have been seen at least once per faction (full fog memory).
    // Set<hexKey> per faction — persisted via state-sync.
    this.exploredHexes = { hero: new Set(), witch: new Set() };

    // ── Player registry (multiplayer) ──────────────────────────────────────
    // Each entry: { id, name, faction, isAI, leaderId }
    // Populated by addPlayer() for online games; pre-populated here for offline.
    this.players = [];

    // Offline / legacy path: create one hero and one witch with synthetic player IDs.
    const heroName = mapDataOverride?.heroName ?? 'Hero';
    const witchName = mapDataOverride?.witchName ?? 'Witch';
    this.hero  = createHero(mapData.heroStart.col,  mapData.heroStart.row, 'hero');
    this.hero.name = heroName;
    this.entities.push(this.hero);
    this.players.push({ id: 'hero',  name: heroName,  faction: 'hero',  isAI: heroIsAI,  leaderId: this.hero.id });

    // Witch is optional — campaign missions may omit the witch entity entirely.
    if (mapDataOverride?.noWitch) {
      this.witch = null;
      this.players.push({ id: 'witch', name: witchName, faction: 'witch', isAI: true, leaderId: null });
    } else {
      this.witch = createWitch(mapData.witchStart.col, mapData.witchStart.row, 'witch');
      this.witch.name = witchName;
      this.entities.push(this.witch);
      this.players.push({ id: 'witch', name: witchName, faction: 'witch', isAI: witchIsAI, leaderId: this.witch.id });
    }

    this.inventory = { shared: {}, witch: {} };

    this.mapSize       = mapData.mapSize;
    this._survivorCounts = mapData.survivorCounts;
    this.witchObjectives = mapData.witchObjectives;
    this._heroStart  = { col: mapData.heroStart.col,  row: mapData.heroStart.row };
    this._witchStart = mapData.witchStart
      ? { col: mapData.witchStart.col, row: mapData.witchStart.row }
      : null;
    this._placeHiddenSurvivors();
    this.updateNodeDiscovery();

    this.round        = 1;
    this.phase        = Phase.DAWN;
    this.activePlayer = Player.HERO;
    this.actionsLeft  = computeActions(Player.HERO, Phase.DAWN, []);
    this.log = [
      `🌅 Dawn breaks over Salem. ${this.hero.displayName} stirs at the Inn.`,
      `Three Power Nodes: ${this.witchObjectives.map(o => o.label).join(', ')}.`,
      `⚔ Hold 2+ nodes at each dawn/dusk to score. First to 4 points wins. Three cycles — then darkness claims Salem.`,
    ];

    this.selectedEntity    = null;
    this.pendingAction     = null;
    this.winner            = null;
    this.winReason         = null;
    this.postRoundEvents   = []; // structured PostRoundEvent[] from post-round-effects pipeline

    // ── Cumulative stats counters (for game-stats tracking) ──────────────────
    this.heroKills        = 0; // entities killed by hero side (combat + hazards)
    this.witchKills       = 0; // entities killed by witch side (combat + hazards)
    this.witchSummonCount = 0; // total summons performed by witch side

    // Cumulative node scoring: each dawn/dusk majority scores 1 point; first to 3 wins.
    this.nodeScore = { hero: 0, witch: 0 };
    // When true, skip dawn/dusk node scoring and hide the score track UI.
    this.disableScoring = !!mapDataOverride?.disableScoring;

    // Max survivors discoverable from hidden-survivor tiles (null = unlimited).
    this.maxDiscoverableSurvivors = mapDataOverride?.maxDiscoverableSurvivors ?? null;
    this.discoveredSurvivorCount  = 0;

    // ── Campaign / custom victory ──────────────────────────────────────────
    // When set, checked first by checkVictory(). Return { winner, winReason, log? } or null.
    this.victoryDelegate = null;

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
  addPlayer(playerId, name, faction, col, row, isAI = false) {
    const leader = faction === Player.HERO
      ? createHero(col, row, playerId)
      : createWitch(col, row, playerId);
    leader.name = name;
    this.entities.push(leader);
    this.players.push({ id: playerId, name, faction, isAI, leaderId: leader.id });
    // Keep legacy singleton refs pointing at the first hero/witch for offline compat
    if (faction === Player.HERO  && !this.hero)  this.hero  = leader;
    if (faction === Player.WITCH && !this.witch) this.witch = leader;
    return leader;
  }

  /** Return the display name of the primary leader for a faction. */
  factionName(faction) {
    const leader = faction === 'hero' ? this.hero : this.witch;
    return leader?.displayName ?? (faction === 'hero' ? 'The Hero' : 'The Witch');
  }

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
    this.planningPhase    = true;
    this.resolving        = false;
    this.heroPlan         = null;
    this.witchPlan        = null;
    this.heroReady        = false;
    this.witchReady       = false;

    // Power-node bonus: +1 action per node the faction controls
    const heroNodeBonus  = countHeldNodes('hero',  this.witchObjectives, this.entities);
    const witchNodeBonus = countHeldNodes('witch', this.witchObjectives, this.entities);

    // Legacy faction-level budgets (offline mode)
    this.heroActionsLeft  = computeActions(Player.HERO,  this.phase, this.entities, heroNodeBonus);
    this.witchActionsLeft = computeActions(Player.WITCH, this.phase, this.entities, witchNodeBonus);

    // Per-player budgets (multiplayer)
    this.playerPlans       = new Map();
    this.playerReady       = new Map();
    this.playerActionsLeft = new Map();
    for (const p of this.players) {
      this.playerReady.set(p.id, false);
      const nb = p.faction === Player.HERO ? heroNodeBonus : witchNodeBonus;
      this.playerActionsLeft.set(p.id, computeActionsForPlayer(p.id, p.faction, this.phase, this.entities, nb));
    }

    const heroNB  = heroNodeBonus  ? ` (incl. +${heroNodeBonus} node)` : '';
    const witchNB = witchNodeBonus ? ` (incl. +${witchNodeBonus} node)` : '';
    this.addLog(
      `📋 Planning phase — Hero: ${this.heroActionsLeft} actions${heroNB}, ` +
      `Witch: ${this.witchActionsLeft} actions${witchNB}.`
    );
  }

  /**
   * Submit a faction's plan (legacy offline / 2-player path).
   * @param {'hero'|'witch'} faction
   * @param {import('./planner.js').PlanAction[]} plan
   * @returns {boolean} true when both factions have submitted
   */
  submitPlan(faction, plan) {
    if (!this.planningPhase) throw new Error('Not in planning phase.');
    if (faction === Player.HERO) {
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
    if (!this.planningPhase) throw new Error('Not in planning phase.');
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error(`Unknown player: ${playerId}`);
    if (this.playerReady.get(playerId)) throw new Error('Plan already submitted.');

    this.playerPlans.set(playerId, plan);
    this.playerReady.set(playerId, true);

    const icon = player.faction === 'hero' ? '⚔' : '✦';
    this.addLog(`${icon} ${player.name} submits their plan (${plan.length} step${plan.length !== 1 ? 's' : ''}).`);

    const allReady = [...this.playerReady.values()].every(Boolean);
    if (allReady) {
      this.planningPhase = false;
      this.resolving     = true;
    }
    return allReady;
  }

  /** True if every registered player has submitted their plan. */
  get allPlayersReady() {
    return this.players.length > 0 && [...this.playerReady.values()].every(Boolean);
  }

  /**
   * Apply end-of-round effects after resolution: rest healing, night/day node
   * spawns, phase advance, hazards, attrition, and node scoring.
   * Works for both 1v1 (offline) and N-vs-N (online multiplayer).
   */
  endRound() {
    this.resolving = false;

    // Rest heal: every living hero-faction leader in a building or on a node.
    const heroLeaders = this.entities.filter(
      e => e.alive && e.type === EntityType.HERO
    );
    for (const hero of heroLeaders) {
      const heroTile = this.tiles.get(hexKey(hero.col, hero.row));
      if (heroTile?.type === TileType.BUILDING && hero.hp < hero.maxHp) {
        const b = heroTile.building;
        if (b === BuildingType.INN) {
          hero.heal(3);
          this.addLog(`🏨 ${hero.displayName} rests at the inn. (+3 HP, now ${hero.hp}/${hero.maxHp})`, 'hero', this.playerColorFor(hero));
        } else if (b === BuildingType.CHURCH) {
          hero.heal(3);
          this.addLog(`⛪ ${hero.displayName} prays at the chapel. (+3 HP, now ${hero.hp}/${hero.maxHp})`, 'hero', this.playerColorFor(hero));
        } else {
          hero.heal(1);
          this.addLog(`🏠 ${hero.displayName} rests in shelter. (+1 HP, now ${hero.hp}/${hero.maxHp})`, 'hero', this.playerColorFor(hero));
        }
      }
      if (hero.hp < hero.maxHp) {
        const onNode = this.witchObjectives.some(
          obj => obj.hexes.some(h => h.col === hero.col && h.row === hero.row)
        );
        if (onNode) {
          hero.heal(1);
          this.addLog(`✨ ${hero.displayName} draws power from the node. (+1 HP, now ${hero.hp}/${hero.maxHp})`, 'hero', this.playerColorFor(hero));
        }
      }
    }

    // Night: node spawns — hero leaders on a node may spawn a free survivor.
    if (this.phase === Phase.NIGHT) {
      for (const obj of this.witchObjectives) {
        const freeHex = () => {
          // Look for a free hex adjacent to any hex in the cluster
          for (const clusterHex of obj.hexes) {
            const n = getNeighbors(clusterHex.col, clusterHex.row).find(nb => {
              const t = this.tiles.get(hexKey(nb.col, nb.row));
              return t && t.type !== TileType.RIVER &&
                !this.entities.some(e => e.alive && e.col === nb.col && e.row === nb.row);
            });
            if (n) return n;
          }
          return null;
        };
        for (const hero of heroLeaders) {
          if (obj.hexes.some(h => h.col === hero.col && h.row === hero.row)) {
            if (Math.random() < 0.33) {
              const hex = freeHex();
              if (hex) {
                const s = createSurvivor(hex.col, hex.row, hero.ownerId);
                s.owner = 'hero';
                if (Math.random() < 0.5) s.items['horse'] = 1;
                this.entities.push(s);
                const horseNote = s.items['horse'] ? ' (arrives on horseback!)' : '';
                this.addLog(`✨ The node calls to the living — a survivor emerges!${horseNote}`, 'hero', this.playerColorFor(hero));
              }
            } else {
              this.addLog(`✨ The node pulses faintly… no one answers the call tonight.`, 'hero');
            }
          }
        }
      }
    }

    // Advance round and phase.
    this.entities.forEach(e => e.resetTurn());
    this.round++;
    const prevPhase = this.phase;
    this.phase = phaseForRound(this.round);

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
      const cycle    = Math.ceil(this.round / CYCLE_LENGTH);
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

    this.checkVictory();
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
    // All witch leaders eliminated → heroes win (skip if no witch in this game)
    if (this.witch !== null && this.factionEliminated('witch')) {
      this.winner    = 'hero';
      this.winReason = WIN_REASON.WITCH_SLAIN;
      this.addLog(`☀ ${this.factionName('witch')} has been defeated! Salem is saved!`, 'hero');
      return;
    }
    // All hero leaders eliminated → witches win
    if (this.factionEliminated('hero')) {
      this.winner    = 'witch';
      this.winReason = WIN_REASON.HERO_SLAIN;
      this.addLog(`🌙 ${this.factionName('hero')} has fallen. Darkness descends on Salem forever…`, 'witch');
    }
  }

  /**
   * Scatter all units owned by the given player when their leader is killed.
   * Survivors are reset to hidden-survivor tiles; summons are removed.
   * Called by the resolver immediately when a leader entity is slain.
   */
  scatterPlayerUnits(ownerId) {
    const toScatter = this.entities.filter(
      e => e.ownerId === ownerId && e.type !== EntityType.HERO && e.type !== EntityType.WITCH
    );
    for (const unit of toScatter) {
      if (unit.type === EntityType.SURVIVOR) {
        // Return to the map as a hidden survivor — discovered fresh by whoever steps on it next
        const t = this.tiles.get(hexKey(unit.col, unit.row));
        if (t) t.hiddenSurvivor = true;
      }
      // Remove all owned units (summons just disappear; survivors become hidden again)
      this.entities = this.entities.filter(e => e.id !== unit.id);
    }
    const player = this.players.find(p => p.id === ownerId);
    if (player) {
      const label = player.name || (player.faction === 'hero' ? 'The Hero' : 'The Witch');
      if (toScatter.length > 0) {
        this.addLog(`💨 ${label}'s companions scatter into the wilderness…`);
      }
    }
  }

  _checkNodeObjectives(phase) {
    const isDawn     = phase === Phase.DAWN;
    const phaseLabel = isDawn ? 'dawn' : 'dusk';
    const nodeCount  = this.witchObjectives.length;

    let witchCount = 0, heroCount = 0;
    for (const obj of this.witchObjectives) {
      const ctrl = nodeController(obj, this.entities);
      if (ctrl === 'witch') witchCount++;
      if (ctrl === 'hero')  heroCount++;
    }

    // Instant win: sweep all nodes
    if (witchCount === nodeCount) {
      this.winner    = 'witch';
      this.winReason = isDawn ? WIN_REASON.NODES_WITCH : WIN_REASON.NODES_WITCH_DUSK;
      this.addLog(isDawn
        ? `🌙 As dawn breaks, ${this.factionName('witch')} holds all Power Nodes! Salem is lost…`
        : `🌙 As dusk falls, ${this.factionName('witch')} holds all Power Nodes! The ritual advances!`, 'witch');
      return;
    }
    if (heroCount === nodeCount) {
      this.winner    = 'hero';
      this.winReason = isDawn ? WIN_REASON.NODES_HERO : WIN_REASON.NODES_HERO_DUSK;
      this.addLog(isDawn
        ? `☀ At dawn, ${this.factionName('hero')} holds all Power Nodes! ${this.factionName('witch')}'s ritual is broken!`
        : `☀ As dusk falls, ${this.factionName('hero')} holds all Power Nodes! The ritual is disrupted!`, 'hero');
      return;
    }

    // Scoring: whoever controls more nodes scores 1 point (ties score nothing)
    if (witchCount > heroCount) {
      this.nodeScore.witch++;
      this.addLog(`🌙 At ${phaseLabel}: ${this.factionName('witch')} leads ${witchCount}–${heroCount}. Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`, 'witch');
      if (this.nodeScore.witch >= 4) {
        this.winner    = 'witch';
        this.winReason = WIN_REASON.SCORE_WITCH;
        this.addLog(`🌙 ${this.factionName('witch')} has claimed three ritual moments — Salem falls to darkness!`, 'witch');
      }
    } else if (heroCount > witchCount) {
      this.nodeScore.hero++;
      this.addLog(`☀ At ${phaseLabel}: ${this.factionName('hero')} leads ${heroCount}–${witchCount}. Score — Hero ${this.nodeScore.hero} / Witch ${this.nodeScore.witch}`, 'hero');
      if (this.nodeScore.hero >= 4) {
        this.winner    = 'hero';
        this.winReason = WIN_REASON.SCORE_HERO;
        this.addLog(`☀ ${this.factionName('hero')} has broken the ritual three times — Salem is saved!`, 'hero');
      }
    } else {
      this.addLog(`⚖ At ${phaseLabel}: nodes tied (${witchCount}–${heroCount}). Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`);
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
      if (!obj.seenByHero) {
        obj.seenByHero = this.entities.some(e => {
          if (!e.alive || e.owner !== 'hero') return false;
          const range = sightRange(this.phase, e.ability === SurvivorAbility.SCOUT);
          return obj.hexes.some(h => hexDistance(e.col, e.row, h.col, h.row) <= range);
        });
      }
      if (!obj.seenByWitch) {
        obj.seenByWitch = this.entities.some(e => {
          if (!e.alive || e.owner !== 'witch') return false;
          const range = sightRange(this.phase, false);
          return obj.hexes.some(h => hexDistance(e.col, e.row, h.col, h.row) <= range);
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
    for (const faction of ['hero', 'witch']) {
      const visible = new Set();
      for (const e of this.entities) {
        if (!e.alive || e.owner !== faction) continue;
        const range = (faction === 'witch')
          ? 2
          : sightRange(this.phase, e.ability === SurvivorAbility.SCOUT);
        const rMin = Math.max(0, e.row - range);
        const rMax = Math.min(MAP_ROWS - 1, e.row + range);
        const cMin = Math.max(0, e.col - range);
        const cMax = Math.min(MAP_COLS - 1, e.col + range);
        for (let row = rMin; row <= rMax; row++) {
          for (let col = cMin; col <= cMax; col++) {
            if (hexDistance(col, row, e.col, e.row) <= range) {
              visible.add(hexKey(col, row));
            }
          }
        }
      }
      this.markExplored(faction, visible);
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
        e.ownerId === entity.ownerId &&
        (e.type === EntityType.HERO || e.type === EntityType.WITCH)
      );
      if (leader?.color) return leader.color;
    }
    if (entity.owner === 'hero')  return ENTITY_COLOR[EntityType.HERO];
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
      if (t.type === TileType.RIVER) continue;
      if (tooClose(t)) continue;
      if (t.type === TileType.BUILDING) buildings.push(t);
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
