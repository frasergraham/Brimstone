// Entity definitions: Hero, Witch, Survivor, Zombie, Minion, Wood Golem, Iron Golem
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

const BASE_STATS = {
  [EntityType.HERO]:       { maxHp: 5, attack: 3, defense: 2 },
  [EntityType.WITCH]:      { maxHp: 4, attack: 2, defense: 1 },
  [EntityType.SURVIVOR]:   { maxHp: 2, attack: 1, defense: 1 },
  [EntityType.ZOMBIE]:     { maxHp: 2, attack: 2, defense: 0 },
  [EntityType.MINION]:     { maxHp: 3, attack: 2, defense: 1 },
  [EntityType.WOOD_GOLEM]: { maxHp: 4, attack: 2, defense: 3 },
  [EntityType.IRON_GOLEM]: { maxHp: 6, attack: 3, defense: 4 },
};

// Visual colours used by the renderer
export const ENTITY_COLOR = {
  [EntityType.HERO]:       '#d4a72c',  // gold
  [EntityType.WITCH]:      '#9b59b6',  // purple
  [EntityType.SURVIVOR]:   '#4caf7d',  // green
  [EntityType.ZOMBIE]:     '#7c9a57',  // sickly green
  [EntityType.MINION]:     '#c0392b',  // red
  [EntityType.WOOD_GOLEM]: '#8B5E3C',  // brown
  [EntityType.IRON_GOLEM]: '#607D8B',  // steel blue-grey
};

export class Entity {
  constructor(type, owner, col, row) {
    this.id    = `e${_nextId++}`;
    this.type  = type;
    this.owner = owner;  // 'hero' | 'witch' | null

    this.col = col;
    this.row = row;

    const stats = BASE_STATS[type];
    this.maxHp  = stats.maxHp;
    this.hp     = stats.maxHp;
    this.attack  = stats.attack;
    this.defense = stats.defense;

    // Temporary combat modifiers (reset each turn)
    this.attackBonus  = 0;
    this.defenseBonus = 0;

    // Equipped weapon (permanently modifies attack/defense when set)
    this.weapon = null;  // WeaponType | null

    // Whether this entity has acted this turn
    this.actedThisTurn = false;
  }

  get alive() { return this.hp > 0; }

  get displayName() {
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

  // Equip a weapon: removes old weapon stats, applies new ones
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

  // Called at the start of each new turn to reset temp state
  resetTurn() {
    this.actedThisTurn = false;
    this.attackBonus   = 0;
    this.defenseBonus  = 0;
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    return !this.alive;  // returns true if killed
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  // Roll combat: returns {attackRoll, defenseRoll, hit}
  static resolveCombat(attacker, defender) {
    // Staff is +2 attack vs undead types
    let extraAtk = 0;
    if (attacker.weapon === 'staff' &&
        (defender.type === EntityType.ZOMBIE ||
         defender.type === EntityType.MINION ||
         defender.type === EntityType.WOOD_GOLEM ||
         defender.type === EntityType.IRON_GOLEM)) {
      extraAtk = 2;
    }
    const attackRoll  = Math.ceil(Math.random() * 6) + attacker.attack  + attacker.attackBonus + extraAtk;
    const defenseRoll = Math.ceil(Math.random() * 6) + defender.defense + defender.defenseBonus;
    return { attackRoll, defenseRoll, hit: attackRoll > defenseRoll };
  }
}

export function createHero(col, row) {
  return new Entity(EntityType.HERO, 'hero', col, row);
}

export function createWitch(col, row) {
  return new Entity(EntityType.WITCH, 'witch', col, row);
}

export function createSurvivor(col, row) {
  return new Entity(EntityType.SURVIVOR, null, col, row);
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
