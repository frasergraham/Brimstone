// Faction class hierarchy — encapsulates all faction-specific behavior.
// Factions are stateless singletons: they define behavior/config, not game state.
// Use getFaction(id) to look up a faction by its string id ('hero' | 'witch').

import { Phase } from './game.js';
import { EntityType, SurvivorAbility, createHero, createWitch, createSurvivor, createZombie, createMinion, createWoodGolem, createIronGolem } from './entities.js';
import { ResourceType, TileType, BuildingType } from './tiles.js';
import { hexKey, getNeighbors } from './hex.js';

// ── Base Class ──────────────────────────────────────────────────────────────

export class Faction {
  /** @returns {string} Faction identifier — matches Player enum and entity.owner */
  get id()         { throw new Error('Subclass must implement id'); }
  /** @returns {string} Display name */
  get name()       { throw new Error('Subclass must implement name'); }
  /** @returns {string} EntityType of the faction leader */
  get leaderType() { throw new Error('Subclass must implement leaderType'); }

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

  /** Increment the appropriate kill counter on state for this faction */
  trackKill(_state) { /* default: nothing */ }

  /** Increment the appropriate summon counter on state for this faction */
  trackSummon(_state) { /* default: nothing */ }

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
  createDiscoveryEntity(_col, _row, _ownerId) {
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

  /** Return this faction's current action budget from game state */
  getActionsLeft(_state) { throw new Error('Subclass must implement getActionsLeft'); }

  /** Return the node discovery key used on objective objects (e.g. 'seenByHero') */
  getNodeSeenKey() { throw new Error('Subclass must implement getNodeSeenKey'); }

  /**
   * Get the inventory object where this faction stores resources.
   * @param {object} state - GameState
   * @returns {object} inventory map
   */
  getInventory(_state) {
    throw new Error('Subclass must implement getInventory');
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
  createLeader(col, row, ownerId) {
    throw new Error('Subclass must implement createLeader');
  }

  // ── AI Hints ──

  /** Return the personality registry for this faction's AI */
  getPersonalities() { return {}; }
}

// ── Hero Faction ────────────────────────────────────────────────────────────

export class HeroFaction extends Faction {
  get id()         { return 'hero'; }
  get name()       { return 'Hero'; }
  get leaderType() { return EntityType.HERO; }

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

  trackKill(state) { state.heroKills++; }

  getOpponentId() { return 'witch'; }
  getActionsLeft(state) { return state.heroActionsLeft; }
  getNodeSeenKey() { return 'seenByHero'; }

  // End-of-Round Effects
  applyEndOfRoundEffects(state) {
    this._applyBuildingHealing(state);
    this._applyNodeHealing(state);
    this._applyNodeSurvivorSpawning(state);
  }

  _applyBuildingHealing(state) {
    const heroLeaders = state.entities.filter(
      e => e.alive && e.type === EntityType.HERO
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
      e => e.alive && e.type === EntityType.HERO
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
      e => e.alive && e.type === EntityType.HERO
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
              const s = createSurvivor(hex.col, hex.row, hero.ownerId);
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
                attack: s.attack, defense: s.defense,
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
  createDiscoveryEntity(col, row, ownerId) {
    const s = createSurvivor(col, row, ownerId);
    s.owner = 'hero';
    return s;
  }

  buildDiscoveryResult(entity) {
    const abilityNote = entity.abilityLabel ? ` · ${entity.abilityLabel}` : '';
    return {
      encounterLog: [
        `☺ ${entity.name} the ${entity.title} steps out of hiding and joins the party! (HP ${entity.hp}/${entity.maxHp} · ATK ${entity.attack} · DEF ${entity.defense}${abilityNote})`
      ],
      encounterSurvivor: {
        type: 'survivor',
        name: entity.name, title: entity.title,
        hp: entity.hp, maxHp: entity.maxHp,
        attack: entity.attack, defense: entity.defense,
        abilityLabel: entity.abilityLabel,
        color: entity.color,
      },
    };
  }

  canEquipHorse()  { return true; }
  canEquipWeapon() { return true; }
  canDiscoverNPCs() { return true; }

  getInventory(state) { return state.inventory.hero; }

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
  createLeader(col, row, ownerId) { return createHero(col, row, ownerId); }
}

// ── Witch Faction ───────────────────────────────────────────────────────────

export class WitchFaction extends Faction {
  get id()         { return 'witch'; }
  get name()       { return 'Witch'; }
  get leaderType() { return EntityType.WITCH; }

  // Action Budget
  get actionCap()    { return 8; }
  get unitBonusCap() { return 3; }

  isFavorablePhase(phase) {
    return phase === Phase.NIGHT;
  }

  // Available Actions
  canSummon() { return true; }

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

  trackKill(state) { state.witchKills++; }
  trackSummon(state) { state.witchSummonCount++; }

  canExplore(entity) { return entity.type === EntityType.WITCH; }

  getOpponentId() { return 'hero'; }
  getActionsLeft(state) { return state.witchActionsLeft; }
  getNodeSeenKey() { return 'seenByWitch'; }

  // Discovery & Loot
  createDiscoveryEntity(col, row, ownerId) {
    return createZombie(col, row, ownerId);
  }

  buildDiscoveryResult(entity) {
    return {
      encounterLog: [
        `† A cowering survivor is found… raised as a zombie! (HP ${entity.hp}/${entity.maxHp} · ATK ${entity.attack} · DEF ${entity.defense})`
      ],
      encounterSurvivor: {
        type: 'zombie',
        name: 'Zombie',
        hp: entity.hp, maxHp: entity.maxHp,
        attack: entity.attack, defense: entity.defense,
        color: entity.color,
      },
    };
  }

  getInventory(state) { return state.inventory.witch; }

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
  createLeader(col, row, ownerId) { return createWitch(col, row, ownerId); }
}

// ── Faction Registry ────────────────────────────────────────────────────────

const _hero  = new HeroFaction();
const _witch = new WitchFaction();

const FACTIONS = Object.freeze({
  hero:  _hero,
  witch: _witch,
});

/**
 * Look up a Faction by its string id.
 * @param {string} id - 'hero' or 'witch'
 * @returns {Faction}
 */
export function getFaction(id) {
  const f = FACTIONS[id];
  if (!f) throw new Error(`Unknown faction: ${id}`);
  return f;
}

/** Return all registered factions. */
export function allFactions() {
  return Object.values(FACTIONS);
}
