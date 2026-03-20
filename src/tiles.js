// Tile types, building types, resources, weapons, and their visual properties
import { LOOT_CONFIG } from './loot.config.js';

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
  [BuildingType.TOWN_HALL]:  '#b89a18',  // civic gold
  [BuildingType.CHURCH]:     '#b0b0c8',  // pale stone
  [BuildingType.INN]:        '#c07840',  // warm amber
  [BuildingType.BLACKSMITH]: '#787878',  // iron grey
  [BuildingType.GRAVEYARD]:  '#606070',  // dark slate
  [BuildingType.MILL]:       '#a87830',  // golden brown
  [BuildingType.DOCK]:       '#2e7898',  // harbour blue
  [BuildingType.HOUSE]:      '#a86848',  // brick red
  [BuildingType.BARN]:       '#b88040',  // hay gold
  [BuildingType.WATCHTOWER]: '#8888a8',  // tower grey-blue
  [BuildingType.APOTHECARY]: '#6aaa58',  // herbal green
  [BuildingType.STOREHOUSE]: '#9a8068',  // dusty brown
  [BuildingType.STABLE]:     '#c09860',  // sandy tan
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
  'horse':                  '🐴 Horse',
};

// Loot tables — sourced from loot.config.js (edit that file to tune rates).
// BUILDING_LOOT is keyed by BuildingType string (e.g. 'inn', 'blacksmith').
// TERRAIN_LOOT  is keyed by TileType  string (e.g. 'grass', 'forest', 'road').
export const BUILDING_LOOT = LOOT_CONFIG.buildings;
export const TERRAIN_LOOT  = LOOT_CONFIG.terrain;

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
