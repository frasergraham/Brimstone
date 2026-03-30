// Central game state and turn management
import { generateMap } from './map.js';
import { createHero, createWitch, createMinion, createSurvivor, resetRoster, EntityType, SurvivorAbility } from './entities.js';
import { BuildingType, ResourceType, TileType } from './tiles.js';
import { hexKey, hexDistance, getNeighbors, setMapDimensions } from './hex.js';
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

// Attrition schedule (damage per exposed unit per hazard phase):
//   Cycle 1: 0  — no hazard, players learn the map
//   Cycle 2: 1  — pressure begins
//   Cycles 3-4: 2  — significant threat
//   Cycle 5+: 3  — lethal for most minions/survivors in the open
function attritionForCycle(cycle) {
  if (cycle <= 1) return 0;
  if (cycle === 2) return 1;
  if (cycle <= 4) return 2;
  return 3;
}
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
   * @param {object|null} mapDataOverride  Pre-built map data (e.g. from generateTutorialMap()).
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

    // Fog of war: hide opponent from the human player's view when any side is AI
    this.fogOfWar = witchIsAI || heroIsAI;

    // ── Player registry (multiplayer) ──────────────────────────────────────
    // Each entry: { id, name, faction, isAI, leaderId }
    // Populated by addPlayer() for online games; pre-populated here for offline.
    this.players = [];

    // Offline / legacy path: create one hero and one witch with synthetic player IDs.
    this.hero  = createHero(mapData.heroStart.col,  mapData.heroStart.row, 'hero');
    this.entities.push(this.hero);
    this.players.push({ id: 'hero',  name: 'Hero',  faction: 'hero',  isAI: heroIsAI,  leaderId: this.hero.id });

    // Witch is optional — campaign missions may omit the witch entity entirely.
    if (mapDataOverride?.noWitch) {
      this.witch = null;
      this.players.push({ id: 'witch', name: 'Witch', faction: 'witch', isAI: true, leaderId: null });
    } else {
      this.witch = createWitch(mapData.witchStart.col, mapData.witchStart.row, 'witch');
      this.entities.push(this.witch);
      this.players.push({ id: 'witch', name: 'Witch', faction: 'witch', isAI: witchIsAI, leaderId: this.witch.id });
    }

    this.inventory = { shared: {}, witch: {} };

    this.mapSize       = mapData.mapSize;
    this._survivorCounts = mapData.survivorCounts;
    this.witchObjectives = mapData.witchObjectives;
    this._placeHiddenSurvivors();
    this.updateNodeDiscovery();

    this.round        = 1;
    this.phase        = Phase.DAWN;
    this.activePlayer = Player.HERO;
    this.actionsLeft  = computeActions(Player.HERO, Phase.DAWN, []);
    this.log = [
      `🌅 Dawn breaks over Salem. The hero stirs at the Inn.`,
      `Three Power Nodes: ${this.witchObjectives.map(o => o.label).join(', ')}.`,
      `⚔ Hold 2+ nodes at each dawn/dusk to score. First to 4 points wins. Three cycles — then darkness claims Salem.`,
    ];

    this.selectedEntity    = null;
    this.pendingAction     = null;
    this.winner            = null;
    this.winReason         = null;
    this.lastNightDamage   = []; // {col,row,dmg,isFort} entries for flash animation
    this.lastDayDamage     = []; // {col,row,dmg} entries for flash animation
    this.lastHazardLog     = []; // human-readable lines describing hazard events this phase

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
    this.attritionLevel    = 0;
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
    this.entities.push(leader);
    this.players.push({ id: playerId, name, faction, isAI, leaderId: leader.id });
    // Keep legacy singleton refs pointing at the first hero/witch for offline compat
    if (faction === Player.HERO  && !this.hero)  this.hero  = leader;
    if (faction === Player.WITCH && !this.witch) this.witch = leader;
    return leader;
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
          this.addLog(`🏨 ${hero.displayName} rests at the inn. (+3 HP, now ${hero.hp}/${hero.maxHp})`);
        } else if (b === BuildingType.CHURCH) {
          hero.heal(3);
          this.addLog(`⛪ ${hero.displayName} prays at the chapel. (+3 HP, now ${hero.hp}/${hero.maxHp})`);
        } else {
          hero.heal(1);
          this.addLog(`🏠 ${hero.displayName} rests in shelter. (+1 HP, now ${hero.hp}/${hero.maxHp})`);
        }
      }
      if (hero.hp < hero.maxHp) {
        const onNode = this.witchObjectives.some(
          obj => obj.hexes.some(h => h.col === hero.col && h.row === hero.row)
        );
        if (onNode) {
          hero.heal(1);
          this.addLog(`✨ ${hero.displayName} draws power from the node. (+1 HP, now ${hero.hp}/${hero.maxHp})`);
        }
      }
    }

    // Night: node spawns — each witch/hero leader on a node may spawn a unit.
    if (this.phase === Phase.NIGHT) {
      const witchLeaders = this.entities.filter(e => e.alive && e.type === EntityType.WITCH);
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
        for (const witch of witchLeaders) {
          if (obj.hexes.some(h => h.col === witch.col && h.row === witch.row)) {
            if (Math.random() < 0.33) {
              const hex = freeHex();
              if (hex) {
                this.entities.push(createMinion(hex.col, hex.row, witch.ownerId));
                this.addLog(`🌑 ${witch.displayName} channels the node — a minion rises from the dark!`);
              }
            } else {
              this.addLog(`🌑 The node stirs… but yields nothing this night.`);
            }
          }
        }
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
                this.addLog(`✨ The node calls to the living — a survivor emerges!${horseNote}`);
              }
            } else {
              this.addLog(`✨ The node pulses faintly… no one answers the call tonight.`);
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

    // Hazards on the new phase.
    if (this.phase === Phase.NIGHT) {
      this.lastNightDamage = [];
      this.lastHazardLog   = [];
      this._applyNightHazard(this.attritionLevel);
    }
    if (this.phase === Phase.DAY) {
      this.lastDayDamage = [];
      this.lastHazardLog = [];
      this._applyDayHazard(this.attritionLevel);
    }
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

  endTurn() {
    const playerLabel = this.activePlayer === Player.HERO ? "Hero's" : "Witch's";
    this.addLog(`${playerLabel} turn ends.`);

    if (this.activePlayer === Player.HERO) {
      // Rest heal: hero recovers HP when ending their turn inside a building
      const heroTile = this.tiles.get(hexKey(this.hero.col, this.hero.row));
      if (this.hero.alive && heroTile?.type === TileType.BUILDING && this.hero.hp < this.hero.maxHp) {
        const b = heroTile.building;
        if (b === BuildingType.INN) {
          this.hero.heal(3);
          this.addLog(`🏨 The hero rests at the inn. (+3 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
        } else if (b === BuildingType.CHURCH) {
          this.hero.heal(3);
          this.addLog(`⛪ The hero prays at the chapel. (+3 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
        } else {
          this.hero.heal(1);
          this.addLog(`🏠 The hero rests in shelter. (+1 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
        }
      }

      // Node blessing: hero standing on a Power Node heals 1 HP
      if (this.hero.alive && this.hero.hp < this.hero.maxHp) {
        const onNode = this.witchObjectives.some(
          obj => obj.col === this.hero.col && obj.row === this.hero.row
        );
        if (onNode) {
          this.hero.heal(1);
          this.addLog(`✨ The hero draws power from the node. (+1 HP, now ${this.hero.hp}/${this.hero.maxHp})`);
        }
      }

      this.activePlayer = Player.WITCH;
      this.actionsLeft  = computeActions(Player.WITCH, this.phase, this.entities);
      this.addLog(`The witch stirs… (${this.actionsLeft} actions)`);
    } else {
      // Node effects: only during NIGHT
      // • Witch standing on a node raises a free minion each night round.
      // • Hero standing on a node attracts a free survivor each night round.
      // Minions held by a minion (not the witch) no longer spawn — the witch
      // must commit herself to a node to fuel her army.
      if (this.phase === Phase.NIGHT) {
        for (const obj of this.witchObjectives) {
          const freeHex = () => getNeighbors(obj.col, obj.row).find(n => {
            const t = this.tiles.get(hexKey(n.col, n.row));
            return t && t.type !== TileType.RIVER &&
              !this.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
          });

          // Witch herself on the node → spawn minion
          const witchHere = this.witch?.alive &&
            this.witch.col === obj.col && this.witch.row === obj.row;
          if (witchHere) {
            const hex = freeHex();
            if (hex) {
              this.entities.push(createMinion(hex.col, hex.row));
              this.addLog(`🌑 The witch channels the node — a minion rises from the dark!`);
            }
          }

          // Hero on the node → attract a survivor
          const heroHere = this.hero.alive &&
            this.hero.col === obj.col && this.hero.row === obj.row;
          if (heroHere) {
            const hex = freeHex();
            if (hex) {
              const s = createSurvivor(hex.col, hex.row);
              s.owner = 'hero';
              if (Math.random() < 0.5) s.items['horse'] = 1;
              this.entities.push(s);
              const horseNote = s.items['horse'] ? ' (arrives on horseback!)' : '';
              this.addLog(`✨ The node calls to the living — a survivor emerges to join the hero!${horseNote}`);
            }
          }
        }
      }

      // End of full round — advance round and check phase
      this.activePlayer = Player.HERO;
      this.round++;

      const prevPhase = this.phase;
      this.phase = phaseForRound(this.round);

      this.actionsLeft = computeActions(Player.HERO, this.phase, this.entities);

      // Announce phase transitions
      if (this.phase !== prevPhase) {
        this._announcePhaseChange(prevPhase, this.phase);
      } else {
        this.addLog(
          `Round ${this.round} — ${PHASE_ICON[this.phase]} ${this.phase.toUpperCase()}` +
          ` (Hero: ${this.actionsLeft} actions)`
        );
      }

      // Night hazard: survivors in the open take attritionLevel damage
      if (this.phase === Phase.NIGHT) {
        this.lastNightDamage = [];
        this.lastHazardLog   = [];
        this._applyNightHazard(this.attritionLevel);
      }

      // Day hazard: witch minions/zombies/golems in the open take attritionLevel damage
      if (this.phase === Phase.DAY) {
        this.lastDayDamage = [];
        this.lastHazardLog = [];
        this._applyDayHazard(this.attritionLevel);
      }

      // Dawn: ramp attrition, reset explored tiles, check nodes
      if (this.phase === Phase.DAWN) {
        this.attritionLevel = Math.min(3, this.attritionLevel + 1);
        this.addLog(`🌅 A new dawn — cycle ${Math.ceil(this.round / CYCLE_LENGTH)}. Attrition rises to ${this.attritionLevel}!`);
        for (const [, t] of this.tiles) t.explored = false;
        if (!this.disableScoring) this._checkNodeObjectives(Phase.DAWN);
      }

      // Dusk: score nodes
      if (this.phase === Phase.DUSK) {
        if (!this.disableScoring) this._checkNodeObjectives(Phase.DUSK);
      }
    }

    this.entities.forEach(e => e.resetTurn());
    this.checkVictory();
  }

  _announcePhaseChange(from, to) {
    const messages = {
      [`${Phase.DAWN}->${Phase.DAY}`]:
        `☀ The sun rises. The light burns the undead in the open!`,
      [`${Phase.DAY}->${Phase.DUSK}`]:
        `🌇 Dusk falls. Seek shelter before night. Neither side has advantage.`,
      [`${Phase.DUSK}->${Phase.NIGHT}`]:
        `🌙 Night descends! The witch grows powerful. Survivors in the open will suffer!`,
      [`${Phase.NIGHT}->${Phase.DAWN}`]:
        `🌅 Dawn breaks. The darkness retreats. Find cover for the coming night.`,
    };
    const key = `${from}->${to}`;
    this.addLog(messages[key] || `Phase changed: ${to.toUpperCase()}`);
    this.addLog(
      `Round ${this.round} — ${PHASE_ICON[to]} ${to.toUpperCase()}` +
      ` (Hero: ${this.actionsLeft} actions)`
    );
  }

  _applyNightHazard(dmg = 1) {
    // Only SURVIVORS in the open take night damage — the hero is hardened against it.
    // Fortified hexes shelter their occupants.
    const endangered = this.entities.filter(e => {
      if (!e.alive || e.type !== EntityType.SURVIVOR) return false;
      const t = this.tiles.get(hexKey(e.col, e.row));
      return !(t && t.type === TileType.BUILDING);
    });

    if (dmg > 0) {
      for (const e of endangered) {
        const t = this.tiles.get(hexKey(e.col, e.row));
        if (t && t.fortifyLevel > 0) {
          const line = `🏰 ${e.displayName} is sheltered by the fort! (level ${t.fortifyLevel})`;
          this.addLog(line);
          this.lastHazardLog.push({ text: line, entityId: e.id, ownerId: e.ownerId ?? null });
          continue;
        }
        this.lastNightDamage.push({ col: e.col, row: e.row, dmg });
        const killed = e.takeDamage(dmg);
        const line = killed
          ? `💀 ${e.displayName} is consumed by the night!`
          : `🌙 ${e.displayName} suffers in the open! (-${dmg} HP, ${e.hp}/${e.maxHp} remaining)`;
        this.addLog(line);
        this.lastHazardLog.push({ text: line, entityId: e.id, ownerId: e.ownerId ?? null });
        if (killed) this.entities = this.entities.filter(x => x.id !== e.id);
      }
    }
    if (endangered.length === 0 || dmg === 0) {
      this.addLog(`🌙 Night falls. Survivors are safe for now.`);
    }
  }

  _applyDayHazard(dmg = 1) {
    // Witch minions, zombies, and golems caught in the open during daylight take dmg damage.
    // Fortified hexes shelter their occupants from hazard damage.
    const sunburned = this.entities.filter(e => {
      if (!e.alive || e.owner !== 'witch') return false;
      if (e.type === EntityType.WITCH) return false;
      const t = this.tiles.get(hexKey(e.col, e.row));
      return !(t && t.type === TileType.BUILDING);
    });

    if (dmg > 0) {
      for (const e of sunburned) {
        const t = this.tiles.get(hexKey(e.col, e.row));
        if (t && t.fortifyLevel > 0) {
          const line = `🏰 ${e.displayName} is sheltered by the fort! (level ${t.fortifyLevel})`;
          this.addLog(line);
          this.lastHazardLog.push({ text: line, entityId: e.id, ownerId: e.ownerId ?? null });
          continue;
        }
        this.lastDayDamage.push({ col: e.col, row: e.row, dmg });
        const killed = e.takeDamage(dmg);
        const line = killed
          ? `💀 ${e.displayName} is destroyed by the light!`
          : `☀ ${e.displayName} is scorched in the open! (-${dmg} HP, ${e.hp}/${e.maxHp} remaining)`;
        this.addLog(line);
        this.lastHazardLog.push({ text: line, entityId: e.id, ownerId: e.ownerId ?? null });
        if (killed) this.entities = this.entities.filter(x => x.id !== e.id);
      }
    }
    if (sunburned.length === 0 || dmg === 0) {
      this.addLog(`☀ Daylight. Witch units are sheltered or out of harm's way.`);
    }
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
      this.addLog('☀ The witch has been defeated! Salem is saved!');
      return;
    }
    // All hero leaders eliminated → witches win
    if (this.factionEliminated('hero')) {
      this.winner    = 'witch';
      this.winReason = WIN_REASON.HERO_SLAIN;
      this.addLog('🌙 The heroes have fallen. Darkness descends on Salem forever…');
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
        ? '🌙 As dawn breaks, the witch holds all Power Nodes! Salem is lost…'
        : '🌙 As dusk falls, the witch holds all Power Nodes! The ritual advances!');
      return;
    }
    if (heroCount === nodeCount) {
      this.winner    = 'hero';
      this.winReason = isDawn ? WIN_REASON.NODES_HERO : WIN_REASON.NODES_HERO_DUSK;
      this.addLog(isDawn
        ? '☀ At dawn, the hero holds all Power Nodes! The witch\'s ritual is broken!'
        : '☀ As dusk falls, the hero holds all Power Nodes! The ritual is disrupted!');
      return;
    }

    // Scoring: whoever controls more nodes scores 1 point (ties score nothing)
    if (witchCount > heroCount) {
      this.nodeScore.witch++;
      this.addLog(`🌙 At ${phaseLabel}: witch leads ${witchCount}–${heroCount}. Score — Witch ${this.nodeScore.witch} / Hero ${this.nodeScore.hero}`);
      if (this.nodeScore.witch >= 4) {
        this.winner    = 'witch';
        this.winReason = WIN_REASON.SCORE_WITCH;
        this.addLog('🌙 The witch has claimed three ritual moments — Salem falls to darkness!');
      }
    } else if (heroCount > witchCount) {
      this.nodeScore.hero++;
      this.addLog(`☀ At ${phaseLabel}: hero leads ${heroCount}–${witchCount}. Score — Hero ${this.nodeScore.hero} / Witch ${this.nodeScore.witch}`);
      if (this.nodeScore.hero >= 4) {
        this.winner    = 'hero';
        this.winReason = WIN_REASON.SCORE_HERO;
        this.addLog('☀ The hero has broken the ritual three times — Salem is saved!');
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
          this.addLog(`🔵 The hero claims ${obj.label}.`);
        else if (ctrl === 'witch')
          this.addLog(`🔴 The witch seizes ${obj.label}.`);
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

  get gameOver() { return this.winner !== null; }

  addLog(msg, owner = null) {
    this.log.push(owner ? { text: msg, owner } : msg);
    if (this.log.length > 100) this.log.shift();
  }

  playerEntities(player) {
    return this.entities.filter(e => e.owner === player && e.alive);
  }

  // Scatter 12 hidden survivors across the map: 10 in buildings, 2 on terrain.
  // Each tile can hold at most one; they reveal when any unit steps onto the tile.
  _placeHiddenSurvivors() {
    const buildings = [];
    const terrain   = [];
    for (const t of this.tiles.values()) {
      if (t.type === TileType.RIVER) continue;
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

    const sc = this._survivorCounts ?? { buildings: 13, terrain: 2 };
    shuffle(buildings).slice(0, sc.buildings).forEach(t => { t.hiddenSurvivor = true; });
    shuffle(terrain).slice(0, sc.terrain).forEach(t => { t.hiddenSurvivor = true; });
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
