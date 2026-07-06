// Entity definitions: Hero, Witch, named Survivors, Zombie, Minion, Golems
import { WEAPON_STATS } from './tiles.js';
import { UNIT_TYPES } from './unit-types.js';
import { ITEMS } from './items.js';
import { SurvivorAbility, ABILITIES } from './abilities.js';
import {
  effectStatMod, effectRangeMod, effectIncomingAtkAdvantage,
  effectDamageTakenFlat, effectDamageTakenDice, effectsBlockHeal,
} from './effects.js';
import { hpForLevel, atkBonusForLevel, defBonusForLevel, levelForXp } from './balance.js';

let _nextId = 1;

// Sum the statMod contribution of all passive abilities on a unit.
// Phase 4 handles brawler (+1 attack) and sturdy (+1 defense); future
// entries only need to add a statMods field to the ABILITIES registry.
export function abilityStatMod(abilities, field) {
  return _abilityStatMod(abilities, field);
}
function _abilityStatMod(abilities, field) {
  if (!Array.isArray(abilities) || abilities.length === 0) return 0;
  let sum = 0;
  for (const id of abilities) {
    const mod = ABILITIES[id]?.statMods?.[field];
    if (typeof mod === 'number') sum += mod;
  }
  return sum;
}

// Forced-dice queue — for tutorial canned outcomes.  Push values via setForcedDice();
// each call to _nextDie() pops from the front, or falls back to a real random roll.
let _forcedDice = [];
/**
 * @deprecated Use `state.setForcedDice(...)` instead. This module-level
 * variant exists only for raw tests that invoke `Entity.resolveCombat`
 * directly without constructing a GameState.
 */
export function setForcedDice(...values) { _forcedDice = [...values]; }
export function nextDie(sides) {
  if (_forcedDice.length > 0) return _forcedDice.shift();
  return Math.ceil(Math.random() * sides);
}
const _nextDie = nextDie;

// ── Weapon damage rolls ──────────────────────────────────────────────────────
// A damage spec is either a plain number (fixed damage) or an object
// { count, sides, flat }: roll `count` dice of `sides` faces and add `flat`
// (e.g. { count: 2, sides: 6 } is 2D6; { count: 1, sides: 12, flat: 1 } is
// 1D12+1; the number 5 is a flat 5). normalizeDamage coerces either form into
// the object shape; rollDamage routes every die through the supplied `roll`
// fn — normally `s => state.nextDie(s)` — so damage is deterministic under
// forced dice / replay / online resolution, exactly like the advantage pools.
export function normalizeDamage(spec) {
  if (typeof spec === 'number') return { count: 0, sides: 0, flat: spec };
  return {
    count: spec?.count ?? 0,
    sides: spec?.sides ?? 0,
    flat:  spec?.flat  ?? 0,
  };
}
export function rollDamage(spec, roll) {
  const s = normalizeDamage(spec);
  let total = s.flat;
  for (let i = 0; i < s.count; i++) total += roll(s.sides);
  return Math.max(1, total);
}

// Entity type ids. Values are the wire/save format — be cautious renaming.
//
// PALADIN replaces HERO as the day-side leader entity (named "Ishmael
// Charger" by default). EntityType.HERO is kept as an alias so the ~50
// `EntityType.HERO` references across the codebase keep working without
// a churn sweep; both constants resolve to the value 'paladin'.
//
// ROGUE / CAPTAIN / NECROMANCER / BRUTE are leader types for the stub
// factions registered in PR 5. They have no factory functions yet — the
// constants are reserved here so save-format and entity-type comparisons
// are stable as the stubs land.
export const EntityType = Object.freeze({
  PALADIN:     'paladin',
  HERO:        'paladin', // legacy alias — same value as PALADIN
  ROGUE:       'rogue',
  CAPTAIN:     'captain',
  WITCH:       'witch',
  NECROMANCER: 'necromancer',
  BRUTE:       'brute',
  SURVIVOR:    'survivor',
  SOLDIER:     'soldier',
  ZOMBIE:      'zombie',
  SKELETON:    'skeleton',
  MINION:      'minion',
  WOOD_GOLEM:  'wood_golem',
  IRON_GOLEM:  'iron_golem',
});

// Survivor special abilities. The canonical registry lives in
// src/abilities.js; this re-export keeps the legacy `SurvivorAbility.X`
// call sites working during the phased migration.
export { SurvivorAbility };

// Phase 6: SURVIVOR_ROSTER and SURVIVOR_COLORS moved to
// src/content/survivors.js. Re-exported here so existing imports from
// `./entities.js` keep working; new callers should import from
// `./content/survivors.js` directly.
import { SURVIVOR_ROSTER, SURVIVOR_COLORS } from './content/survivors.js';
export { SURVIVOR_ROSTER };


// Track which roster entries have been used this game so no duplicates spawn
const _usedRosterIndices = new Set();

// BASE_STATS, BASE_AGILITY, and ENTITY_COLOR derive from UNIT_TYPES
// (src/unit-types.js), which is the single source of truth for per-type
// stats / agility / colour. New code should read UNIT_TYPES directly;
// these exports remain for existing call sites.
const BASE_STATS = Object.freeze(
  Object.fromEntries(
    Object.entries(UNIT_TYPES).map(([k, v]) => [k, { ...v.baseStats }])
  )
);

export const BASE_AGILITY = Object.freeze(
  Object.fromEntries(Object.entries(UNIT_TYPES).map(([k, v]) => [k, v.agility]))
);

// (Removed BASE_RANGE — units no longer have an innate range. Range is
// weapon-derived; see Entity.getRange()/equipWeapon().)

export const ENTITY_COLOR = Object.freeze(
  Object.fromEntries(Object.entries(UNIT_TYPES).map(([k, v]) => [k, v.color]))
);

// Per-player color palettes — canonical source is src/theme.js (FACTION_THEME).
// Re-exported here for backward compatibility with existing imports.
import { FACTION_THEME } from './theme.js';
export const HERO_PLAYER_COLORS  = FACTION_THEME.hero.playerColors;
export const WITCH_PLAYER_COLORS = FACTION_THEME.witch.playerColors;

// Six shades per witch-unit type — cycled as units are created so each
// individual unit gets a distinct arrow/circle colour on the plan overlay.
const WITCH_UNIT_COLORS = {
  [EntityType.ZOMBIE]: [
    '#3a6b2a', '#2e5520', '#4a7a35', '#1f4418', '#527a3d', '#264d1a',
  ],
  [EntityType.SKELETON]: [
    '#c9c4ae', '#b5ae92', '#ded9c6', '#a29a7e', '#ece8d9', '#8f876c',
  ],
  [EntityType.MINION]: [
    '#c0392b', '#e74c3c', '#962419', '#ff6b5b', '#a93226', '#d45040',
  ],
  [EntityType.WOOD_GOLEM]: [
    '#8B5E3C', '#a07248', '#6b4226', '#c49060', '#5c3317', '#b8804c',
  ],
  [EntityType.IRON_GOLEM]: [
    '#607D8B', '#7a9bab', '#455a64', '#90a8b4', '#37474f', '#adc4cc',
  ],
};

export class Entity {
  constructor(type, owner, col, row, ownerId = null, state = null) {
    // Server hosts multiple concurrent games. When a GameState is provided,
    // use its per-instance id counter so games never collide. Fallback to the
    // module-level counter is reserved for editor previews and standalone
    // tests that don't construct a GameState.
    this.id      = state ? `e${state.allocateEntityId()}` : `e${_nextId++}`;
    this.type    = type;
    this.owner   = owner;   // faction: 'hero' | 'witch' | null
    this.ownerId = ownerId; // player UUID (null for neutral/pre-multiplayer entities)

    this.col = col;
    this.row = row;
    // Sub-hex slot (0 = centre, 1..6 = adjacent to each face). Authoritative
    // intra-hex position the renderer reads for placement. Assigned at
    // placement time (spawn/move) via assignSlotOnTile() in actions.js — the
    // constructor default is the centre.
    this.slot = 0;

    const stats = BASE_STATS[type];
    this.maxHp   = stats.maxHp;
    this.hp      = stats.maxHp;
    this.attack  = stats.attack;
    this.defense = stats.defense;
    this.agility = BASE_AGILITY[type] ?? 1;
    // No innate unit range — range comes from the equipped weapon. Read it via
    // getRange() (composes ITEMS[equippedWeapon].range at call time); there is
    // no denormalized `range` cache field any more.

    // Tag metadata from UNIT_TYPES (e.g. 'undead', 'construct', 'minion',
    // 'living', 'leader', 'day-leader'). Used by item combat triggers —
    // e.g. staff's anti-undead bonus iterates ITEMS.staff.combatTriggers
    // and matches against defender.tags. Empty array for any entity type
    // missing from UNIT_TYPES (shouldn't happen in production).
    this.tags = UNIT_TYPES[type]?.tags ?? [];

    // Temporary combat modifiers (reset each turn)
    this.attackBonus  = 0;
    this.defenseBonus = 0;

    // Equipped weapon now lives INSIDE `items` as the entry tagged
    // `{ equipped: true }` (Phase 1 inventory refactor) — no top-level
    // `weapon` slot. Query it via getEquippedWeaponId().

    // Survivor personality fields (set by createSurvivor)
    this.name     = null;
    this.title    = null;
    this.bio      = null;
    // Phase 4: promoted from singular `ability: string` to an array.
    // BRAWLER / STURDY passives are no longer baked into base stats;
    // getAttack() / getDefense() compose their statMods at call time.
    this.abilities    = [];
    this.abilityLabel = null;

    this.actedThisTurn = false;
    this.defendCount   = 0;
    this.guarding      = 0;
    // Once-per-round free weapon equip gate; reset in resetTurn().
    this.equippedThisRound = false;

    // Per-round counters consulted by ability/effect triggers (e.g. berserker
    // fires frenzy when killsThisRound >= 2). Reset in resetTurn().
    this.killsThisRound = 0;

    // Time-bound runtime augments — see src/effects.js. Records:
    //   { id, duration, stacks, source? }
    // Stat composition runs in getAttack/getDefense/getRange/getAgility.
    this.effects = [];

    // Unit level (≥1). Scales intrinsic HP/ATK/DEF, not weapon damage —
    // applyLevel() (below) sets maxHp; getAttack/getDefense compose the
    // ATK/DEF bonus. Persists across rounds (not reset in resetTurn).
    // Used by campaign authoring to ramp difficulty (Zombie L1/L2/L3…).
    this.level = 1;

    // Accumulated experience (campaign veterancy). Earned only in campaign
    // missions via awardXP(); crossing an xpForLevel() threshold raises `level`.
    // Always 0 outside campaign (XP is never awarded there). Persists across
    // rounds and between missions (snapshotSurvivor / heroStats).
    this.xp = 0;

    // Personal backpack — a map of item-id → `{ count, equipped? }`. Weapons
    // use their ITEMS id directly (e.g. 'sword'); consumables and mounts use
    // their resource/item id (e.g. 'horse', 'herbs'). ITEMS[key].kind
    // distinguishes weapon from consumable. At most one entry carries
    // `equipped: true` — that is the wielded weapon (getEquippedWeaponId()).
    // Always mutate via addItem/removeItem/equipWeapon/unequipWeapon so the
    // memoized equipped-weapon cache stays valid.
    this.items = {};
  }

  get alive() { return this.hp > 0; }

  // The unit's plain display name — NO level suffix. The veterancy level is a
  // separate, structured signal (`this.level`) that player-visual call sites
  // render as a distinct pill badge beside the name (3D over-unit icon badge,
  // Unit Stats Bar, action-popup portrait). It used to be concatenated here
  // (`Aldous L2`), but that baked presentation into a value also consumed by
  // canvas labels, plain-text combat logs and TTS — so the suffix is gone and
  // the badge is drawn at each render site. `baseName` is an explicit alias for
  // call sites that want to make the "no suffix" intent obvious.
  get displayName() {
    return this.name ?? defaultDisplayName(this.type);
  }

  get baseName() {
    return this.name ?? defaultDisplayName(this.type);
  }

  // ── Stat accessors (Phase 2 of the units/items/abilities refactor) ──
  //
  // Callers that want the "character sheet" attack / defense value should
  // prefer these methods to direct field reads. They return the base stat
  // plus any equipped-weapon bonus; transient combat modifiers
  // (attackBonus / defenseBonus) are added by callers where relevant
  // (resolveCombat, AI expected-value estimators, battle-dialog breakdown).
  //
  // The weapon bonus is composed at call time from
  // ITEMS[getEquippedWeaponId()].statMods — the equipped weapon lives in
  // `items`, not a separate slot, so swaps never touch the base stat.

  getAttack()  {
    return this.attack
      + atkBonusForLevel(this.level)
      + (ITEMS[this.getEquippedWeaponId()]?.statMods?.attack ?? 0)
      + _abilityStatMod(this.abilities, 'attack')
      + effectStatMod(this, 'attack');
  }
  getDefense() {
    return this.defense
      + defBonusForLevel(this.level)
      + (ITEMS[this.getEquippedWeaponId()]?.statMods?.defense ?? 0)
      + _abilityStatMod(this.abilities, 'defense')
      + effectStatMod(this, 'defense');
  }
  getAgility() {
    return (this.agility ?? 1)
      + _abilityStatMod(this.abilities, 'agility')
      + effectStatMod(this, 'agility');
  }
  // Attack range in hexes. 1 = melee only; >1 = ranged. Range is entirely
  // weapon-derived — there is no innate unit range. The equipped weapon's
  // `range` (default 1 for melee/unarmed) is the base; effects like
  // eagle_eyed extend it via rangeMod and permanent abilities (eagle_eye)
  // compose via ABILITIES[id].statMods.range, mirroring attack/defense.
  // There is no denormalized range cache — getRange() is the single source of
  // truth, composed from the equipped weapon each call (memoized id lookup).
  getRange() {
    return (ITEMS[this.getEquippedWeaponId()]?.range ?? 1)
      + _abilityStatMod(this.abilities, 'range')
      + effectRangeMod(this);
  }

  // Movement range in tiles. 1 base, +1 with horse equipped.
  getMoveRange() {
    return 1 + (this.hasItem('horse') ? 1 : 0);
  }

  // `abilities` is a plain data property (set in the constructor); the
  // Phase-2 forward-compatible API was a getter that derived from the
  // legacy singular `ability` field, and is no longer needed.
  hasAbility(id) {
    return Array.isArray(this.abilities) && this.abilities.includes(id);
  }

  // Unit-type tags (`undead`, `construct`, `minion`, `living`, `leader`,
  // `day-leader`, `night-leader`, `summoned`). Populated in the
  // constructor from UNIT_TYPES. Used by item combat triggers and
  // faction-level predicates.
  hasTag(tag) {
    return Array.isArray(this.tags) && this.tags.includes(tag);
  }

  // ── Backpack / equipped-weapon helpers (Phase 1 inventory refactor) ──
  //
  // The equipped weapon is the `items` entry tagged `{ equipped: true }`. All
  // weapon/item bonuses (getAttack/getDefense/getRange/_combatNets) resolve the
  // id through getEquippedWeaponId(), which memoizes the dict scan on a hidden
  // `_equippedWeaponCache`. The cache keys on the items-object IDENTITY, so a
  // wholesale `entity.items = {…}` replacement self-invalidates; in-place
  // mutations (equip/unequip/add/remove) invalidate explicitly.

  getEquippedWeaponId() {
    const items = this.items;
    const cache = this._equippedWeaponCache;
    if (cache && cache.ref === items) return cache.id;
    const id = getEquippedWeaponIdOf(items);
    this._writeEqCache({ ref: items, id });
    return id;
  }

  // Store the memo cache as a NON-enumerable own property so it never leaks into
  // `{...e}` spreads, JSON, or deep-equal entity snapshots (production paths use
  // field allowlists, but tests snapshot whole entities). Subsequent writes keep
  // the existing descriptor; the first write defines it hidden.
  _writeEqCache(v) {
    if (Object.prototype.hasOwnProperty.call(this, '_equippedWeaponCache')) {
      this._equippedWeaponCache = v;
    } else {
      Object.defineProperty(this, '_equippedWeaponCache', {
        value: v, writable: true, enumerable: false, configurable: true,
      });
    }
  }

  /** Equip a weapon by id. Ensures the entry exists (count ≥ 1), flags it
   *  equipped, and clears equipped from every other entry. A falsy id
   *  unequips (clears any equipped flag). */
  equipWeapon(weaponType) {
    if (!weaponType) { this.unequipWeapon(); return; }
    if (!this.items) this.items = {};
    equipWeaponInItems(this.items, weaponType);
    this._writeEqCache(null);
  }

  /** Remove the equipped flag from whatever weapon currently holds it. The
   *  weapon stays in the backpack at its existing count. */
  unequipWeapon() {
    if (!this.items) return;
    unequipWeaponInItems(this.items);
    this._writeEqCache(null);
  }

  /** Add `count` of an item. Creates the entry if absent. A count bump alone
   *  cannot change the equipped lookup, so the cache is only invalidated when a
   *  new key appears. */
  addItem(id, count = 1) {
    if (!this.items) this.items = {};
    const isNew = !(id in this.items);
    addItemInItems(this.items, id, count);
    if (isNew) this._writeEqCache(null);
  }

  /** Remove `count` of an item. Deletes the entry when the count hits 0,
   *  clearing the equipped flag (and the cache) in the process. */
  removeItem(id, count = 1) {
    if (!this.items) return;
    if (removeItemInItems(this.items, id, count)) this._writeEqCache(null);
  }

  hasItem(id)       { return hasItemOf(this.items, id); }
  getItemCount(id)  { return getItemCountOf(this.items, id); }

  resetTurn() {
    this.actedThisTurn = false;
    this.attackBonus   = 0;
    this.defenseBonus  = 0;
    this.defendCount   = 0;
    this.guarding      = 0;
    this.killsThisRound = 0;
    this.equippedThisRound = false;
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    return !this.alive;
  }

  /**
   * Compute the effective incoming damage for a base hit, after applying
   * effect mods: flat additions plus bonus damage DICE (wounded → +1D6 per
   * stack). `rollDie(sides)` should be the game's deterministic die stream
   * (`s => state.nextDie(s)`) so forced dice / replays stay byte-identical;
   * without a roller each die falls back to a fixed 4 (average, rounded up)
   * rather than reaching for Math.random. Damage never goes below 1 once a
   * hit lands — effects can amplify pain, not cancel it outright.
   */
  applyIncomingDamage(baseAmount, rollDie = null) {
    const flat = effectDamageTakenFlat(this);
    let rolled = 0;
    const dice = effectDamageTakenDice(this);
    for (let i = 0; i < dice; i++) rolled += rollDie ? rollDie(6) : 4;
    return Math.max(1, baseAmount + flat + rolled);
  }

  heal(amount) {
    if (effectsBlockHeal(this)) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  // Advantage/disadvantage dice-pool combat.
  // Each side rolls (1 + |net advantage|) d6 and takes best (advantage) or
  // worst (disadvantage). Net advantage per side = (advantage sources) −
  // (disadvantage sources), capped at ±ADVANTAGE_CAP.
  //
  // Options:
  //   phaseAdvantage       — 1 when day/night favors the attacker, else 0
  //   atkAdvantageDice     — gang-up allies adjacent to the target
  //   atkDisadvantageDice  — attacker disadvantage sources (currently unused)
  //   defAdvantageDice     — defender allies adjacent to the target
  //   defDisadvantageDice  — defender disadvantage sources (currently unused)
  //   extraAtkBonus        — flat attack bonus (attacker-side fortification)
  //   extraDefBonus        — flat defense bonus (defender-side fortification)
  //   fatiguePenalty       — flat defender penalty from repeated defending
  //   state                — GameState for per-game forced-dice queue
  /**
   * Shared pre-roll computation for resolveCombat and computeCombatOdds:
   * net advantage dice per side (including weapon triggers and marked
   * effects) and the flat roll modifiers added to each side's die.
   */
  static _combatNets(attacker, defender, options = {}) {
    const {
      phaseAdvantage = 0,
      atkAdvantageDice = 0,
      atkDisadvantageDice = 0,
      defAdvantageDice = 0,
      defDisadvantageDice = 0,
      extraAtkBonus = 0,
      extraDefBonus = 0,
      fatiguePenalty = 0,
    } = options;

    // Item combat triggers (e.g. staff vs undead defenders →
    // +1 attacker advantage die). Data-driven via ITEMS[weapon].combatTriggers
    // so adding a new conditional weapon effect is a one-file change. The
    // defender's tag set is sourced from `defender.tags` (set in the Entity
    // constructor) and falls back to UNIT_TYPES for plain-object test fixtures.
    let atkStaffAdvantage = 0;
    const triggers = ITEMS[getEquippedWeaponIdOf(attacker.items)]?.combatTriggers ?? [];
    if (triggers.length > 0) {
      const defTags = defender.tags && defender.tags.length > 0
        ? defender.tags
        : (UNIT_TYPES[defender.type]?.tags ?? []);
      for (const t of triggers) {
        if (t.when && t.when !== 'attack') continue;
        if (t.ifDefenderHasAnyTag && t.ifDefenderHasAnyTag.some(tag => defTags.includes(tag))) {
          atkStaffAdvantage += t.advantage ?? 0;
        }
      }
    }

    // Defender-side effects can grant advantage to attackers (e.g. marked).
    const defMarkedAdvantage = effectIncomingAtkAdvantage(defender);

    const atkNet = clampAdvantage(
      (phaseAdvantage + atkAdvantageDice + atkStaffAdvantage + defMarkedAdvantage) - atkDisadvantageDice
    );
    const defNet = clampAdvantage(defAdvantageDice - defDisadvantageDice);

    const atkFlat = attackOf(attacker)  + (attacker.attackBonus  || 0) + extraAtkBonus;
    const defFlat = defenseOf(defender) + (defender.defenseBonus || 0) + extraDefBonus - fatiguePenalty;

    return { atkNet, defNet, atkFlat, defFlat, atkStaffAdvantage };
  }

  static resolveCombat(attacker, defender, options = {}) {
    const { state = null, fatiguePenalty = 0 } = options;

    const roll = state ? (s) => state.nextDie(s) : _nextDie;

    const { atkNet, defNet, atkFlat, defFlat, atkStaffAdvantage } =
      Entity._combatNets(attacker, defender, options);

    const atkPool = _rollPool(roll, atkNet);
    const defPool = _rollPool(roll, defNet);
    const atkBaseDie = _pickFromPool(atkPool, atkNet);
    const defBaseDie = _pickFromPool(defPool, defNet);

    const attackRoll  = atkBaseDie + atkFlat;
    const defenseRoll = defBaseDie + defFlat;
    const margin = attackRoll - defenseRoll;

    const atkExtraDice = atkPool.slice(1);
    const defExtraDice = defPool.slice(1);

    return {
      attackRoll, defenseRoll, hit: margin > 0, margin,
      atkBaseDie, defBaseDie,
      atkPool, defPool,
      atkExtraDice, defExtraDice,
      atkAdvantage: atkNet,
      defAdvantage: defNet,
      atkStaffBonus: atkStaffAdvantage,
      fatiguePenalty,
    };
  }

  /**
   * Exact outcome probabilities for a resolveCombat() roll — no sampling.
   *
   * Takes the SAME options object as resolveCombat plus a `ranged` flag
   * (ranged attacks can neither crush nor be countered — mirrors
   * executeBattle). Enumerates the 36 (chosen-die × chosen-die) outcomes
   * using the exact best/worst-of-K die distribution.
   *
   * Returns { hit, crush, counter, miss } — `crush` is the subset of `hit`
   * where attackRoll ≥ 2×defenseRoll; `counter` is the subset of `miss`
   * where defenseRoll ≥ 2×attackRoll; hit + miss = 1.
   */
  static computeCombatOdds(attacker, defender, options = {}) {
    const { ranged = false } = options;
    const { atkNet, defNet, atkFlat, defFlat } =
      Entity._combatNets(attacker, defender, options);

    let hit = 0, crush = 0, counter = 0;
    for (let v = 1; v <= 6; v++) {
      const pa = _chosenDieProb(v, atkNet);
      const attackRoll = v + atkFlat;
      for (let w = 1; w <= 6; w++) {
        const p = pa * _chosenDieProb(w, defNet);
        const defenseRoll = w + defFlat;
        if (attackRoll > defenseRoll) {
          hit += p;
          if (!ranged && attackRoll >= 2 * defenseRoll) crush += p;
        } else if (!ranged && defenseRoll >= 2 * attackRoll) {
          counter += p;
        }
      }
    }
    return { hit, crush, counter, miss: 1 - hit };
  }
}

// P(chosen die = v) for net advantage `net`: best-of-(1+net) when positive,
// worst-of-(1+|net|) when negative, a plain d6 at 0.
function _chosenDieProb(v, net) {
  const k = 1 + Math.abs(net);
  if (net > 0) return Math.pow(v / 6, k) - Math.pow((v - 1) / 6, k);
  if (net < 0) return Math.pow((7 - v) / 6, k) - Math.pow((6 - v) / 6, k);
  return 1 / 6;
}

// Stat accessors that tolerate plain-object entity fixtures (used by unit
// tests that skip the Entity constructor) as well as real Entity instances.
// Production callers prefer `entity.getAttack()` / `entity.getDefense()`
// directly; these wrappers exist so Entity.resolveCombat and AI
// estimateCombat helpers don't break on lightweight test fixtures.
//
// For plain objects (post-Phase-3), the fallback composes the weapon
// bonus from ITEMS[equippedWeapon].statMods so fixtures that set
// { attack: 3, items: { sword: { count: 1, equipped: true } } } resolve to an
// effective value of 5, matching Entity.getAttack() semantics.
export function attackOf(e) {
  if (typeof e?.getAttack === 'function') return e.getAttack();
  const base        = e?.attack ?? 0;
  const levelMod    = atkBonusForLevel(e?.level);
  const weaponId    = getEquippedWeaponIdOf(e?.items);
  const weaponMod   = weaponId ? (ITEMS[weaponId]?.statMods?.attack ?? 0) : 0;
  const abilityMod  = _abilityStatMod(e?.abilities, 'attack');
  const effectMod   = effectStatMod(e, 'attack');
  return base + levelMod + weaponMod + abilityMod + effectMod;
}
export function defenseOf(e) {
  if (typeof e?.getDefense === 'function') return e.getDefense();
  const base        = e?.defense ?? 0;
  const levelMod    = defBonusForLevel(e?.level);
  const weaponId    = getEquippedWeaponIdOf(e?.items);
  const weaponMod   = weaponId ? (ITEMS[weaponId]?.statMods?.defense ?? 0) : 0;
  const abilityMod  = _abilityStatMod(e?.abilities, 'defense');
  const effectMod   = effectStatMod(e, 'defense');
  return base + levelMod + weaponMod + abilityMod + effectMod;
}
// Attack range in hexes — tolerates plain-object fixtures. Range is
// weapon-derived: read it from the equipped weapon in `items` (default 1 for
// melee/unarmed). Units have no innate per-type range.
export function rangeOf(e) {
  if (typeof e?.getRange === 'function') return e.getRange();
  const weaponId   = getEquippedWeaponIdOf(e?.items);
  const base       = ITEMS[weaponId]?.range ?? 1;
  const abilityMod = _abilityStatMod(e?.abilities, 'range');
  const effectMod  = effectRangeMod(e);
  return base + abilityMod + effectMod;
}

/**
 * Return a shallow, prototype-preserving CLONE of `entity` whose backpack has
 * `weaponId` equipped — without mutating the original. Used by plan mode to
 * project the weapon a unit will be wielding after a queued EQUIP_WEAPON, so
 * range-driven highlights (attack targets, guard zone) reflect the post-equip
 * weapon rather than the live one. A falsy/unchanged `weaponId` returns an
 * equivalent clone (range unchanged), so callers can pass the projection result
 * unconditionally. The `items` dict is deep-copied so equipping on the clone
 * never aliases the live entity's backpack; methods (getRange/getAttack/…)
 * still resolve via the preserved prototype.
 */
export function applyProjectedEquip(entity, weaponId) {
  if (!entity) return entity;
  // Deep-copy the per-entry objects so flipping `equipped` is local to the clone.
  const items = {};
  for (const k in (entity.items || {})) {
    const v = entity.items[k];
    items[k] = (v && typeof v === 'object') ? { ...v } : v;
  }
  if (weaponId) equipWeaponInItems(items, weaponId);
  const clone = Object.setPrototypeOf({ ...entity, items }, Object.getPrototypeOf(entity));
  // The equipped-weapon memo is a non-enumerable own-prop, so `{...entity}` does
  // NOT copy it — the clone shares no memo. Force a (re)scan of the projected
  // backpack so getEquippedWeaponId() reflects the equipped weapon, not stale state.
  if (typeof clone._writeEqCache === 'function') clone._writeEqCache(null);
  return clone;
}

// ── Backpack item dict helpers (free functions) ──────────────────────────────
//
// Operate on a plain `items` dict (`{ id: { count, equipped? } }`) so both the
// Entity prototype methods and plain-object call sites (campaign roster
// snapshots, AI sim clones, state-sync migration) share one implementation.

/** First equipped weapon id in a backpack dict, or null. Only weapon entries
 *  ever carry the `equipped` flag, but we double-check ITEMS kind for safety. */
export function getEquippedWeaponIdOf(items) {
  if (!items) return null;
  for (const k in items) {
    const entry = items[k];
    if (entry && entry.equipped && ITEMS[k]?.kind === 'weapon') return k;
  }
  return null;
}

/** Flag `id` equipped in a backpack dict, clearing the flag from every other
 *  entry and ensuring `id` exists with count ≥ 1. Mutates and returns `items`. */
export function equipWeaponInItems(items, id) {
  for (const k in items) {
    if (items[k] && items[k].equipped) delete items[k].equipped;
  }
  const entry = items[id];
  if (entry && typeof entry.count === 'number') entry.equipped = true;
  else items[id] = { count: 1, equipped: true };
  return items;
}

/** Clear the equipped flag from whichever entry holds it. Mutates `items`. */
export function unequipWeaponInItems(items) {
  if (!items) return items;
  for (const k in items) {
    if (items[k] && items[k].equipped) delete items[k].equipped;
  }
  return items;
}

/** Bump `id`'s count in a backpack dict, creating the entry if absent.
 *  Mutates and returns `items`. */
export function addItemInItems(items, id, count = 1) {
  const entry = items[id];
  if (entry && typeof entry.count === 'number') entry.count += count;
  else items[id] = { count };
  return items;
}

/** Remove `count` of `id` from a backpack dict, deleting the entry at 0.
 *  Returns true when the entry was deleted (so callers can invalidate caches).
 *  Mutates `items`. */
export function removeItemInItems(items, id, count = 1) {
  const entry = items[id];
  if (!entry) return false;
  const next = (entry.count ?? 0) - count;
  if (next > 0) { entry.count = next; return false; }
  delete items[id];
  return true;
}

/** Count of `id` in an item/resource dict (`{ id: { count, equipped? } }`),
 *  tolerating a missing entry. 0 when absent. The read primitive shared by the
 *  Entity.getItemCount method and every plain-dict call site (shared faction
 *  inventory, campaign armory). */
export function getItemCountOf(items, id) {
  return items?.[id]?.count ?? 0;
}

/** True when the dict holds ≥1 of `id`. */
export function hasItemOf(items, id) {
  return (items?.[id]?.count ?? 0) > 0;
}

/** Sum of every entry's count — the total quantity held across all ids. Used by
 *  the summon affordability checks (any-2-resources). */
export function totalItemCount(items) {
  let n = 0;
  if (items) for (const k in items) n += items[k]?.count ?? 0;
  return n;
}

/** Flatten a `{ id: { count } }` dict back to a plain `{ id: count }` numeric
 *  map (tolerating an already-flat input). Inverse of {@link normalizeItems} —
 *  used at the campaign boundary, where `Campaign.resources` persists as a flat
 *  numeric map even though the live faction inventory is dict-of-objects. */
export function flattenItemCounts(items) {
  const out = {};
  if (!items || typeof items !== 'object') return out;
  for (const k in items) {
    const v = items[k];
    out[k] = (v && typeof v === 'object') ? (v.count ?? 0)
           : (typeof v === 'number' ? v : 0);
  }
  return out;
}

/** Deep-copy a backpack dict into the canonical `{ id: { count, equipped? } }`
 *  shape, tolerating the legacy `{ id: count }` numeric form. Used by snapshots
 *  and by the save-migration shims. */
export function normalizeItems(items) {
  const out = {};
  if (!items || typeof items !== 'object') return out;
  for (const k in items) {
    const v = items[k];
    if (v && typeof v === 'object') {
      out[k] = { count: v.count ?? 0 };
      if (v.equipped) out[k].equipped = true;
    } else if (typeof v === 'number') {
      out[k] = { count: v };
    }
  }
  return out;
}

// ── Advantage-dice math ─────────────────────────────────────────────────────

// Cap total advantage/disadvantage dice each side can accumulate.
// Lowered from 4 to 3 so the game cap matches the combat-tester's visual
// capacity (defender's 6-hex neighbour ring splits into 3 atk + 3 def slots).
export const ADVANTAGE_CAP = 3;

// E[best-of-(1+K)] and E[worst-of-(1+K)] for K advantage/disadvantage dice.
// Index by the advantage level K ∈ {0, 1, 2, 3, 4}. K=0 is a plain d6 (E=3.5).
// Covers the full range up to ADVANTAGE_CAP.
export const BEST_OF_K_EV = [
  3.5,        // K=0: plain d6
  4.47222,    // K=1: best of 2
  4.95833,    // K=2: best of 3
  5.24459,    // K=3: best of 4
  5.43069,    // K=4: best of 5
];
export const WORST_OF_K_EV = [
  3.5,
  2.52778,
  2.04167,
  1.75540,
  1.56931,
];

function clampAdvantage(n) {
  if (n > ADVANTAGE_CAP) return ADVANTAGE_CAP;
  if (n < -ADVANTAGE_CAP) return -ADVANTAGE_CAP;
  return n;
}

function _rollPool(roll, net) {
  const k = 1 + Math.abs(net);
  const pool = new Array(k);
  for (let i = 0; i < k; i++) pool[i] = roll(6);
  return pool;
}

function _pickFromPool(pool, net) {
  if (net > 0) {
    let m = pool[0];
    for (let i = 1; i < pool.length; i++) if (pool[i] > m) m = pool[i];
    return m;
  }
  if (net < 0) {
    let m = pool[0];
    for (let i = 1; i < pool.length; i++) if (pool[i] < m) m = pool[i];
    return m;
  }
  return pool[0];
}

// Expected value of the chosen die for a given net advantage (−CAP..+CAP).
export function expectedDieValue(net) {
  const n = clampAdvantage(net);
  if (n >= 0) return BEST_OF_K_EV[n];
  return WORST_OF_K_EV[-n];
}

// Set a unit's level and rescale its HP. ATK/DEF level bonuses compose live in
// getAttack()/getDefense(), so this only needs to handle maxHp (a stored field,
// not a getter). Idempotent: the level-1 base maxHp is snapshotted on the first
// call, so a future re-level (e.g. regular-mode veterancy) won't compound the
// scaling. Spawn units at full HP. Called once at spawn by campaign authoring.
export function applyLevel(entity, level) {
  const lvl = Math.max(1, Math.floor(level || 1));
  if (entity._baseMaxHp == null) entity._baseMaxHp = entity.maxHp;
  entity.level = lvl;
  entity.maxHp = hpForLevel(entity._baseMaxHp, lvl);
  entity.hp    = entity.maxHp;
  return entity;
}

// Award experience to a unit (campaign veterancy). No-op outside campaign — XP
// is a campaign-only mechanic, gated on state.isCampaign, so normal/online play
// is byte-identical. Accumulates `entity.xp`, and if the new total crosses one
// or more xpForLevel() thresholds, re-levels the unit ONCE to the final level
// (applyLevel is idempotent against _baseMaxHp, so a multi-level jump applies
// the same stats as the equivalent single jump). applyLevel sets hp = maxHp, so
// a level-up fully heals — no extra HP bookkeeping is needed here.
//
// Returns { xpGained, leveledUp, newLevel } for Phase C/F (toasts, FX). Phase B
// never calls this; it's the plumbing a sibling ticket hooks into.
export function awardXP(entity, amount, state) {
  // Hero-only mechanic. Only player-faction (hero) units carry across missions
  // (campaign saves heroStats + survivors, never witch units — src/campaign/
  // campaign.js), so witch-side levelling has zero progression payoff and only
  // acts as an off-spec within-mission difficulty drift. Gate it out here at the
  // single chokepoint rather than at all 7 call sites; the hero-owner check is
  // the canonical faction discriminator (Entity ctor; the established pattern
  // across src/). entities.js can't import factions.js (factions.js imports it),
  // so the faction `side` abstraction isn't reachable — see the documented
  // allowlist bump in tests/faction-string-checks.test.js.
  // Number.isFinite rejects Infinity (which `amount > 0` would let through and
  // poison entity.xp, jumping straight to L99) as well as NaN/±Infinity.
  if (!state?.isCampaign || !entity || entity.owner !== 'hero'
      || !(amount > 0) || !Number.isFinite(amount)) {
    return { xpGained: 0, leveledUp: false, newLevel: entity?.level ?? 1 };
  }
  const gain = Math.floor(amount);
  if (gain <= 0) {
    return { xpGained: 0, leveledUp: false, newLevel: entity.level ?? 1 };
  }
  entity.xp = (entity.xp ?? 0) + gain;
  const oldLevel = entity.level ?? 1;
  const newLevel = levelForXp(entity.xp);
  let leveledUp = false;
  if (newLevel > oldLevel) {
    applyLevel(entity, newLevel); // one call with the FINAL level; full-heals
    leveledUp = true;
  }
  return { xpGained: gain, leveledUp, newLevel: entity.level ?? 1 };
}

// Innate leader abilities are stamped onto each leader by
// `Faction.createLeader()` (see src/factions.js) — it iterates the
// faction's `innateLeaderAbilities` list after `_buildLeader` runs. The
// factory functions below intentionally do NOT push abilities directly;
// the faction is the sole source of truth so subclasses (e.g. RogueFaction
// returning `[]`) can actually strip an inherited ability.
//
// Direct callers of these factories (e.g. tests, `state.deserializeState`,
// or any code that bypasses Faction.createLeader) get a leader without
// innate abilities — that's the expected behaviour for raw construction.

export function createHero(col, row, ownerId = null, state = null) {
  return new Entity(EntityType.PALADIN, 'hero', col, row, ownerId, state);
}

export function createWitch(col, row, ownerId = null, state = null) {
  return new Entity(EntityType.WITCH, 'witch', col, row, ownerId, state);
}

// ── Stub-faction leader factories ───────────────────────────────────────────
// These leaders share their parent side's owner string (the day-side leaders
// keep owner=hero; the night-side leaders keep owner=witch) so existing
// owner checks across the codebase keep working unchanged. The specific
// faction is communicated via the entity's `factionId` field plus its `type`.

export function createRogue(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.ROGUE, 'hero', col, row, ownerId, state);
  e.factionId = 'rogue';
  return e;
}

export function createCaptain(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.CAPTAIN, 'hero', col, row, ownerId, state);
  e.factionId = 'captain';
  return e;
}

export function createNecromancer(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.NECROMANCER, 'witch', col, row, ownerId, state);
  e.factionId = 'necromancer';
  return e;
}

export function createBrute(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.BRUTE, 'witch', col, row, ownerId, state);
  e.factionId = 'brute';
  return e;
}

// ── Leader-type set (used by renderer outlines, UI auto-select, resolver
//    leader-death checks, AI sim singleton lookups). Includes the six
//    registered faction leader types; any new faction's leaderType should
//    be added here AND in the Faction registry.
const _LEADER_TYPES = new Set([
  EntityType.PALADIN,
  EntityType.ROGUE,
  EntityType.CAPTAIN,
  EntityType.WITCH,
  EntityType.NECROMANCER,
  EntityType.BRUTE,
]);

/** True if `type` is one of the registered faction leader entity types. */
export function isLeaderType(type) {
  return _LEADER_TYPES.has(type);
}

/**
 * Predicate: does the given faction (`owner` string: 'hero' | 'witch' | …) have
 * MORE THAN ONE LIVE LEADER on the field? Used by the renderer to decide
 * whether to tint a non-leader unit with its owning leader's per-player colour
 * instead of the faction primary — in solo / single-leader play, returning
 * `false` preserves the legacy "faction colour everywhere" appearance.
 *
 * Counts only entities that are `.alive`, share `.owner === factionOwner`, and
 * carry a leader entity type. Pure / DOM-free / testable.
 */
export function factionHasMultipleLeaders(entityList, factionOwner) {
  if (!factionOwner || !Array.isArray(entityList)) return false;
  let count = 0;
  for (const e of entityList) {
    if (!e || !e.alive) continue;
    if (e.owner !== factionOwner) continue;
    if (!isLeaderType(e.type)) continue;
    if (++count >= 2) return true;
  }
  return false;
}

/**
 * Walk `entityList` and return the colour assigned to the LIVE leader whose
 * `ownerId` matches `ownerId` (per-player tint set when seats are claimed).
 * Returns `null` if no qualifying leader is found or `ownerId` is missing.
 * Used by the renderer to propagate the owning leader's tint to every unit
 * they own (survivors, summons, golems) once the multi-leader predicate fires.
 * Pure / DOM-free / testable.
 */
export function leaderColorFor(entityList, ownerId) {
  if (!ownerId || !Array.isArray(entityList)) return null;
  for (const e of entityList) {
    if (!e || !e.alive) continue;
    if (e.ownerId !== ownerId) continue;
    if (!isLeaderType(e.type)) continue;
    if (e.color) return e.color;
  }
  return null;
}

// Default display name per entity type. Used by Entity.displayName on the
// server and re-used by MirrorEntity.displayName on the client so the two
// never drift. Survivors override `.name` at creation time, so the lookup
// is only hit for unnamed leaders / summoned units / neutrals.
const _DEFAULT_DISPLAY_NAMES = {
  [EntityType.PALADIN]:     'Ishmael Charger',
  [EntityType.ROGUE]:       'Mercy Sloane',
  [EntityType.CAPTAIN]:     'Captain Eli Ward',
  [EntityType.WITCH]:       'The Witch',
  [EntityType.NECROMANCER]: 'The Necromancer',
  [EntityType.BRUTE]:       'The Brute',
  [EntityType.SURVIVOR]:    'Survivor',
  [EntityType.ZOMBIE]:      'Zombie',
  [EntityType.SKELETON]:    'Skeleton',
  [EntityType.MINION]:      'Minion',
  [EntityType.WOOD_GOLEM]:  'Wood Golem',
  [EntityType.IRON_GOLEM]:  'Iron Golem',
};

/** Default display name for an entity type (falls back to the raw type id). */
export function defaultDisplayName(type) {
  return _DEFAULT_DISPLAY_NAMES[type] ?? type;
}

/**
 * Pick a random SURVIVOR_ROSTER character not in the fallen-name set — the
 * drained-pool fallback for createSurvivor. Excludes permadead survivors even
 * when every roster index is already used. If somehow everyone has fallen
 * (degenerate), falls back to a fully-random pick so spawning never crashes.
 */
function _pickNonFallenFallback(fallenNames) {
  if (!fallenNames || fallenNames.size === 0) {
    return SURVIVOR_ROSTER[Math.floor(Math.random() * SURVIVOR_ROSTER.length)];
  }
  const alive = SURVIVOR_ROSTER.filter(c => !fallenNames.has(c.name));
  const pool = alive.length > 0 ? alive : SURVIVOR_ROSTER;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function createSurvivor(col, row, ownerId = null, state = null, forcedName = null, level = 1) {
  const e = new Entity(EntityType.SURVIVOR, null, col, row, ownerId, state);

  // Roster de-dup tracker lives on the GameState when one is provided;
  // otherwise fall back to the module-level set (editor previews / raw tests).
  const usedIndices = state ? state.usedRosterIndices : _usedRosterIndices;

  // Campaign permadeath: survivors who fell on a completed mission are excluded
  // from the discoverable pool forever. The set is mirrored onto the mission
  // GameState at start (state.fallenSurvivorNames); empty/absent for normal play.
  const fallenNames = state?.fallenSurvivorNames instanceof Set
    ? state.fallenSurvivorNames
    : null;

  // Forced pick: when an authored mission tile names a specific survivor,
  // spawn THAT roster character. Unknown / null names fall through to the
  // existing random pick (back-compat). A fallen survivor is never force-spawned
  // — they're permadead — so a pin on one falls through to a random pick too.
  let pick = null;
  if (forcedName != null && !(fallenNames && fallenNames.has(forcedName))) {
    const fi = SURVIVOR_ROSTER.findIndex(c => c.name === forcedName);
    if (fi >= 0) pick = { c: SURVIVOR_ROSTER[fi], i: fi };
  }

  if (!pick) {
    // Pick a random unused, non-fallen character from the roster
    const available = SURVIVOR_ROSTER
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !usedIndices.has(i) && !(fallenNames && fallenNames.has(c.name)));

    pick = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      // Exhausted the unused pool — fall back to any non-fallen character so a
      // permadead survivor still never returns even when the roster is drained.
      : { c: _pickNonFallenFallback(fallenNames), i: -1 };
  }

  if (pick.i >= 0) usedIndices.add(pick.i);

  const char = pick.c;
  e.name         = char.name;
  e.title        = char.title;
  e.bio          = char.bio;
  e.abilities    = char.ability ? [char.ability] : [];
  e.abilityLabel = char.abilityLabel;
  e.color        = pick.i >= 0 ? SURVIVOR_COLORS[pick.i % SURVIVOR_COLORS.length] : SURVIVOR_COLORS[0];

  // Apply base stats from the character definition. BRAWLER / STURDY
  // passives are NOT baked into these numbers any more — getAttack() /
  // getDefense() compose the +1 from ABILITIES[id].statMods at call time.
  e.maxHp  = char.maxHp;
  e.hp     = char.maxHp;
  e.attack  = char.attack;
  e.defense = char.defense;
  if (typeof char.agility === 'number') e.agility = char.agility;

  // Spawn level (campaign authoring): hidden survivors / node spawns may be
  // tagged with a higher `level` so future-chapter recruits arrive scaled.
  // applyLevel snapshots the L1 base (the stats just assigned above) into
  // `_baseMaxHp`, rescales maxHp via hpForLevel, and sets hp = maxHp — so it
  // must run AFTER the base-stat assignment and BEFORE the entity is returned
  // (i.e. before any caller-side HP normalization). Idempotent and a no-op for
  // level 1, so normal/online survivors are unaffected.
  applyLevel(e, level || 1);

  return e;
}

/**
 * @deprecated Use `state.resetRoster()` instead. This module-level reset
 * remains only for editor previews and legacy tests that run without a
 * GameState. All in-game paths go through the per-state tracker.
 */
export function resetRoster() {
  _usedRosterIndices.clear();
}

/**
 * Look up a survivor roster index by character name. Returns -1 if no match.
 * Used by GameState.markRosterUsedByName() to avoid exposing the roster array.
 */
export function survivorRosterIndexByName(name) {
  return SURVIVOR_ROSTER.findIndex(c => c.name === name);
}

/**
 * Mark survivor roster entries as used by name so they won't be generated
 * again by createSurvivor(). Used by campaign mode to exclude carried-over
 * survivors from the discoverable pool.
 *
 * @deprecated Use `state.markRosterUsedByName(name)` instead. This
 * module-level variant exists only for editor previews and legacy tests
 * that run without a GameState.
 */
export function markRosterUsedByName(name) {
  const idx = SURVIVOR_ROSTER.findIndex(c => c.name === name);
  if (idx >= 0) _usedRosterIndices.add(idx);
}

function _witchColor(type, entity) {
  const palette = WITCH_UNIT_COLORS[type];
  return palette[parseInt(entity.id.slice(1)) % palette.length];
}

export function createZombie(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.ZOMBIE, 'witch', col, row, ownerId, state);
  e.color = _witchColor(EntityType.ZOMBIE, e);
  return e;
}

export function createMinion(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.MINION, 'witch', col, row, ownerId, state);
  e.color = _witchColor(EntityType.MINION, e);
  return e;
}

// Skeleton — the Necromancer's conjured summon (RAISE DEAD, fresh-summon path).
export function createSkeleton(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.SKELETON, 'witch', col, row, ownerId, state);
  e.color = _witchColor(EntityType.SKELETON, e);
  return e;
}

export function createWoodGolem(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.WOOD_GOLEM, 'witch', col, row, ownerId, state);
  e.color = _witchColor(EntityType.WOOD_GOLEM, e);
  return e;
}

export function createIronGolem(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.IRON_GOLEM, 'witch', col, row, ownerId, state);
  e.color = _witchColor(EntityType.IRON_GOLEM, e);
  return e;
}

// Soldier — day-side grunt. Summoner (Captain faction ability) lands in
// a follow-up PR; the factory is defined here so any caller that wants
// to place a Soldier (scenario setup, tests, future summon action) works
// off the same construction path as other non-leader units.
export function createSoldier(col, row, ownerId = null, state = null) {
  return new Entity(EntityType.SOLDIER, 'hero', col, row, ownerId, state);
}

/**
 * Advance the module-level entity ID counter past `minNumericId`.
 *
 * Primarily called indirectly by `GameState.bumpEntityId()` to keep the
 * module counter at or above each state's counter, so standalone factory
 * calls (editor previews, legacy tests) never collide with state entities.
 *
 * Direct callers should prefer `state.bumpEntityId()`.
 */
export function bumpEntityId(minNumericId) {
  if (minNumericId >= _nextId) _nextId = minNumericId + 1;
}
