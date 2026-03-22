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

// Named character pool — one is drawn at random when a survivor is discovered
export const SURVIVOR_ROSTER = [
  {
    name: "John O'Connor",
    title: 'Innkeeper',
    bio: "Ran the inn for thirty years. Built half the town's doors himself.",
    maxHp: 4, attack: 2, defense: 2,
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
    maxHp: 4, attack: 3, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Iron Fists — +1 ATK (permanent, already applied)',
  },
  {
    name: 'Abigail Foster',
    title: 'Herbalist',
    bio: "She can find medicine in a snowdrift. Every expedition turns up something useful.",
    maxHp: 3, attack: 1, defense: 2,
    ability: SurvivorAbility.HERBALIST,
    abilityLabel: 'Wild Harvest — each exploration also yields 1 Herbs',
  },
  {
    name: 'Samuel Cooper',
    title: 'Militia Sergeant',
    bio: "Drilled the town militia for a decade. His voice alone steadies the line.",
    maxHp: 3, attack: 2, defense: 2,
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
    maxHp: 3, attack: 2, defense: 2,
    ability: SurvivorAbility.SCOUT,
    abilityLabel: "Woodsman — reveals the witch's forces within 3 hexes",
  },
  {
    name: 'Constance Bell',
    title: 'Schoolteacher',
    bio: "Sharp-minded and resourceful. She reads the witch's markings like a primer.",
    maxHp: 3, attack: 2, defense: 2,
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
    maxHp: 3, attack: 2, defense: 2,
    ability: SurvivorAbility.BRAWLER,
    abilityLabel: 'Farm Strong — +1 ATK (permanent, already applied)',
  },
];

// Track which roster entries have been used this game so no duplicates spawn
const _usedRosterIndices = new Set();

const BASE_STATS = {
  [EntityType.HERO]:       { maxHp: 10, attack: 3, defense: 2 },
  [EntityType.WITCH]:      { maxHp: 8, attack: 2, defense: 1 },
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

export class Entity {
  constructor(type, owner, col, row) {
    this.id    = `e${_nextId++}`;
    this.type  = type;
    this.owner = owner;

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
  static resolveCombat(attacker, defender, phaseBonus = 0, extraAtkBonus = 0, extraDefBonus = 0) {
    let extraAtk = phaseBonus + extraAtkBonus;
    // Staff is +2 attack vs undead/golem types
    if (attacker.weapon === 'staff' &&
        (defender.type === EntityType.ZOMBIE ||
         defender.type === EntityType.MINION ||
         defender.type === EntityType.WOOD_GOLEM ||
         defender.type === EntityType.IRON_GOLEM)) {
      extraAtk += 2;
    }
    const attackRoll  = Math.ceil(Math.random() * 6) + attacker.attack  + attacker.attackBonus + extraAtk;
    const defenseRoll = Math.ceil(Math.random() * 6) + defender.defense + defender.defenseBonus + extraDefBonus;
    const margin = attackRoll - defenseRoll;
    return { attackRoll, defenseRoll, hit: margin > 0, margin };
  }
}

export function createHero(col, row) {
  return new Entity(EntityType.HERO, 'hero', col, row);
}

export function createWitch(col, row) {
  return new Entity(EntityType.WITCH, 'witch', col, row);
}

export function createSurvivor(col, row) {
  const e = new Entity(EntityType.SURVIVOR, null, col, row);

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

export function createZombie(col, row) {
  return new Entity(EntityType.ZOMBIE, 'witch', col, row);
}

export function createMinion(col, row) {
  return new Entity(EntityType.MINION, 'witch', col, row);
}

export function createWoodGolem(col, row) {
  return new Entity(EntityType.WOOD_GOLEM, 'witch', col, row);
}

export function createIronGolem(col, row) {
  return new Entity(EntityType.IRON_GOLEM, 'witch', col, row);
}
