// Entity definitions: Hero, Witch, Survivor, Zombie, Minion

let _nextId = 1;

export const EntityType = Object.freeze({
  HERO:     'hero',
  WITCH:    'witch',
  SURVIVOR: 'survivor',
  ZOMBIE:   'zombie',
  MINION:   'minion',
});

const BASE_STATS = {
  [EntityType.HERO]:     { maxHp: 5, attack: 3, defense: 2 },
  [EntityType.WITCH]:    { maxHp: 4, attack: 2, defense: 1 },
  [EntityType.SURVIVOR]: { maxHp: 2, attack: 1, defense: 1 },
  [EntityType.ZOMBIE]:   { maxHp: 2, attack: 2, defense: 0 },
  [EntityType.MINION]:   { maxHp: 3, attack: 2, defense: 1 },
};

// Visual colours used by the renderer
export const ENTITY_COLOR = {
  [EntityType.HERO]:     '#d4a72c',  // gold
  [EntityType.WITCH]:    '#9b59b6',  // purple
  [EntityType.SURVIVOR]: '#4caf7d',  // green
  [EntityType.ZOMBIE]:   '#7c9a57',  // sickly green
  [EntityType.MINION]:   '#c0392b',  // red
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

    // Whether this entity has acted this turn
    this.actedThisTurn = false;
  }

  get alive() { return this.hp > 0; }

  get displayName() {
    switch (this.type) {
      case EntityType.HERO:     return 'The Hero';
      case EntityType.WITCH:    return 'The Witch';
      case EntityType.SURVIVOR: return `Survivor`;
      case EntityType.ZOMBIE:   return `Zombie`;
      case EntityType.MINION:   return `Minion`;
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
    const attackRoll  = Math.ceil(Math.random() * 6) + attacker.attack  + attacker.attackBonus;
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
