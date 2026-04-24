// Faction class hierarchy — encapsulates all faction-specific behavior.
// Factions are stateless singletons: they define behavior/config, not game state.
// Use getFaction(id) to look up a faction by its string id ('hero' | 'witch').
//
// Each Faction belongs to a Side ('day' | 'night'). Sides own the phase
// cycle, scoring, and team allocation; factions vary the stats, abilities,
// AI personalities, and unit roster within a side. See `src/sides.js`.

import { Phase } from './game.js';
import { EntityType, SurvivorAbility, createHero, createWitch, createSurvivor, createZombie, createMinion, createWoodGolem, createIronGolem, createRogue, createCaptain, createNecromancer, createBrute, isLeaderType } from './entities.js';
import { ResourceType, TileType, BuildingType } from './tiles.js';
import { hexKey, getNeighbors } from './hex.js';
import { AI_HERO_NAMES, AI_WITCH_NAMES } from './ai-names.js';
import { Side, getOpposingSide as _opposingSide } from './sides.js';

// ── Base Class ──────────────────────────────────────────────────────────────

export class Faction {
  /** @returns {string} Faction identifier — matches Player enum and entity.owner */
  get id()         { throw new Error('Subclass must implement id'); }
  /** @returns {string} Display name */
  get name()       { throw new Error('Subclass must implement name'); }
  /** @returns {string} EntityType of the faction leader */
  get leaderType() { throw new Error('Subclass must implement leaderType'); }
  /** @returns {string} Side id this faction belongs to ('day' | 'night'). */
  get side()       { throw new Error('Subclass must implement side'); }

  /**
   * Return the opposing Side id. Forward-looking N-faction API: use this
   * instead of `getOpponentId()` when the caller wants "who is on the
   * other team?" rather than "which single faction faces me?".
   */
  getOpposingSide() { return _opposingSide(this.side); }

  /**
   * True if this faction is shipped as a stub — registered and selectable
   * but inheriting parent-side behaviour rather than its own implementation.
   * Used by the lobby UI to render a "stub" badge so players know what to
   * expect before picking.
   */
  isStub() { return false; }

  // ── Action Budget ──

  /** Base actions per turn before bonuses */
  get baseBudget()   { return 3; }
  /** Hard cap on total actions after all bonuses */
  get actionCap()    { throw new Error('Subclass must implement actionCap'); }
  /** Max bonus actions from non-leader units */
  get unitBonusCap() { throw new Error('Subclass must implement unitBonusCap'); }

  /** Does this phase grant +1 time bonus? */
  isFavorablePhase(phase) { return false; }

  /**
   * Compute total action budget for a turn.
   * @param {string} phase - current game phase
   * @param {number} unitCount - number of non-leader units
   * @param {number} nodeBonus - number of held power nodes
   * @returns {number}
   */
  computeBudget(phase, unitCount, nodeBonus) {
    const timeBonus = this.isFavorablePhase(phase) ? 1 : 0;
    return Math.min(
      this.baseBudget + timeBonus + Math.min(unitCount, this.unitBonusCap) + nodeBonus,
      this.actionCap
    );
  }

  // ── Available Actions ──

  /** Can this faction fortify tiles? */
  canFortify()  { return false; }
  /** Can this faction summon units? */
  canSummon()   { return false; }
  /** Can this faction use hero-side shared items (food, silver, scripture)? */
  canUseItems() { return false; }
  /** Can this faction batter down enemy fortifications (BATTLE_HEX on an empty wall)? */
  canAssaultFortifications() { return false; }
  /** Is this faction blocked from moving onto impassable fortification walls? */
  isBlockedByWalls() { return false; }

  /**
   * Summon options with affordability info.
   * @param {object} inventory - the faction's resource inventory
   * @returns {Array<{summonType: string, affordable: boolean}>}
   */
  getSummonOptions(_inventory) { return []; }

  // ── Combat Modifiers ──

  /** Phase-based attack bonus for this faction's units */
  getPhaseCombatBonus(_phase) { return 0; }

  /** Defense fatigue penalty for units of this faction when defending */
  getDefenseFatigue(_defendCount) { return 0; }

  // ── Kill / Summon Tracking ──

  /**
   * Increment the kill counter for this faction's side. Delegates to the
   * side-keyed mutator on GameState so storage-field renames (PR 4b) can
   * land without touching the Faction hierarchy.
   */
  trackKill(state) { state.recordKillForSide(this.side); }

  /**
   * Increment the summon counter for this faction's side. Day-side calls
   * today are a no-op (no day-side summon mechanic), but routing through
   * the GameState mutator keeps the door open for future day factions.
   */
  trackSummon(state) { state.recordSummonForSide(this.side); }

  // ── End-of-Round Effects ──

  /**
   * Apply faction-specific end-of-round effects (healing, spawning, etc.)
   * @param {object} state - GameState
   * @returns {void} (mutates state directly, adds logs)
   */
  applyEndOfRoundEffects(_state) { /* default: nothing */ }

  // ── Discovery & Loot ──

  /**
   * Create the entity discovered when this faction explores a hidden survivor tile.
   * @returns {object} entity
   */
  createDiscoveryEntity(_col, _row, _ownerId, _state) {
    throw new Error('Subclass must implement createDiscoveryEntity');
  }

  /**
   * Build the log + encounter data for a discovery event.
   * @returns {{ encounterLog: string[], encounterSurvivor: object }}
   */
  buildDiscoveryResult(_entity) {
    throw new Error('Subclass must implement buildDiscoveryResult');
  }

  /** Can units of this faction carry horses? */
  canEquipHorse()  { return false; }
  /** Can units of this faction carry/equip weapons? */
  canEquipWeapon() { return false; }

  /** Does this entity currently have a horse equipped? */
  hasHorse(entity) {
    return this.canEquipHorse() && (entity.items?.['horse'] || 0) > 0;
  }

  /** Can this entity perform the explore action? */
  canExplore(_entity) { return true; }

  /** Can this faction discover and recruit NPCs (survivors) through exploration? */
  canDiscoverNPCs() { return false; }

  /** Return the opposing faction's id */
  getOpponentId() { throw new Error('Subclass must implement getOpponentId'); }

  /**
   * Return this faction's current action budget from game state. Pulls
   * from the side-keyed accessor on GameState; subclasses don't need to
   * override unless they layer on faction-specific bonuses.
   */
  getActionsLeft(state) { return state.actionsLeftForSide(this.side); }

  /** Return the node discovery key used on objective objects (e.g. 'seenByHero') */
  getNodeSeenKey() { throw new Error('Subclass must implement getNodeSeenKey'); }

  /**
   * Get the inventory object where this faction stores resources. Routes
   * through the side-keyed accessor on GameState — all factions on the
   * same side share one resource pool.
   *
   * @param {object} state - GameState
   * @returns {object} inventory map
   */
  getInventory(state) {
    return state.inventoryForSide(this.side);
  }

  /** Starting resources for this faction's inventory at game start */
  getStartingResources() { return {}; }

  /** Log message when this faction finds a resource */
  getResourceFoundLog(_actor, _lootType) { return ''; }

  // ── Visibility ──

  /**
   * Sight range for units of this faction.
   * @param {string} phase - current phase
   * @param {boolean} hasScout - whether the unit has SCOUT ability
   * @returns {number}
   */
  getSightRange(_phase, _hasScout) { return 2; }

  // ── Entity Registry ──

  /** Entity types that can serve as non-leader units for this faction */
  getUnitTypes() { return []; }

  /** Create the faction leader entity */
  createLeader(_col, _row, _ownerId, _state) {
    throw new Error('Subclass must implement createLeader');
  }

  // ── AI Hints ──

  /** Return the personality registry for this faction's AI */
  getPersonalities() { return {}; }

  /** Pool of AI display names used when filling AI seats. */
  getAINamePool() { return []; }
}

// ── Hero Faction ────────────────────────────────────────────────────────────

export class HeroFaction extends Faction {
  get id()         { return 'hero'; }
  get name()       { return 'Hero'; }
  get leaderType() { return EntityType.HERO; }
  get side()       { return Side.DAY; }

  // Action Budget
  get actionCap()    { return 8; }
  get unitBonusCap() { return 5; }

  isFavorablePhase(phase) {
    return phase === Phase.DAY || phase === Phase.DAWN;
  }

  // Available Actions
  canFortify()  { return true; }
  canUseItems() { return true; }

  // Combat
  getDefenseFatigue(defendCount) {
    return Math.floor((defendCount || 0) / 2);
  }

  getOpponentId() { return 'witch'; }
  getNodeSeenKey() { return 'seenByHero'; }

  // End-of-Round Effects
  applyEndOfRoundEffects(state) {
    this._applyBuildingHealing(state);
    this._applyNodeHealing(state);
    this._applyNodeSurvivorSpawning(state);
  }

  _applyBuildingHealing(state) {
    const heroLeaders = state.entities.filter(
      e => e.alive && e.owner === 'hero' && isLeaderType(e.type)
    );
    for (const hero of heroLeaders) {
      const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
      if (heroTile?.type === TileType.BUILDING && hero.hp < hero.maxHp) {
        const b = heroTile.building;
        if (b === BuildingType.INN) {
          hero.heal(3);
          state.addLog(`🏨 ${hero.displayName} rests at the inn. (+3 HP, now ${hero.hp}/${hero.maxHp})`, 'hero', state.playerColorFor(hero));
        } else if (b === BuildingType.CHURCH) {
          hero.heal(3);
          state.addLog(`⛪ ${hero.displayName} prays at the chapel. (+3 HP, now ${hero.hp}/${hero.maxHp})`, 'hero', state.playerColorFor(hero));
        } else {
          hero.heal(1);
          state.addLog(`🏠 ${hero.displayName} rests in shelter. (+1 HP, now ${hero.hp}/${hero.maxHp})`, 'hero', state.playerColorFor(hero));
        }
      }
    }
  }

  _applyNodeHealing(state) {
    const heroLeaders = state.entities.filter(
      e => e.alive && e.owner === 'hero' && isLeaderType(e.type)
    );
    for (const hero of heroLeaders) {
      if (hero.hp < hero.maxHp) {
        const onNode = state.witchObjectives.some(
          obj => obj.hexes.some(h => h.col === hero.col && h.row === hero.row)
        );
        if (onNode) {
          hero.heal(1);
          state.addLog(`✨ ${hero.displayName} draws power from the node. (+1 HP, now ${hero.hp}/${hero.maxHp})`, 'hero', state.playerColorFor(hero));
        }
      }
    }
  }

  _applyNodeSurvivorSpawning(state) {
    state.nodeSpawnedSurvivors = [];
    if (state.phase !== Phase.NIGHT) return;

    const heroLeaders = state.entities.filter(
      e => e.alive && e.owner === 'hero' && isLeaderType(e.type)
    );
    for (const obj of state.witchObjectives) {
      const freeHex = () => {
        for (const clusterHex of obj.hexes) {
          const n = getNeighbors(clusterHex.col, clusterHex.row).find(nb => {
            const t = state.tiles.get(hexKey(nb.col, nb.row));
            return t && t.type !== TileType.RIVER &&
              !state.entities.some(e => e.alive && e.col === nb.col && e.row === nb.row);
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
              const s = createSurvivor(hex.col, hex.row, hero.ownerId, state);
              s.owner = 'hero';
              if (Math.random() < 0.5) s.items['horse'] = 1;
              state.entities.push(s);
              const horseNote = s.items['horse'] ? ' (arrives on horseback!)' : '';
              state.addLog(`✨ The node calls to the living — a survivor emerges!${horseNote}`, 'hero', state.playerColorFor(hero));
              state.nodeSpawnedSurvivors.push({
                type: 'survivor',
                name: s.name,
                title: s.title,
                hp: s.hp, maxHp: s.maxHp,
                attack: s.getAttack(), defense: s.getDefense(),
                abilityLabel: s.abilityLabel,
                color: s.color,
              });
            }
          } else {
            state.addLog(`✨ The node pulses faintly… no one answers the call tonight.`, 'hero');
          }
        }
      }
    }
  }

  // Discovery & Loot
  createDiscoveryEntity(col, row, ownerId, state = null) {
    const s = createSurvivor(col, row, ownerId, state);
    s.owner = 'hero';
    return s;
  }

  buildDiscoveryResult(entity) {
    const abilityNote = entity.abilityLabel ? ` · ${entity.abilityLabel}` : '';
    return {
      encounterLog: [
        `☺ ${entity.name} the ${entity.title} steps out of hiding and joins the party! (HP ${entity.hp}/${entity.maxHp} · ATK ${entity.getAttack()} · DEF ${entity.getDefense()}${abilityNote})`
      ],
      encounterSurvivor: {
        type: 'survivor',
        name: entity.name, title: entity.title,
        hp: entity.hp, maxHp: entity.maxHp,
        attack: entity.getAttack(), defense: entity.getDefense(),
        abilityLabel: entity.abilityLabel,
        color: entity.color,
      },
    };
  }

  canEquipHorse()  { return true; }
  canEquipWeapon() { return true; }
  canDiscoverNPCs() { return true; }

  getStartingResources() { return { [ResourceType.FOOD]: 2 }; }

  getResourceFoundLog(actor, _lootType) {
    return `Found ${_lootType}! Added to shared supplies.`;
  }

  // Visibility — phase-dependent, scout bonus
  getSightRange(phase, hasScout = false) {
    let base;
    switch (phase) {
      case Phase.DAY:   base = 3; break;
      case Phase.NIGHT: base = 1; break;
      default:          base = 2; break; // DAWN, DUSK
    }
    return base + (hasScout ? 1 : 0);
  }

  // Entity Registry
  getUnitTypes() { return [EntityType.SURVIVOR]; }
  createLeader(col, row, ownerId, state = null) { return createHero(col, row, ownerId, state); }

  // AI Names
  getAINamePool() { return AI_HERO_NAMES; }
}

// ── Witch Faction ───────────────────────────────────────────────────────────

export class WitchFaction extends Faction {
  get id()         { return 'witch'; }
  get name()       { return 'Witch'; }
  get leaderType() { return EntityType.WITCH; }
  get side()       { return Side.NIGHT; }

  // Action Budget
  get actionCap()    { return 8; }
  get unitBonusCap() { return 3; }

  isFavorablePhase(phase) {
    return phase === Phase.NIGHT;
  }

  // Available Actions
  canSummon() { return true; }
  canAssaultFortifications() { return true; }
  isBlockedByWalls() { return true; }

  getSummonOptions(inventory) {
    const metal = inventory[ResourceType.METAL] || 0;
    const wood  = inventory[ResourceType.WOOD]  || 0;
    const total = Object.values(inventory).reduce((s, v) => s + (v || 0), 0);
    if (total < 2) return [];
    return [
      { summonType: EntityType.IRON_GOLEM, affordable: metal >= 2 },
      { summonType: EntityType.WOOD_GOLEM, affordable: wood  >= 2 },
      { summonType: EntityType.MINION,     affordable: true },
    ];
  }

  // Combat
  getPhaseCombatBonus(phase) {
    return phase === Phase.NIGHT ? 2 : 0;
  }

  // Only a night-side leader can explore (summoned units can't).
  canExplore(entity) { return isLeaderType(entity.type) && entity.owner === 'witch'; }

  getOpponentId() { return 'hero'; }
  getNodeSeenKey() { return 'seenByWitch'; }

  // Discovery & Loot
  createDiscoveryEntity(col, row, ownerId, state = null) {
    return createZombie(col, row, ownerId, state);
  }

  buildDiscoveryResult(entity) {
    return {
      encounterLog: [
        `† A cowering survivor is found… raised as a zombie! (HP ${entity.hp}/${entity.maxHp} · ATK ${entity.getAttack()} · DEF ${entity.getDefense()})`
      ],
      encounterSurvivor: {
        type: 'zombie',
        name: 'Zombie',
        hp: entity.hp, maxHp: entity.maxHp,
        attack: entity.getAttack(), defense: entity.getDefense(),
        color: entity.color,
      },
    };
  }

  getStartingResources() { return { [ResourceType.WOOD]: 2, [ResourceType.METAL]: 2 }; }

  getResourceFoundLog(actor, lootType) {
    return `${actor.displayName} secures ${lootType} for dark rituals.`;
  }

  // Visibility — fixed 2 hex range, no phase dependency
  getSightRange(_phase, _hasScout) { return 2; }

  // Entity Registry
  getUnitTypes() {
    return [EntityType.ZOMBIE, EntityType.MINION, EntityType.WOOD_GOLEM, EntityType.IRON_GOLEM];
  }
  createLeader(col, row, ownerId, state = null) { return createWitch(col, row, ownerId, state); }

  // AI Names
  getAINamePool() { return AI_WITCH_NAMES; }
}

// ── Stub Factions (PR 5) ────────────────────────────────────────────────────
// Each stub extends its side's primary faction. It overrides identity (id,
// name, leaderType, AI name pool) and reports `isStub() === true` so the
// lobby UI can render a stub badge. All other behaviour — combat, summon,
// fortify, end-of-round effects, discovery, sight — inherits from the
// parent, so the stub is mechanically the parent faction with different
// stats baked into the leader entity (via the new EntityType + BASE_STATS
// entries in entities.js).

export class RogueFaction extends HeroFaction {
  get id()         { return 'rogue'; }
  get name()       { return 'Rogue'; }
  get leaderType() { return EntityType.ROGUE; }
  isStub()         { return true; }
  createLeader(col, row, ownerId, state = null) {
    return createRogue(col, row, ownerId, state);
  }
}

export class CaptainFaction extends HeroFaction {
  get id()         { return 'captain'; }
  get name()       { return 'Captain'; }
  get leaderType() { return EntityType.CAPTAIN; }
  isStub()         { return true; }
  createLeader(col, row, ownerId, state = null) {
    return createCaptain(col, row, ownerId, state);
  }
}

export class NecromancerFaction extends WitchFaction {
  get id()         { return 'necromancer'; }
  get name()       { return 'Necromancer'; }
  get leaderType() { return EntityType.NECROMANCER; }
  isStub()         { return true; }
  createLeader(col, row, ownerId, state = null) {
    return createNecromancer(col, row, ownerId, state);
  }
}

export class BruteFaction extends WitchFaction {
  get id()         { return 'brute'; }
  get name()       { return 'Brute'; }
  get leaderType() { return EntityType.BRUTE; }
  isStub()         { return true; }
  createLeader(col, row, ownerId, state = null) {
    return createBrute(col, row, ownerId, state);
  }
}

// ── Faction Registry ────────────────────────────────────────────────────────

const _hero        = new HeroFaction();
const _rogue       = new RogueFaction();
const _captain     = new CaptainFaction();
const _witch       = new WitchFaction();
const _necromancer = new NecromancerFaction();
const _brute       = new BruteFaction();

// Day side first (paladin → rogue → captain), then night side
// (witch → necromancer → brute). Iteration order in the lobby picker
// follows this order.
const FACTIONS = Object.freeze({
  hero:        _hero,
  rogue:       _rogue,
  captain:     _captain,
  witch:       _witch,
  necromancer: _necromancer,
  brute:       _brute,
});

/**
 * Look up a Faction by its string id. Recognised ids:
 *   day side   — 'hero', 'rogue', 'captain'
 *   night side — 'witch', 'necromancer', 'brute'
 * @param {string} id
 * @returns {Faction}
 */
export function getFaction(id) {
  const f = FACTIONS[id];
  if (!f) throw new Error(`Unknown faction: ${id}`);
  return f;
}

/**
 * Non-throwing variant of `getFaction`. Returns `null` when the id is
 * unknown (or falsy). Callers that want to gracefully handle bad data
 * from the wire should prefer this over wrapping `getFaction` in a
 * try/catch.
 */
export function findFaction(id) {
  return FACTIONS[id] ?? null;
}

/** Return all registered factions. */
export function allFactions() {
  return Object.values(FACTIONS);
}

/**
 * Return every registered Faction belonging to the given Side, in
 * registration order. Empty array if the side id is unknown.
 *
 * Today: day → [hero], night → [witch]. As stub factions register in
 * later PRs the lists grow; lobby and UI code should iterate this rather
 * than hardcoding faction ids per side.
 *
 * @param {string} sideId — 'day' or 'night'
 * @returns {Faction[]}
 */
export function getFactionsForSide(sideId) {
  return allFactions().filter(f => f.side === sideId);
}

/**
 * Look up the Side id for a faction id. Returns null if the faction is
 * unknown — callers in legacy/synthetic code paths sometimes pass null
 * or a stub id during state restore.
 *
 * @param {string} factionId
 * @returns {string|null} 'day' | 'night' | null
 */
export function sideOf(factionId) {
  const f = FACTIONS[factionId];
  return f ? f.side : null;
}
