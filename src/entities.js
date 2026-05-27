// Entity definitions: Hero, Witch, named Survivors, Zombie, Minion, Golems
import { WEAPON_STATS } from './tiles.js';
import { UNIT_TYPES } from './unit-types.js';
import { ITEMS } from './items.js';
import { SurvivorAbility, ABILITIES } from './abilities.js';
import {
  effectStatMod, effectRangeMod, effectIncomingAtkAdvantage,
  effectDamageTakenFlat, effectsBlockHeal,
} from './effects.js';

let _nextId = 1;

// Sum the statMod contribution of all passive abilities on a unit.
// Phase 4 handles brawler (+1 attack) and sturdy (+1 defense); future
// entries only need to add a statMods field to the ABILITIES registry.
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

// Attack range per entity type. 1 = melee only; >1 = ranged. Mirrors the
// pattern of BASE_AGILITY / ENTITY_COLOR — derived from the UNIT_TYPES
// registry so adding a ranged unit is a one-file change.
export const BASE_RANGE = Object.freeze(
  Object.fromEntries(Object.entries(UNIT_TYPES).map(([k, v]) => [k, v.range ?? 1]))
);

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

    const stats = BASE_STATS[type];
    this.maxHp   = stats.maxHp;
    this.hp      = stats.maxHp;
    this.attack  = stats.attack;
    this.defense = stats.defense;
    this.agility = BASE_AGILITY[type] ?? 1;
    this.range   = BASE_RANGE[type]   ?? 1;

    // Tag metadata from UNIT_TYPES (e.g. 'undead', 'construct', 'minion',
    // 'living', 'leader', 'day-leader'). Used by item combat triggers —
    // e.g. staff's anti-undead bonus iterates ITEMS.staff.combatTriggers
    // and matches against defender.tags. Empty array for any entity type
    // missing from UNIT_TYPES (shouldn't happen in production).
    this.tags = UNIT_TYPES[type]?.tags ?? [];

    // Temporary combat modifiers (reset each turn)
    this.attackBonus  = 0;
    this.defenseBonus = 0;

    // Equipped weapon
    this.weapon = null;

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

    // Per-round counters consulted by ability/effect triggers (e.g. berserker
    // fires frenzy when killsThisRound >= 2). Reset in resetTurn().
    this.killsThisRound = 0;

    // Time-bound runtime augments — see src/effects.js. Records:
    //   { id, duration, stacks, source? }
    // Stat composition runs in getAttack/getDefense/getRange/getAgility.
    this.effects = [];

    // Personal backpack — a flat key→count map. Weapons use their ITEMS
    // id directly (e.g. 'sword'); consumables and mounts use their
    // resource/item id (e.g. 'horse', 'herbs'). ITEMS[key].kind
    // distinguishes weapon from consumable.
    this.items = {};
  }

  get alive() { return this.hp > 0; }

  get displayName() {
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
  // During Phase 2 the weapon bonus is still baked into `this.attack` by
  // equipWeapon(); Phase 3 decouples the two, at which point these
  // accessors compose the bonus from ITEMS[this.weapon].statMods instead.
  // Call sites stay correct across that transition.

  getAttack()  {
    return this.attack
      + (ITEMS[this.weapon]?.statMods?.attack ?? 0)
      + _abilityStatMod(this.abilities, 'attack')
      + effectStatMod(this, 'attack');
  }
  getDefense() {
    return this.defense
      + (ITEMS[this.weapon]?.statMods?.defense ?? 0)
      + _abilityStatMod(this.abilities, 'defense')
      + effectStatMod(this, 'defense');
  }
  getAgility() {
    return (this.agility ?? 1)
      + _abilityStatMod(this.abilities, 'agility')
      + effectStatMod(this, 'agility');
  }
  // Attack range in hexes. 1 = melee only; >1 = ranged. Effects like
  // eagle_eyed extend range via rangeMod; permanent abilities (eagle_eye)
  // compose via ABILITIES[id].statMods.range, mirroring attack/defense.
  getRange() {
    return (this.range ?? 1)
      + _abilityStatMod(this.abilities, 'range')
      + effectRangeMod(this);
  }

  // Movement range in tiles. 1 base, +1 with horse equipped.
  getMoveRange() {
    return 1 + ((this.items?.['horse'] || 0) > 0 ? 1 : 0);
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

  equipWeapon(weaponType) {
    // Phase 3: weapon stats are no longer baked into this.attack /
    // this.defense. getAttack() / getDefense() compose the bonus from
    // ITEMS[this.weapon].statMods at call time. This keeps the base
    // stat stable across weapon swaps and makes equipped weapons a
    // true runtime-composed modifier.
    this.weapon = weaponType || null;
  }

  resetTurn() {
    this.actedThisTurn = false;
    this.attackBonus   = 0;
    this.defenseBonus  = 0;
    this.defendCount   = 0;
    this.guarding      = 0;
    this.killsThisRound = 0;
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    return !this.alive;
  }

  /**
   * Compute the effective incoming damage for a base hit, after applying
   * effect mods (e.g. wounded → +1). Currently only flat additions; the
   * shape leaves room for resistances later. Damage never goes below 1
   * once a hit lands — effects can amplify pain, not cancel it outright.
   */
  applyIncomingDamage(baseAmount) {
    const flat = effectDamageTakenFlat(this);
    return Math.max(1, baseAmount + flat);
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
  static resolveCombat(attacker, defender, options = {}) {
    const {
      phaseAdvantage = 0,
      atkAdvantageDice = 0,
      atkDisadvantageDice = 0,
      defAdvantageDice = 0,
      defDisadvantageDice = 0,
      extraAtkBonus = 0,
      extraDefBonus = 0,
      fatiguePenalty = 0,
      state = null,
    } = options;

    const roll = state ? (s) => state.nextDie(s) : _nextDie;

    // Item combat triggers (e.g. staff vs undead defenders →
    // +1 attacker advantage die). Data-driven via ITEMS[weapon].combatTriggers
    // so adding a new conditional weapon effect is a one-file change. The
    // defender's tag set is sourced from `defender.tags` (set in the Entity
    // constructor) and falls back to UNIT_TYPES for plain-object test fixtures.
    let atkStaffAdvantage = 0;
    const triggers = ITEMS[attacker.weapon]?.combatTriggers ?? [];
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

    const atkPool = _rollPool(roll, atkNet);
    const defPool = _rollPool(roll, defNet);
    const atkBaseDie = _pickFromPool(atkPool, atkNet);
    const defBaseDie = _pickFromPool(defPool, defNet);

    const attackRoll  = atkBaseDie + attackOf(attacker)  + (attacker.attackBonus  || 0) + extraAtkBonus;
    const defenseRoll = defBaseDie + defenseOf(defender) + (defender.defenseBonus || 0) + extraDefBonus - fatiguePenalty;
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
}

// Stat accessors that tolerate plain-object entity fixtures (used by unit
// tests that skip the Entity constructor) as well as real Entity instances.
// Production callers prefer `entity.getAttack()` / `entity.getDefense()`
// directly; these wrappers exist so Entity.resolveCombat and AI
// estimateCombat helpers don't break on lightweight test fixtures.
//
// For plain objects (post-Phase-3), the fallback composes the weapon
// bonus from ITEMS[weapon].statMods so fixtures that set
// { attack: 3, weapon: 'sword' } resolve to an effective value of 5,
// matching Entity.getAttack() semantics.
export function attackOf(e) {
  if (typeof e?.getAttack === 'function') return e.getAttack();
  const base        = e?.attack ?? 0;
  const weaponMod   = e?.weapon ? (ITEMS[e.weapon]?.statMods?.attack ?? 0) : 0;
  const abilityMod  = _abilityStatMod(e?.abilities, 'attack');
  const effectMod   = effectStatMod(e, 'attack');
  return base + weaponMod + abilityMod + effectMod;
}
export function defenseOf(e) {
  if (typeof e?.getDefense === 'function') return e.getDefense();
  const base        = e?.defense ?? 0;
  const weaponMod   = e?.weapon ? (ITEMS[e.weapon]?.statMods?.defense ?? 0) : 0;
  const abilityMod  = _abilityStatMod(e?.abilities, 'defense');
  const effectMod   = effectStatMod(e, 'defense');
  return base + weaponMod + abilityMod + effectMod;
}
// Attack range in hexes — tolerates plain-object fixtures. Falls back to
// UNIT_TYPES[type].range so tests that skip the Entity constructor still
// see the correct range for a given entity type.
export function rangeOf(e) {
  if (typeof e?.getRange === 'function') return e.getRange();
  const base       = e?.range ?? UNIT_TYPES[e?.type]?.range ?? 1;
  const abilityMod = _abilityStatMod(e?.abilities, 'range');
  const effectMod  = effectRangeMod(e);
  return base + abilityMod + effectMod;
}

// ── Advantage-dice math ─────────────────────────────────────────────────────

// Cap total advantage/disadvantage dice each side can accumulate.
export const ADVANTAGE_CAP = 4;

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
  [EntityType.MINION]:      'Minion',
  [EntityType.WOOD_GOLEM]:  'Wood Golem',
  [EntityType.IRON_GOLEM]:  'Iron Golem',
};

/** Default display name for an entity type (falls back to the raw type id). */
export function defaultDisplayName(type) {
  return _DEFAULT_DISPLAY_NAMES[type] ?? type;
}

export function createSurvivor(col, row, ownerId = null, state = null, forcedName = null) {
  const e = new Entity(EntityType.SURVIVOR, null, col, row, ownerId, state);

  // Roster de-dup tracker lives on the GameState when one is provided;
  // otherwise fall back to the module-level set (editor previews / raw tests).
  const usedIndices = state ? state.usedRosterIndices : _usedRosterIndices;

  // Forced pick: when an authored mission tile names a specific survivor,
  // spawn THAT roster character. Unknown / null names fall through to the
  // existing random pick (back-compat).
  let pick = null;
  if (forcedName != null) {
    const fi = SURVIVOR_ROSTER.findIndex(c => c.name === forcedName);
    if (fi >= 0) pick = { c: SURVIVOR_ROSTER[fi], i: fi };
  }

  if (!pick) {
    // Pick a random unused character from the roster
    const available = SURVIVOR_ROSTER
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !usedIndices.has(i));

    pick = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : { c: SURVIVOR_ROSTER[Math.floor(Math.random() * SURVIVOR_ROSTER.length)], i: -1 };
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
