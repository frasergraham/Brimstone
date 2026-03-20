// Tile types, building types, resources, weapons, and their visual properties

export const TileType = Object.freeze({
  GRASS:    'grass',
  FOREST:   'forest',
  ROAD:     'road',
  RIVER:    'river',
  BUILDING: 'building',
});

export const BuildingType = Object.freeze({
  TOWN_HALL:   'town_hall',
  CHURCH:      'church',
  INN:         'inn',
  BLACKSMITH:  'blacksmith',
  GRAVEYARD:   'graveyard',
  MILL:        'mill',
  DOCK:        'dock',
  HOUSE:       'house',
  BARN:        'barn',
  WATCHTOWER:  'watchtower',
  APOTHECARY:  'apothecary',
  STOREHOUSE:  'storehouse',
  STABLE:      'stable',
});

export const ResourceType = Object.freeze({
  HERBS:     'herbs',     // Hero: heal 1 HP
  SILVER:    'silver',    // Hero: +1 attack for next battle
  WOOD:      'wood',      // Fortify a building (+1 def) or raise Wood Golem
  METAL:     'metal',     // Reinforce a building (+2 def) or raise Iron Golem
  FOOD:      'food',      // Gain 1 extra action this turn
  SCRIPTURE: 'scripture', // Ward off a witch unit (push back 1 hex)
});

export const WeaponType = Object.freeze({
  SWORD:  'sword',   // +2 attack
  AXE:    'axe',     // +1 attack, +1 defense
  BOW:    'bow',     // +1 attack
  SHIELD: 'shield',  // +2 defense
  STAFF:  'staff',   // +1 attack, +2 vs undead
  DAGGER: 'dagger',  // +1 attack
});

export const WEAPON_STATS = {
  [WeaponType.SWORD]:  { attackBonus: 2, defenseBonus: 0 },
  [WeaponType.AXE]:    { attackBonus: 1, defenseBonus: 1 },
  [WeaponType.BOW]:    { attackBonus: 1, defenseBonus: 0 },
  [WeaponType.SHIELD]: { attackBonus: 0, defenseBonus: 2 },
  [WeaponType.STAFF]:  { attackBonus: 1, defenseBonus: 0 },
  [WeaponType.DAGGER]: { attackBonus: 1, defenseBonus: 0 },
};

export const WEAPON_LABEL = {
  [WeaponType.SWORD]:  '⚔ Sword (+2 ATK)',
  [WeaponType.AXE]:    '🪓 Axe (+1 ATK, +1 DEF)',
  [WeaponType.BOW]:    '🏹 Bow (+1 ATK)',
  [WeaponType.SHIELD]: '🛡 Shield (+2 DEF)',
  [WeaponType.STAFF]:  '🪄 Staff (+1 ATK, +2 vs undead)',
  [WeaponType.DAGGER]: '🗡 Dagger (+1 ATK)',
};

// Passability: can entities move through this tile type?
export const TILE_PASSABLE = {
  [TileType.GRASS]:    true,
  [TileType.FOREST]:   true,
  [TileType.ROAD]:     true,
  [TileType.RIVER]:    false,  // requires bridge / dock adjacency
  [TileType.BUILDING]: true,
};

// Visual colors (used by renderer)
export const TILE_COLOR = {
  [TileType.GRASS]:    '#3a5430',
  [TileType.FOREST]:   '#1b2e1a',
  [TileType.ROAD]:     '#5e4e34',
  [TileType.RIVER]:    '#16304f',
  [TileType.BUILDING]: '#4a3c2c',
};

export const BUILDING_COLOR = {
  [BuildingType.TOWN_HALL]:  '#7a5c10',
  [BuildingType.CHURCH]:     '#8a8a8a',
  [BuildingType.INN]:        '#7a4a20',
  [BuildingType.BLACKSMITH]: '#484848',
  [BuildingType.GRAVEYARD]:  '#2c2c2c',
  [BuildingType.MILL]:       '#6a5020',
  [BuildingType.DOCK]:       '#1e4f6a',
  [BuildingType.HOUSE]:      '#6a4a2c',
  [BuildingType.BARN]:       '#7a5c30',
  [BuildingType.WATCHTOWER]: '#5a5a6a',
  [BuildingType.APOTHECARY]: '#4a6a3a',
  [BuildingType.STOREHOUSE]: '#5a4a3a',
  [BuildingType.STABLE]:     '#7a6040',
};

export const BUILDING_LABEL = {
  [BuildingType.TOWN_HALL]:  'Town Hall',
  [BuildingType.CHURCH]:     'Church',
  [BuildingType.INN]:        'Inn',
  [BuildingType.BLACKSMITH]: 'Smithy',
  [BuildingType.GRAVEYARD]:  'Graveyard',
  [BuildingType.MILL]:       'Mill',
  [BuildingType.DOCK]:       'Dock',
  [BuildingType.HOUSE]:      'House',
  [BuildingType.BARN]:       'Barn',
  [BuildingType.WATCHTOWER]: 'Watchtower',
  [BuildingType.APOTHECARY]: 'Apothecary',
  [BuildingType.STOREHOUSE]: 'Storehouse',
  [BuildingType.STABLE]:     'Stable',
};

export const RESOURCE_LABEL = {
  [ResourceType.HERBS]:     '🌿 Herbs',
  [ResourceType.SILVER]:    '⚔ Silver',
  [ResourceType.WOOD]:      '🪵 Wood',
  [ResourceType.METAL]:     '⚙ Metal',
  [ResourceType.FOOD]:      '🍞 Food',
  [ResourceType.SCRIPTURE]: '📜 Scripture',
};

// Weighted loot tables per building type.
// type: ResourceType | 'weapon:X' | 'survivor' | 'nothing'
// Weights sum to 100; 'nothing' is intentionally rare.
export const BUILDING_LOOT = {
  [BuildingType.BLACKSMITH]: [
    { type: 'weapon:sword',      weight: 20 },
    { type: 'weapon:axe',        weight: 20 },
    { type: 'weapon:shield',     weight: 15 },
    { type: ResourceType.METAL,  weight: 25 },
    { type: ResourceType.WOOD,   weight: 10 },
    { type: 'nothing',           weight: 10 },
  ],
  [BuildingType.INN]: [
    { type: ResourceType.FOOD,   weight: 30 },
    { type: ResourceType.HERBS,  weight: 25 },
    { type: 'survivor',          weight: 30 },
    { type: 'nothing',           weight: 15 },
  ],
  [BuildingType.CHURCH]: [
    { type: ResourceType.SCRIPTURE, weight: 30 },
    { type: ResourceType.SILVER,    weight: 25 },
    { type: 'weapon:staff',         weight: 25 },
    { type: 'nothing',              weight: 20 },
  ],
  [BuildingType.MILL]: [
    { type: ResourceType.WOOD,  weight: 45 },
    { type: ResourceType.FOOD,  weight: 30 },
    { type: 'survivor',         weight: 15 },
    { type: 'nothing',          weight: 10 },
  ],
  [BuildingType.BARN]: [
    { type: ResourceType.FOOD,  weight: 40 },
    { type: ResourceType.WOOD,  weight: 25 },
    { type: 'survivor',         weight: 25 },
    { type: 'nothing',          weight: 10 },
  ],
  [BuildingType.APOTHECARY]: [
    { type: ResourceType.HERBS, weight: 55 },
    { type: ResourceType.FOOD,  weight: 30 },
    { type: 'nothing',          weight: 15 },
  ],
  [BuildingType.WATCHTOWER]: [
    { type: 'weapon:bow',            weight: 35 },
    { type: ResourceType.SILVER,     weight: 30 },
    { type: 'survivor',              weight: 25 },
    { type: 'nothing',               weight: 10 },
  ],
  [BuildingType.STOREHOUSE]: [
    { type: ResourceType.WOOD,  weight: 35 },
    { type: ResourceType.METAL, weight: 30 },
    { type: ResourceType.FOOD,  weight: 25 },
    { type: 'nothing',          weight: 10 },
  ],
  [BuildingType.STABLE]: [
    { type: ResourceType.FOOD,  weight: 35 },
    { type: ResourceType.WOOD,  weight: 30 },
    { type: 'survivor',         weight: 25 },
    { type: 'nothing',          weight: 10 },
  ],
  [BuildingType.DOCK]: [
    { type: ResourceType.WOOD,  weight: 30 },
    { type: ResourceType.FOOD,  weight: 30 },
    { type: 'survivor',         weight: 25 },
    { type: 'nothing',          weight: 15 },
  ],
  [BuildingType.HOUSE]: [
    { type: ResourceType.FOOD,  weight: 25 },
    { type: ResourceType.HERBS, weight: 20 },
    { type: 'weapon:dagger',    weight: 15 },
    { type: ResourceType.WOOD,  weight: 20 },
    { type: 'survivor',         weight: 15 },
    { type: 'nothing',          weight: 5 },
  ],
  [BuildingType.GRAVEYARD]: [
    { type: ResourceType.SCRIPTURE, weight: 30 },
    { type: ResourceType.HERBS,     weight: 20 },
    { type: 'nothing',               weight: 50 },
  ],
  [BuildingType.TOWN_HALL]: [
    { type: ResourceType.SILVER, weight: 20 },
    { type: ResourceType.WOOD,   weight: 25 },
    { type: ResourceType.FOOD,   weight: 25 },
    { type: 'survivor',          weight: 20 },
    { type: 'nothing',           weight: 10 },
  ],
};

// Roll a loot result from a weighted table using Math.random
export function rollLoot(table) {
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const entry of table) {
    r -= entry.weight;
    if (r <= 0) return entry.type;
  }
  return table[table.length - 1].type;
}

export class Tile {
  constructor(col, row, type = TileType.GRASS) {
    this.col = col;
    this.row = row;
    this.type = type;
    this.building = null;   // BuildingType or null
    this.explored = false;
    this.resource = null;   // ResourceType or null (on open tiles)
    this.fortifyLevel = 0;  // 0=none, 1=wood (+1 def), 2=metal (+2 def)
  }
}
