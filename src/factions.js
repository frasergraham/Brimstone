// Faction class hierarchy — encapsulates all faction-specific behavior.
// Factions are stateless singletons: they define behavior/config, not game state.
// Use getFaction(id) to look up a faction by its string id ('hero' | 'witch').
//
// Each Faction belongs to a Side ('day' | 'night'). Sides own the phase
// cycle, scoring, and team allocation; factions vary the stats, abilities,
// AI personalities, and unit roster within a side. See `src/sides.js`.

import { Phase } from './game.js';
import { EntityType, SurvivorAbility, createHero, createWitch, createSurvivor, createZombie, createMinion, createWoodGolem, createIronGolem, createRogue, createCaptain, createNecromancer, createBrute, isLeaderType, getItemCountOf, totalItemCount } from './entities.js';
import { ResourceType, BuildingType, rollLoot, hasBuilding, isRiver } from './tiles.js';
import { hexKey, getNeighbors } from './hex.js';
import { AI_HERO_NAMES, AI_WITCH_NAMES } from './ai-names.js';
import { Side, getOpposingSide as _opposingSide } from './sides.js';
import { ITEMS } from './items.js';
import { DAMAGE_SCALE } from './balance.js';
import { triggerSurvivorEncounter } from './survivor-discovery.js';

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
   * Bonus splash radius around the target hex when this faction's unit
   * lands a hit that triggers splash. 0 = vanilla splash (only same-hex
   * bystanders). 1 = also damage units on the 6 neighbouring hexes —
   * the brute's signature blast.
   */
  crushSplashRadius() { return 0; }

  /**
   * If true, splash fires on every melee hit (not just crush / kill).
   * Default vanilla rule: splash is a crush-only mechanic.
   */
  splashesOnEveryHit() { return false; }

  /**
   * If true, splash skips units owned by this faction's side. Default
   * is friendly fire on — splash is indiscriminate.
   */
  splashSparesAllies() { return false; }

  /**
   * If true, splashed bystanders are knocked back one hex outward from
   * the target (when the push destination is open terrain).
   */
  splashKnockback() { return false; }

  /**
   * Resource cost for summoning a Minion. Defaults to 2 (witch's value)
   * — overridden by faction stubs that want cheaper chaff (brute = 1).
   */
  getMinionCost() { return 2; }

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
   * `level` is the optional authored spawn level (default 1) for campaign tiles.
   * @returns {object} entity
   */
  createDiscoveryEntity(_col, _row, _ownerId, _state, _forcedSurvivorId, _level) {
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

  /**
   * Per-item equip gate. Defaults to the blanket canEquipWeapon() check;
   * subclasses can refine by item category (e.g. rogue: ranged-only).
   * Weapons that name `wielderFactions` (e.g. Magic Bolt) are restricted to
   * those factions regardless of the blanket check. Pass an unknown id and
   * you get false.
   * @param {string} itemId — ITEMS registry id
   */
  canEquipWeaponItem(itemId) {
    const item = ITEMS[itemId];
    if (item?.wielderFactions && !item.wielderFactions.includes(this.id)) return false;
    return this.canEquipWeapon();
  }

  /** Does this entity currently have a horse equipped? */
  hasHorse(entity) {
    return this.canEquipHorse() && (entity.items?.['horse']?.count ?? 0) > 0;
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

  // ── Explore & Move Hooks ──

  /**
   * Hook to modify a single loot roll before it's applied. Receives the
   * raw rolled type and the loot table (so subclasses can re-roll, filter
   * 'nothing', etc.) and returns the (possibly substituted) type to grant.
   * Default: pass through.
   *
   * Called once per roll — re-rolls are the implementer's responsibility.
   * @param {object} state
   * @param {object} actor
   * @param {Array<{type:string,weight:number}>} table
   * @param {string} lootType
   * @returns {string}
   */
  modifyLootRoll(_state, _actor, _table, lootType) { return lootType; }

  /**
   * Hook to grant bonus loot after a primary roll has been applied. The
   * faction calls `grantExtra()` to request another roll-and-apply pass.
   * Default: agility-driven double-resource chance — any high-agility
   * actor gets an occasional extra roll on resource drops. Subclasses
   * can override to implement other bonus mechanics.
   *
   * Skips horses, 'nothing', and weapons (the intent is "double resources",
   * not "two horses" or "two swords"). The weapon gate is delegated to
   * the caller — pass `isWeapon: true` for weapon drops.
   *
   * @param {object} state
   * @param {object} actor
   * @param {string} lootType
   * @param {() => void} grantExtra — invoke to trigger another roll
   * @param {{isWeapon: boolean}} opts
   */
  applyExploreLootBonus(_state, actor, lootType, grantExtra, opts = {}) {
    if (lootType === 'nothing' || lootType === 'horse') return;
    if (opts.isWeapon) return;
    const agi = (typeof actor.getAgility === 'function')
      ? actor.getAgility()
      : (actor.agility ?? 0);
    // (agi - 6) * 0.15, clamped [0, 0.5]: rogue (8) → 30%, paladin (6) → 0%,
    // captain/witch (5) → 0%, slower units → 0%. The bonus is intentionally
    // gated above the standard leader agility so the 1v1 baseline doesn't
    // shift — only the rogue (and any future agility-8+ unit) gets it.
    const chance = Math.max(0, Math.min(0.5, (agi - 6) * 0.15));
    if (Math.random() < chance) grantExtra();
  }

  /**
   * Called after the actor finishes each move-step. Returns
   * `{ encounterLog, encounterSurvivor } | null` — the executeMove loop
   * merges any encounter into its outgoing log/state. Default: no-op.
   *
   * The phase-random survivor reveal in executeMove stays inline (it's
   * shared-side behaviour, not faction-specific). This hook is for
   * faction-specific triggers, e.g. the rogue's auto-detect-on-move.
   *
   * @param {object} state
   * @param {object} actor
   * @param {number} col
   * @param {number} row
   * @returns {{encounterLog: string[], encounterSurvivor: object} | null}
   */
  onAfterMoveStep(_state, _actor, _col, _row) { return null; }

  // ── Visibility ──

  /**
   * Sight range for units of this faction.
   * @param {string} phase - current phase
   * @param {boolean} hasScout - whether the unit has SCOUT ability
   * @returns {number}
   */
  getSightRange(_phase, _hasScout) { return 5; }

  // ── Entity Registry ──

  /** Entity types that can serve as non-leader units for this faction */
  getUnitTypes() { return []; }

  /**
   * Ability ids every leader of this faction is born with. Pushed onto
   * `entity.abilities` by `createLeader()`. Phase 5 of the units/items/
   * abilities refactor — day-side leaders get `'sound_horn'`, night-side
   * leaders get `'summon'`. Stub factions inherit their parent's list;
   * a concrete stub that grows a unique ability overrides this getter
   * and returns the parent list plus its own additions.
   */
  get innateLeaderAbilities() { return []; }

  /**
   * Weapon every leader of this faction starts with equipped (ITEMS id),
   * or null for an unarmed/melee leader. Range is weapon-derived, so this
   * is also how a leader gets its innate reach (Rogue → bow = range 3,
   * Witch/Necromancer → magic_bolt = range 2). Applied by createLeader();
   * deserialize bypasses it and restores the saved weapon instead.
   */
  get innateLeaderWeapon() { return null; }

  /**
   * Create the faction leader entity. Subclasses override `_buildLeader`
   * to pick the correct EntityType factory; the base class handles the
   * faction-innate ability push and starting-weapon equip so every leader
   * is born correctly regardless of which concrete factory runs.
   */
  createLeader(col, row, ownerId, state) {
    const e = this._buildLeader(col, row, ownerId, state);
    for (const id of this.innateLeaderAbilities) {
      if (!e.abilities.includes(id)) e.abilities.push(id);
    }
    if (this.innateLeaderWeapon) e.equipWeapon(this.innateLeaderWeapon);
    // A horn-trained leader (sound_horn) is issued a Horn — the reusable key
    // item the Sound Horn action gates on (see getValidActions /
    // executeSoundHorn). Factions that strip sound_horn (e.g. Rogue) get none.
    // In campaigns this innate horn is replaced by the carried backpack at
    // mission start (applyCarriedHeroLoadout), so the hero re-finds it in Ch1 M4.
    if (e.hasAbility('sound_horn') && !e.hasItem('horn')) e.addItem('horn');
    return e;
  }

  /** Subclass hook — return a freshly constructed leader Entity. */
  _buildLeader(_col, _row, _ownerId, _state) {
    throw new Error('Subclass must implement _buildLeader');
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
      if (hasBuilding(heroTile) && hero.hp < hero.maxHp) {
        const b = heroTile.building;
        if (b === BuildingType.INN) {
          const amt = 3 * DAMAGE_SCALE;
          hero.heal(amt);
          state.addLog(`🏨 ${hero.displayName} rests at the inn. (+${amt} HP, now ${hero.hp}/${hero.maxHp})`, 'hero', state.playerColorFor(hero));
        } else if (b === BuildingType.CHURCH) {
          const amt = 3 * DAMAGE_SCALE;
          hero.heal(amt);
          state.addLog(`⛪ ${hero.displayName} prays at the chapel. (+${amt} HP, now ${hero.hp}/${hero.maxHp})`, 'hero', state.playerColorFor(hero));
        } else {
          const amt = 1 * DAMAGE_SCALE;
          hero.heal(amt);
          state.addLog(`🏠 ${hero.displayName} rests in shelter. (+${amt} HP, now ${hero.hp}/${hero.maxHp})`, 'hero', state.playerColorFor(hero));
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
          const amt = 1 * DAMAGE_SCALE;
          hero.heal(amt);
          state.addLog(`✨ ${hero.displayName} draws power from the node. (+${amt} HP, now ${hero.hp}/${hero.maxHp})`, 'hero', state.playerColorFor(hero));
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
            return t && !isRiver(t) &&
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
              // Node-spawned survivors are procedural, so the spawn level is 1
              // today — but the level is plumbed end-to-end (createSurvivor →
              // descriptor) so a future chapter can scale them up by raising
              // this single value.
              const spawnLevel = 1;
              const s = createSurvivor(hex.col, hex.row, hero.ownerId, state, null, spawnLevel);
              s.owner = 'hero';
              if (Math.random() < 0.5) s.addItem('horse');
              state.entities.push(s);
              const horseNote = s.hasItem('horse') ? ' (arrives on horseback!)' : '';
              state.addLog(`✨ The node calls to the living — a survivor emerges!${horseNote}`, 'hero', state.playerColorFor(hero));
              state.nodeSpawnedSurvivors.push({
                id: s.id,
                type: 'survivor',
                name: s.name,
                title: s.title,
                hp: s.hp, maxHp: s.maxHp,
                attack: s.getAttack(), defense: s.getDefense(),
                level: s.level || 1,
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
  createDiscoveryEntity(col, row, ownerId, state = null, forcedSurvivorId = null, level = 1) {
    const s = createSurvivor(col, row, ownerId, state, forcedSurvivorId, level || 1);
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
        id: entity.id,
        type: 'survivor',
        name: entity.name, title: entity.title,
        hp: entity.hp, maxHp: entity.maxHp,
        attack: entity.getAttack(), defense: entity.getDefense(),
        level: entity.level || 1,
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

  // Visibility — phase-dependent base range (LOS-blocked by buildings/forests
  // in computeLineOfSight). Day 6, Dawn/Dusk 4, Night 3. Scout adds +1.
  getSightRange(phase, hasScout = false) {
    let base;
    switch (phase) {
      case Phase.DAY:   base = 6; break;
      case Phase.NIGHT: base = 3; break;
      default:          base = 4; break; // DAWN, DUSK
    }
    return base + (hasScout ? 1 : 0);
  }

  // Entity Registry
  getUnitTypes() { return [EntityType.SURVIVOR]; }
  _buildLeader(col, row, ownerId, state = null) { return createHero(col, row, ownerId, state); }

  // Day-side leaders are horn-trained (sound_horn). The ability marks who is
  // trained to wield a horn — and so who Faction.createLeader issues the Horn
  // key item to — but the Sound Horn action itself gates on holding the item
  // (getValidActions / executeSoundHorn read actor.hasItem('horn')).
  get innateLeaderAbilities() { return ['sound_horn']; }

  // The Paladin starts with a sword (melee, +2 ATK over base 2).
  get innateLeaderWeapon() { return 'sword'; }

  // AI Names
  getAINamePool() { return AI_HERO_NAMES; }
}

// ── Witch Faction ───────────────────────────────────────────────────────────

// ── Graveyard passive spawns (June 2026 design pass) ─────────────────────────
// The hero's income (survivor recruitment) compounds while every witch unit
// costs an action to summon. Graveyards mirror that income: a free zombie
// rises at the end of every full day-cycle, capped so the swarm stays small.
// Standard games only — battle mode and campaign missions keep their own
// tuned economies. Values validated by `node scripts/headless.js 500 standard`
// (see the introducing commit for the balance delta).
export const GRAVEYARD_SPAWN_INTERVAL = 8;  // rounds — one full dawn→night cycle
export const GRAVEYARD_ZOMBIE_CAP     = 2;  // max concurrent witch zombies

export class WitchFaction extends Faction {
  get id()         { return 'witch'; }
  get name()       { return 'Witch'; }
  get leaderType() { return EntityType.WITCH; }
  get side()       { return Side.NIGHT; }

  applyEndOfRoundEffects(state) {
    this._applyGraveyardSpawns(state);
  }

  _applyGraveyardSpawns(state) {
    // endRound() fires effects BEFORE the round counter advances, so
    // state.round is the round that just completed.
    if (state.round <= 0 || state.round % GRAVEYARD_SPAWN_INTERVAL !== 0) return;
    // Standard games only (battle/campaign economies are tuned separately).
    if (state.gameMode !== 'standard' || state.victoryDelegate || state.noWitchMission) return;

    // The rising dead serve the night side's leader.
    const leaders = state.entities.filter(
      e => e.alive && e.owner === this.id && isLeaderType(e.type)
    );
    if (leaders.length === 0) return;

    for (const [, t] of state.tiles) {
      if (t.building !== BuildingType.GRAVEYARD) continue;

      const zombies = state.entities.filter(
        e => e.alive && e.owner === this.id && e.type === EntityType.ZOMBIE
      );
      if (zombies.length >= GRAVEYARD_ZOMBIE_CAP) return;

      const spawn = this._graveyardSpawnHex(state, t);
      if (!spawn) continue;

      // Nearest leader claims the zombie (matters for NvN budgets/colors).
      const leader = leaders.reduce((best, l) => {
        const d  = Math.abs(l.col - t.col) + Math.abs(l.row - t.row);
        const bd = Math.abs(best.col - t.col) + Math.abs(best.row - t.row);
        return d < bd ? l : best;
      });
      const zombie = createZombie(spawn.col, spawn.row, leader.ownerId, state);
      state.entities.push(zombie);
      state.addLog('🪦 The graveyard stirs — a zombie claws free of the earth!', 'witch');
    }
  }

  /** Graveyard entrance if no enemy stands on it; else a free neighbour. */
  _graveyardSpawnHex(state, tile) {
    const enemyAt = (col, row) => state.entities.some(
      e => e.alive && e.owner !== this.id && e.col === col && e.row === row
    );
    if (!enemyAt(tile.col, tile.row)) return { col: tile.col, row: tile.row };
    for (const n of getNeighbors(tile.col, tile.row)) {
      const nt = state.tiles.get(hexKey(n.col, n.row));
      if (!nt || isRiver(nt) || nt.buildingFootprintOf || hasBuilding(nt)) continue;
      if (!enemyAt(n.col, n.row)) return { col: n.col, row: n.row };
    }
    return null;
  }

  // Action Budget
  get actionCap()    { return 8; }
  // Raised 3 → 4 in the weapons overhaul: ranged weapons only benefit the
  // hero's roster (summons/zombies/golems can't equip), so the witch needs
  // to convert more of its swarm into actions to keep contesting nodes —
  // the lever scales with unit count, recentring NvN without skewing 1v1.
  get unitBonusCap() { return 4; }

  isFavorablePhase(phase) {
    return phase === Phase.NIGHT;
  }

  // Available Actions
  canSummon() { return true; }
  canAssaultFortifications() { return true; }
  isBlockedByWalls() { return true; }

  getSummonOptions(inventory) {
    const metal = getItemCountOf(inventory, ResourceType.METAL);
    const wood  = getItemCountOf(inventory, ResourceType.WOOD);
    const total = totalItemCount(inventory);
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
        id: entity.id,
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

  // Visibility — fixed 5 hex range, no phase dependency (LOS-blocked).
  getSightRange(_phase, _hasScout) { return 5; }

  // Entity Registry
  getUnitTypes() {
    return [EntityType.ZOMBIE, EntityType.MINION, EntityType.WOOD_GOLEM, EntityType.IRON_GOLEM];
  }
  _buildLeader(col, row, ownerId, state = null) { return createWitch(col, row, ownerId, state); }

  // Phase 5: night-side leaders carry summon innately. The action-type
  // gate at src/actions.js no longer checks isLeaderType + owner — it
  // reads actor.hasAbility('summon').
  get innateLeaderAbilities() { return ['summon']; }

  // The Witch wields the Magic Bolt (her innate ranged attack, range 2).
  get innateLeaderWeapon() { return 'magic_bolt'; }

  // The Witch can equip only her faction-restricted weapon (Magic Bolt) —
  // never looted swords/bows. canEquipWeapon() stays false so the generic
  // equip flow doesn't surface mundane arms.
  canEquipWeaponItem(itemId) {
    return ITEMS[itemId]?.wielderFactions?.includes(this.id) === true;
  }

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
  // No isStub() override — the rogue has real distinct behaviour now
  // (ranged attack, melee-weapon ban, sight bonus, agility-loot bonus,
  //  building-survivor auto-detect, no Sound Horn).

  _buildLeader(col, row, ownerId, state = null) {
    return createRogue(col, row, ownerId, state);
  }

  // Drop sound_horn from the day-side innate set. Faction.createLeader
  // is the sole source of innate abilities (see entities.js cleanup),
  // so returning [] actually strips the inherited ability.
  get innateLeaderAbilities() { return []; }

  // The Rogue starts with a bow (range 3) instead of the Paladin's sword.
  get innateLeaderWeapon() { return 'bow'; }

  // Sight: +1 hex over paladin in every phase, with the same scout bonus.
  // Calls super so future tweaks to HeroFaction's day/dawn/night base
  // values flow through automatically.
  getSightRange(phase, hasScout = false) {
    return super.getSightRange(phase, hasScout) + 1;
  }

  // Cannot wield melee weapons. Bow / crossbow / firearms are fine, but
  // faction-restricted weapons (e.g. Magic Bolt) are still off-limits.
  canEquipWeaponItem(itemId) {
    if (!this.canEquipWeapon()) return false;
    const item = ITEMS[itemId];
    if (item?.wielderFactions && !item.wielderFactions.includes(this.id)) return false;
    return item?.category === 'ranged';
  }

  // Exploration never turns up empty. On a 'nothing' roll, re-roll once;
  // if that's also 'nothing', filter the table and pick from the rest.
  // The agility-driven double-resource bonus is inherited from the
  // Faction base class — rogue agility 8 → 30% chance per resource.
  modifyLootRoll(state, actor, table, lootType) {
    if (lootType !== 'nothing') return lootType;
    const reroll = rollLoot(table);
    if (reroll !== 'nothing') return reroll;
    const filtered = table.filter(e => e.type !== 'nothing');
    return filtered.length ? rollLoot(filtered) : lootType;
  }

  // After each move-step, scan the just-entered building tile + neighbouring
  // building tiles for hidden survivors and auto-trigger the encounter.
  // The rogue's keen eye spots people the paladin would walk past.
  onAfterMoveStep(state, actor, col, row) {
    const hits = [];
    const here = state.tiles.get(hexKey(col, row));
    if (hasBuilding(here) && here.hiddenSurvivor) {
      hits.push({ col, row });
    }
    for (const n of getNeighbors(col, row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (hasBuilding(t) && t.hiddenSurvivor) {
        hits.push({ col: n.col, row: n.row });
      }
    }
    if (!hits.length) return null;
    const encounterLog = [];
    let encounterSurvivor = null;
    for (const h of hits) {
      const enc = triggerSurvivorEncounter(state, actor, h.col, h.row);
      if (enc) {
        encounterLog.push(`👁 ${actor.displayName} senses someone hiding nearby!`);
        encounterLog.push(...enc.encounterLog);
        encounterSurvivor = enc.encounterSurvivor;
      }
    }
    return { encounterLog, encounterSurvivor };
  }
}

export class CaptainFaction extends HeroFaction {
  get id()         { return 'captain'; }
  get name()       { return 'Captain'; }
  get leaderType() { return EntityType.CAPTAIN; }
  isStub()         { return true; }
  // Stub melee leader — no starting weapon (keeps base stats unchanged).
  get innateLeaderWeapon() { return null; }
  _buildLeader(col, row, ownerId, state = null) {
    return createCaptain(col, row, ownerId, state);
  }
}

export class NecromancerFaction extends WitchFaction {
  get id()         { return 'necromancer'; }
  get name()       { return 'Necromancer'; }
  get leaderType() { return EntityType.NECROMANCER; }
  isStub()         { return true; }
  _buildLeader(col, row, ownerId, state = null) {
    return createNecromancer(col, row, ownerId, state);
  }
}

export class BruteFaction extends WitchFaction {
  get id()         { return 'brute'; }
  get name()       { return 'Brute'; }
  get leaderType() { return EntityType.BRUTE; }
  // No isStub() override — the brute has its own behaviour: cheap
  // minion-only summons, building survivor auto-zombify, and a meaty
  // splash blast that fires on every melee hit (knocks enemies back,
  // skips friendlies).

  // Melee bruiser — no Magic Bolt (overrides the WitchFaction default).
  get innateLeaderWeapon() { return null; }

  _buildLeader(col, row, ownerId, state = null) {
    return createBrute(col, row, ownerId, state);
  }

  // Splash radius around the target hex. 1 = also damage the 6
  // neighbouring hexes around the target.
  crushSplashRadius() { return 1; }

  // Splash fires on every melee hit, not just crushing blows. The
  // damage scales with the attacker's roll margin (see splashDamage).
  splashesOnEveryHit() { return true; }

  // Splash skips units owned by the attacker's faction. The brute can
  // wade into a swarm without nuking her own minions.
  splashSparesAllies() { return true; }

  // Splashed bystanders are knocked one hex outward from the target
  // (when the destination is open). Repositioning is the headline
  // tactical effect — the damage tax is secondary.
  splashKnockback() { return true; }

  // Brute summons only minions, and at a discount — 1 of any resource
  // instead of the witch's 2. Cheap chaff so she has bodies to soak
  // gang-up advantage while she swings her cleaver.
  getMinionCost() { return 1; }

  getSummonOptions(inventory) {
    const total = totalItemCount(inventory);
    if (total < this.getMinionCost()) return [];
    return [{ summonType: EntityType.MINION, affordable: true }];
  }

  // Auto-zombify on building proximity — same scan as the rogue's keen-eye
  // detection, but the WitchFaction.createDiscoveryEntity hook turns the
  // hidden survivor into a zombie instead of recruiting them.
  onAfterMoveStep(state, actor, col, row) {
    const hits = [];
    const here = state.tiles.get(hexKey(col, row));
    if (hasBuilding(here) && here.hiddenSurvivor) {
      hits.push({ col, row });
    }
    for (const n of getNeighbors(col, row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (hasBuilding(t) && t.hiddenSurvivor) {
        hits.push({ col: n.col, row: n.row });
      }
    }
    if (!hits.length) return null;
    const encounterLog = [];
    let encounterSurvivor = null;
    for (const h of hits) {
      const enc = triggerSurvivorEncounter(state, actor, h.col, h.row);
      if (enc) {
        encounterLog.push(`👹 ${actor.displayName} drags a cowering survivor from hiding!`);
        encounterLog.push(...enc.encounterLog);
        encounterSurvivor = enc.encounterSurvivor;
      }
    }
    return { encounterLog, encounterSurvivor };
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

// ── Faction lookup for entities ─────────────────────────────────────────────
// Two helpers, picked deliberately at each callsite. Stub-faction leaders
// (rogue, captain, necromancer, brute) keep the parent side's `owner`
// string — the concrete faction lives on `factionId`. The choice between
// these two helpers determines whether a hook honours stub-faction
// overrides or just uses the side default.

/**
 * Side faction — the parent faction for the entity's side. Use for
 * shared-side concerns: inventory, kill tracking, phase combat bonus,
 * end-of-round effects, the things ALL day-side / ALL night-side units
 * share. A rogue leader's `sideFactionOf()` returns HeroFaction even
 * though the rogue carries `factionId === 'rogue'`.
 */
export function sideFactionOf(entity) {
  return getFaction(entity.owner);
}

/**
 * Concrete faction — the entity's specific faction class. Use for
 * faction-specific hooks (modifyLootRoll, applyExploreLootBonus,
 * onAfterMoveStep, canEquipWeaponItem, getSightRange) where stub-faction
 * overrides MUST take precedence over the side default. A rogue leader's
 * `concreteFactionOf()` returns RogueFaction.
 */
export function concreteFactionOf(entity) {
  return getFaction(entity.factionId ?? entity.owner);
}

/**
 * Sight range for a single entity. Wraps the most error-prone spot of
 * the side-vs-concrete distinction — sight bonuses (rogue +1 in every
 * phase) live on the concrete faction. Pass an Entity, the current
 * phase, and the helper returns the right number.
 *
 * @param {object} entity
 * @param {string} phase
 * @returns {number}
 */
export function sightRangeForEntity(entity, phase) {
  return concreteFactionOf(entity).getSightRange(
    phase,
    typeof entity.hasAbility === 'function' && entity.hasAbility('scout'),
  );
}
