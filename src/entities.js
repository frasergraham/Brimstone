// Entity definitions: Hero, Witch, named Survivors, Zombie, Minion, Golems
import { WEAPON_STATS } from './tiles.js';

let _nextId = 1;

export const EntityType = Object.freeze({
  HERO:       'hero',
  WITCH:      'witch',
  SURVIVOR:   'survivor',
  ZOMBIE:     'zombie',
  MINION:     'minion',
  WOOD_GOLEM: 'wood_golem',
  IRON_GOLEM: 'iron_golem',
});

// Survivor special abilities
export const SurvivorAbility = Object.freeze({
  FORTIFY_DOUBLE: 'fortify_double', // wood fortifies to full strength (level 2)
  HEAL:           'heal',           // action (1): heals hero on same hex 1 HP
  BRAWLER:        'brawler',        // passive: +1 ATK baked in
  STURDY:         'sturdy',         // passive: +1 DEF baked in
  HERBALIST:      'herbalist',      // passive: each explore also yields 1 Herbs
  INSPIRE:        'inspire',        // action (free): hero gets +1 ATK this battle
  RALLY:          'rally',          // action (free): hero gets +1 bonus action
  SCOUT:          'scout',          // passive: reveals witch units within 3 hexes
});

// One distinct colour per roster slot — used for unit circles and plan arrows.
const SURVIVOR_COLORS = [
  '#e67e22',  // orange
  '#1abc9c',  // teal
  '#e74c3c',  // crimson
  '#3498db',  // blue
  '#f39c12',  // amber
  '#a29bfe',  // lavender
  '#00b894',  // mint
  '#fd79a8',  // pink
  '#74b9ff',  // sky blue
  '#d63031',  // red
  '#00cec9',  // cyan
  '#e17055',  // salmon
];

// Named character pool — one is drawn at random when a survivor is discovered
export const SURVIVOR_ROSTER = [
  {
    name: "John O'Connor",
    title: 'Innkeeper',
    bio: "Ran the inn for thirty years. Built half the town's doors himself.",
    maxHp: 3, attack: 2, defense: 2,
    ability: SurvivorAbility.FORTIFY_DOUBLE,
    abilityLabel: 'Strong Back — fortifies a building to full strength with just Wood',
  },
  {
    name: 'Mary Quinn',
    title: 'Nurse',
    bio: "Kept half of Salem alive through the fever of '88.",
    maxHp: 3, attack: 1, defense: 3,
    ability: SurvivorAbility.HEAL,
    abilityLabel: 'Tend Wounds — heals the hero 1 HP (costs 1 action)',
  },
  {
    name: 'Thomas Putnam',
    title: 'Blacksmith',
    bio: "Arms like anvils. He's been hitting things with hammers his entire life.",
    maxHp: 3, attack: 3, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Iron Fists — +1 ATK (permanent, already applied)',
  },
  {
    name: 'Abigail Foster',
    title: 'Herbalist',
    bio: "She can find medicine in a snowdrift. Every expedition turns up something useful.",
    maxHp: 2, attack: 1, defense: 2,
    ability: SurvivorAbility.HERBALIST,
    abilityLabel: 'Wild Harvest — each exploration also yields 1 Herbs',
  },
  {
    name: 'Samuel Cooper',
    title: 'Militia Sergeant',
    bio: "Drilled the town militia for a decade. His voice alone steadies the line.",
    maxHp: 2, attack: 2, defense: 2,
    ability: SurvivorAbility.INSPIRE,
    abilityLabel: 'Battle Cry — grants hero +1 ATK for the next battle (free)',
  },
  {
    name: 'Father Crane',
    title: 'Parish Priest',
    bio: "His sermons are long but his faith is genuine. And occasionally useful.",
    maxHp: 3, attack: 1, defense: 3,
    ability: SurvivorAbility.RALLY,
    abilityLabel: 'Holy Sermon — grants the hero 1 bonus action (free)',
  },
  {
    name: 'Hannah Marsh',
    title: 'Baker',
    bio: "Survived three hard winters by sheer stubbornness.",
    maxHp: 4, attack: 1, defense: 3,
    ability: SurvivorAbility.STURDY,
    abilityLabel: 'Iron Stomach — +1 DEF (permanent, already applied)',
  },
  {
    name: 'Ezra Boone',
    title: 'Trapper',
    bio: "Spent thirty years in the deep woods. He sees the shadows before they see him.",
    maxHp: 2, attack: 2, defense: 2,
    ability: SurvivorAbility.SCOUT,
    abilityLabel: "Woodsman — reveals the witch's forces within 3 hexes",
  },
  {
    name: 'Constance Bell',
    title: 'Schoolteacher',
    bio: "Sharp-minded and resourceful. She reads the witch's markings like a primer.",
    maxHp: 2, attack: 1, defense: 2,
    ability: SurvivorAbility.HERBALIST,
    abilityLabel: 'Resourceful — each exploration also yields 1 Herbs',
  },
  {
    name: 'Isaac Graves',
    title: 'Gravedigger',
    bio: "Has faced death every working day. Nothing frightens him anymore.",
    maxHp: 4, attack: 1, defense: 3,
    ability: SurvivorAbility.STURDY,
    abilityLabel: 'Six Feet Under — +1 DEF (permanent, already applied)',
  },
  {
    name: 'Patience Cole',
    title: 'Midwife',
    bio: "Has guided life into the world through hardship and darkness alike.",
    maxHp: 4, attack: 1, defense: 3,
    ability: SurvivorAbility.HEAL,
    abilityLabel: 'Tender Care — heals the hero 1 HP (costs 1 action)',
  },
  {
    name: 'Silas Holt',
    title: 'Farmhand',
    bio: "Young, strong, and fueled by righteous anger.",
    maxHp: 2, attack: 2, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Farm Strong — +1 ATK (permanent, already applied)',
  },
];

// Track which roster entries have been used this game so no duplicates spawn
const _usedRosterIndices = new Set();

const BASE_STATS = {
  [EntityType.HERO]:       { maxHp: 14, attack: 3, defense: 2 },
  [EntityType.WITCH]:      { maxHp: 10, attack: 2, defense: 2 },
  [EntityType.SURVIVOR]:   { maxHp: 2, attack: 1, defense: 1 },
  [EntityType.ZOMBIE]:     { maxHp: 2, attack: 2, defense: 0 },
  [EntityType.MINION]:     { maxHp: 2, attack: 1, defense: 0 },
  [EntityType.WOOD_GOLEM]: { maxHp: 4, attack: 2, defense: 3 },
  [EntityType.IRON_GOLEM]: { maxHp: 6, attack: 3, defense: 4 },
};

// Visual colours used by the renderer
export const ENTITY_COLOR = {
  [EntityType.HERO]:       '#d4a72c',
  [EntityType.WITCH]:      '#9b59b6',
  [EntityType.SURVIVOR]:   '#4caf7d',
  [EntityType.ZOMBIE]:     '#7c9a57',
  [EntityType.MINION]:     '#c0392b',
  [EntityType.WOOD_GOLEM]: '#8B5E3C',
  [EntityType.IRON_GOLEM]: '#607D8B',
};

// Six shades per witch-unit type — cycled as units are created so each
// individual unit gets a distinct arrow/circle colour on the plan overlay.
const WITCH_UNIT_COLORS = {
  [EntityType.ZOMBIE]: [
    '#7c9a57', '#5c8a3c', '#91b268', '#4a7030', '#a8c97a', '#3d5c28',
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
  constructor(type, owner, col, row, ownerId = null) {
    this.id      = `e${_nextId++}`;
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

    // Personal backpack: herbs, weapons (key = 'weapon:sword' etc), horse
    this.items = {};
  }

  get alive() { return this.hp > 0; }

  get displayName() {
    if (this.name) return this.name;
    switch (this.type) {
      case EntityType.HERO:       return 'The Hero';
      case EntityType.WITCH:      return 'The Witch';
      case EntityType.SURVIVOR:   return 'Survivor';
      case EntityType.ZOMBIE:     return 'Zombie';
      case EntityType.MINION:     return 'Minion';
      case EntityType.WOOD_GOLEM: return 'Wood Golem';
      case EntityType.IRON_GOLEM: return 'Iron Golem';
    }
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
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    return !this.alive;
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  // phaseBonus:    extra attack from day/night advantage
  // extraAtkBonus: caller-supplied bonus (gang-up etc.) — NOT stored on the entity
  // extraDefBonus: caller-supplied bonus (fortify, gang-up etc.) — NOT stored on the entity
  // extraAtkDice / extraDefDice: number of additional d3s rolled for that side
  // (ally gang-up / defender ally support — gives variance instead of flat +1)
  // Returns full breakdown for UI rendering alongside the totals.
  static resolveCombat(attacker, defender, phaseBonus = 0, extraAtkBonus = 0, extraDefBonus = 0,
                       extraAtkDice = 0, extraDefDice = 0) {
    let extraAtk = phaseBonus + extraAtkBonus;
    let atkStaffBonus = 0;
    if (attacker.weapon === 'staff' &&
        (defender.type === EntityType.ZOMBIE ||
         defender.type === EntityType.MINION ||
         defender.type === EntityType.WOOD_GOLEM ||
         defender.type === EntityType.IRON_GOLEM)) {
      atkStaffBonus = 2;
      extraAtk += 2;
    }

    const atkBaseDie  = Math.ceil(Math.random() * 6);
    const defBaseDie  = Math.ceil(Math.random() * 6);
    const atkExtraDice = [];
    const defExtraDice = [];
    for (let i = 0; i < extraAtkDice; i++) atkExtraDice.push(Math.ceil(Math.random() * 3));
    for (let i = 0; i < extraDefDice; i++) defExtraDice.push(Math.ceil(Math.random() * 3));

    const attackRoll  = atkBaseDie + attacker.attack  + attacker.attackBonus + extraAtk
                        + atkExtraDice.reduce((s, r) => s + r, 0);
    const defenseRoll = defBaseDie + defender.defense + defender.defenseBonus + extraDefBonus
                        + defExtraDice.reduce((s, r) => s + r, 0);
    const margin = attackRoll - defenseRoll;
    return {
      attackRoll, defenseRoll, hit: margin > 0, margin,
      atkBaseDie, defBaseDie, atkExtraDice, defExtraDice, atkStaffBonus,
    };
  }
}

export function createHero(col, row, ownerId = null) {
  return new Entity(EntityType.HERO, 'hero', col, row, ownerId);
}

export function createWitch(col, row, ownerId = null) {
  return new Entity(EntityType.WITCH, 'witch', col, row, ownerId);
}

export function createSurvivor(col, row, ownerId = null) {
  const e = new Entity(EntityType.SURVIVOR, null, col, row, ownerId);

  // Pick a random unused character from the roster
  const available = SURVIVOR_ROSTER
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => !_usedRosterIndices.has(i));

  const pick = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : { c: SURVIVOR_ROSTER[Math.floor(Math.random() * SURVIVOR_ROSTER.length)], i: -1 };

  if (pick.i >= 0) _usedRosterIndices.add(pick.i);

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

  // Passive stat bonuses already baked into the roster stats,
  // but BRAWLER/STURDY are called out explicitly — stats are already correct.

  return e;
}

export function resetRoster() {
  _usedRosterIndices.clear();
}

function _witchColor(type, entity) {
  const palette = WITCH_UNIT_COLORS[type];
  return palette[parseInt(entity.id.slice(1)) % palette.length];
}

export function createZombie(col, row, ownerId = null) {
  const e = new Entity(EntityType.ZOMBIE, 'witch', col, row, ownerId);
  e.color = _witchColor(EntityType.ZOMBIE, e);
  return e;
}

export function createMinion(col, row, ownerId = null) {
  const e = new Entity(EntityType.MINION, 'witch', col, row, ownerId);
  e.color = _witchColor(EntityType.MINION, e);
  return e;
}

export function createWoodGolem(col, row, ownerId = null) {
  const e = new Entity(EntityType.WOOD_GOLEM, 'witch', col, row, ownerId);
  e.color = _witchColor(EntityType.WOOD_GOLEM, e);
  return e;
}

export function createIronGolem(col, row, ownerId = null) {
  const e = new Entity(EntityType.IRON_GOLEM, 'witch', col, row, ownerId);
  e.color = _witchColor(EntityType.IRON_GOLEM, e);
  return e;
}

/**
 * Advance the entity ID counter past `minNumericId` to prevent collisions
 * when deserializing a saved game that already contains entities with IDs
 * up to that value.  Call this after reconstructing saved entities.
 */
export function bumpEntityId(minNumericId) {
  if (minNumericId >= _nextId) _nextId = minNumericId + 1;
}
