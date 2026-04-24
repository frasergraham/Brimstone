// Entity definitions: Hero, Witch, named Survivors, Zombie, Minion, Golems
import { WEAPON_STATS } from './tiles.js';
import { UNIT_TYPES } from './unit-types.js';
import { SurvivorAbility } from './abilities.js';

let _nextId = 1;

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
  ZOMBIE:      'zombie',
  MINION:      'minion',
  WOOD_GOLEM:  'wood_golem',
  IRON_GOLEM:  'iron_golem',
});

// Survivor special abilities. The canonical registry lives in
// src/abilities.js; this re-export keeps the legacy `SurvivorAbility.X`
// call sites working during the phased migration.
export { SurvivorAbility };

// One distinct colour per roster slot — used for unit circles and plan arrows.
// Friendly palette: greens, blues and yellows so survivors read as civilian/ally.
const SURVIVOR_COLORS = [
  '#5dbd72',  // forest green
  '#4ab5d4',  // sky blue
  '#d4c44a',  // wheat yellow
  '#3ec98c',  // jade green
  '#5fa8e8',  // cornflower blue
  '#e8d454',  // sunflower yellow
  '#7dd65e',  // lime green
  '#3eb8c8',  // teal
  '#c8d440',  // yellow-green
  '#68c4e0',  // light blue
  '#4cba5a',  // vivid green
  '#f0e060',  // bright yellow
  '#a8d86c',  // pastel lime
  '#48a0c0',  // steel blue
  '#d0b840',  // dark gold
  '#60d4a0',  // mint
  '#88b8f0',  // periwinkle
  '#c8e048',  // chartreuse
  '#50c8a0',  // seafoam
  '#e0c868',  // muted amber
];

// Named character pool — one is drawn at random when a survivor is discovered
export const SURVIVOR_ROSTER = [
  {
    name: "John O'Connor",
    title: 'Innkeeper',
    bio: "Ran the inn for thirty years. Built half the town's doors himself.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.FORTIFY_DOUBLE,
    abilityLabel: 'Strong Back — fortifies a building to full strength with just Wood',
  },
  {
    name: 'Mary Quinn',
    title: 'Nurse',
    bio: "Kept half of Caleb's Hollow alive through the fever of '88.",
    maxHp: 5, attack: 1, defense: 3,
    ability: SurvivorAbility.HEAL,
    abilityLabel: 'Tend Wounds — heals the hero 1 HP (costs 1 action)',
  },
  {
    name: 'Thomas Putnam',
    title: 'Blacksmith',
    bio: "Arms like anvils. He's been hitting things with hammers his entire life.",
    maxHp: 5, attack: 3, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Iron Fists — +1 ATK (permanent, already applied)',
  },
  {
    name: 'Abigail Foster',
    title: 'Herbalist',
    bio: "She can find medicine in a snowdrift. Every expedition turns up something useful.",
    maxHp: 4, attack: 1, defense: 2,
    ability: SurvivorAbility.HERBALIST,
    abilityLabel: 'Wild Harvest — each exploration also yields 1 Herbs',
  },
  {
    name: 'Samuel Cooper',
    title: 'Militia Sergeant',
    bio: "Drilled the town militia for a decade. His voice alone steadies the line.",
    maxHp: 4, attack: 2, defense: 2,
    ability: SurvivorAbility.INSPIRE,
    abilityLabel: 'Battle Cry — grants hero +1 ATK for the next battle (free)',
  },
  {
    name: 'Father Crane',
    title: 'Parish Priest',
    bio: "His sermons are long but his faith is genuine. And occasionally useful.",
    maxHp: 5, attack: 1, defense: 3,
    ability: SurvivorAbility.RALLY,
    abilityLabel: 'Holy Sermon — grants the hero 1 bonus action (free)',
  },
  {
    name: 'Hannah Marsh',
    title: 'Baker',
    bio: "Survived three hard winters by sheer stubbornness.",
    maxHp: 7, attack: 1, defense: 3,
    ability: SurvivorAbility.STURDY,
    abilityLabel: 'Iron Stomach — +1 DEF (permanent, already applied)',
  },
  {
    name: 'Ezra Boone',
    title: 'Trapper',
    bio: "Spent thirty years in the deep woods. He sees the shadows before they see him.",
    maxHp: 4, attack: 2, defense: 2,
    ability: SurvivorAbility.SCOUT,
    abilityLabel: "Woodsman — reveals the witch's forces within 3 hexes",
  },
  {
    name: 'Constance Bell',
    title: 'Schoolteacher',
    bio: "Sharp-minded and resourceful. She reads the witch's markings like a primer.",
    maxHp: 4, attack: 1, defense: 2,
    ability: SurvivorAbility.HERBALIST,
    abilityLabel: 'Resourceful — each exploration also yields 1 Herbs',
  },
  {
    name: 'Isaac Graves',
    title: 'Gravedigger',
    bio: "Has faced death every working day. Nothing frightens him anymore.",
    maxHp: 7, attack: 1, defense: 3,
    ability: SurvivorAbility.STURDY,
    abilityLabel: 'Six Feet Under — +1 DEF (permanent, already applied)',
  },
  {
    name: 'Patience Cole',
    title: 'Midwife',
    bio: "Has guided life into the world through hardship and darkness alike.",
    maxHp: 7, attack: 1, defense: 3,
    ability: SurvivorAbility.HEAL,
    abilityLabel: 'Tender Care — heals the hero 1 HP (costs 1 action)',
  },
  {
    name: 'Silas Holt',
    title: 'Farmhand',
    bio: "Young, strong, and fueled by righteous anger.",
    maxHp: 4, attack: 2, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Farm Strong — +1 ATK (permanent, already applied)',
  },
  {
    name: 'Mercy Hale',
    title: 'Tanner',
    bio: "Cures leather like her grandmother before her. Hands tough as the hides she works.",
    maxHp: 5, attack: 2, defense: 3,
    ability: SurvivorAbility.STURDY,
    abilityLabel: 'Thick Skin — +1 DEF (permanent, already applied)',
  },
  {
    name: 'Elijah Pratt',
    title: 'Chandler',
    bio: "Makes candles and soap. Knows every cellar and storeroom in town.",
    maxHp: 4, attack: 2, defense: 2,
    ability: SurvivorAbility.SCOUT,
    abilityLabel: "Candle Light — reveals the witch's forces within 3 hexes",
  },
  {
    name: 'Ruth Wardwell',
    title: 'Goodwife',
    bio: "Raised seven children through famine and fever. Nothing breaks her resolve.",
    maxHp: 7, attack: 1, defense: 2,
    ability: SurvivorAbility.RALLY,
    abilityLabel: 'Stalwart Spirit — grants the hero 1 bonus action (free)',
  },
  {
    name: 'Nathaniel Corwin',
    title: 'Constable',
    bio: "Enforced the law before the law stopped mattering.",
    maxHp: 5, attack: 3, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Heavy Hand — +1 ATK (permanent, already applied)',
  },
  {
    name: 'Agnes Whittaker',
    title: 'Weaver',
    bio: "Her loom sits idle but her hands are still quick with needle and knot.",
    maxHp: 4, attack: 1, defense: 2,
    ability: SurvivorAbility.FORTIFY_DOUBLE,
    abilityLabel: 'Nimble Fingers — fortifies a building to full strength with just Wood',
  },
  {
    name: 'Josiah Dane',
    title: 'Carpenter',
    bio: "Built half the roofs in Caleb's Hollow. Knows timber like a brother.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.FORTIFY_DOUBLE,
    abilityLabel: 'Master Builder — fortifies a building to full strength with just Wood',
  },
  {
    name: 'Prudence Faulkner',
    title: "Apothecary's Daughter",
    bio: "Learned her mother's remedies before the trials took everything.",
    maxHp: 4, attack: 1, defense: 3,
    ability: SurvivorAbility.HEAL,
    abilityLabel: 'Salve and Poultice — heals the hero 1 HP (costs 1 action)',
  },
  {
    name: 'Caleb Osgood',
    title: 'Fisherman',
    bio: "Hauled nets in storms that would drown lesser men.",
    maxHp: 5, attack: 2, defense: 2,
    ability: SurvivorAbility.INSPIRE,
    abilityLabel: 'Sea-Hardened — grants hero +1 ATK for the next battle (free)',
  },
];

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

    // Temporary combat modifiers (reset each turn)
    this.attackBonus  = 0;
    this.defenseBonus = 0;

    // Equipped weapon
    this.weapon = null;

    // Survivor personality fields (set by createSurvivor)
    this.name     = null;
    this.title    = null;
    this.bio      = null;
    this.ability  = null;
    this.abilityLabel = null;

    this.actedThisTurn = false;
    this.defendCount   = 0;
    this.guarding      = 0;

    // Personal backpack: herbs, weapons (key = 'weapon:sword' etc), horse
    this.items = {};
  }

  get alive() { return this.hp > 0; }

  get displayName() {
    return this.name ?? defaultDisplayName(this.type);
  }

  equipWeapon(weaponType) {
    if (this.weapon) {
      const old = WEAPON_STATS[this.weapon];
      this.attack  -= old.attackBonus;
      this.defense -= old.defenseBonus;
    }
    this.weapon = weaponType;
    if (weaponType) {
      const stats = WEAPON_STATS[weaponType];
      this.attack  += stats.attackBonus;
      this.defense += stats.defenseBonus;
    }
  }

  resetTurn() {
    this.actedThisTurn = false;
    this.attackBonus   = 0;
    this.defenseBonus  = 0;
    this.defendCount   = 0;
    this.guarding      = 0;
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    return !this.alive;
  }

  heal(amount) {
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

    // Staff vs undead/minions/golems → +1 attacker advantage die.
    let atkStaffAdvantage = 0;
    if (attacker.weapon === 'staff' &&
        (defender.type === EntityType.ZOMBIE ||
         defender.type === EntityType.MINION ||
         defender.type === EntityType.WOOD_GOLEM ||
         defender.type === EntityType.IRON_GOLEM)) {
      atkStaffAdvantage = 1;
    }

    const atkNet = clampAdvantage(
      (phaseAdvantage + atkAdvantageDice + atkStaffAdvantage) - atkDisadvantageDice
    );
    const defNet = clampAdvantage(defAdvantageDice - defDisadvantageDice);

    const atkPool = _rollPool(roll, atkNet);
    const defPool = _rollPool(roll, defNet);
    const atkBaseDie = _pickFromPool(atkPool, atkNet);
    const defBaseDie = _pickFromPool(defPool, defNet);

    const attackRoll  = atkBaseDie + attacker.attack  + (attacker.attackBonus  || 0) + extraAtkBonus;
    const defenseRoll = defBaseDie + defender.defense + (defender.defenseBonus || 0) + extraDefBonus - fatiguePenalty;
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

export function createSurvivor(col, row, ownerId = null, state = null) {
  const e = new Entity(EntityType.SURVIVOR, null, col, row, ownerId, state);

  // Roster de-dup tracker lives on the GameState when one is provided;
  // otherwise fall back to the module-level set (editor previews / raw tests).
  const usedIndices = state ? state.usedRosterIndices : _usedRosterIndices;

  // Pick a random unused character from the roster
  const available = SURVIVOR_ROSTER
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => !usedIndices.has(i));

  const pick = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : { c: SURVIVOR_ROSTER[Math.floor(Math.random() * SURVIVOR_ROSTER.length)], i: -1 };

  if (pick.i >= 0) usedIndices.add(pick.i);

  const char = pick.c;
  e.name         = char.name;
  e.title        = char.title;
  e.bio          = char.bio;
  e.ability      = char.ability;
  e.abilityLabel = char.abilityLabel;
  e.color        = pick.i >= 0 ? SURVIVOR_COLORS[pick.i % SURVIVOR_COLORS.length] : SURVIVOR_COLORS[0];

  // Apply base stats from the character definition
  e.maxHp  = char.maxHp;
  e.hp     = char.maxHp;
  e.attack  = char.attack;
  e.defense = char.defense;
  if (typeof char.agility === 'number') e.agility = char.agility;

  // Passive stat bonuses already baked into the roster stats,
  // but BRAWLER/STURDY are called out explicitly — stats are already correct.

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
