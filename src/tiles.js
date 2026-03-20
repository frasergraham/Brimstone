// Tile types, building types, resources, and their visual properties

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
});

export const ResourceType = Object.freeze({
  HERBS:     'herbs',     // Hero: heal 1 HP
  SILVER:    'silver',    // Hero: +1 attack for next battle
  WOOD:      'wood',      // Fortify a building
  FOOD:      'food',      // Gain 1 extra action this turn
  SCRIPTURE: 'scripture', // Ward off a witch unit (push back 1 hex)
});

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
};

export const RESOURCE_LABEL = {
  [ResourceType.HERBS]:     '🌿 Herbs',
  [ResourceType.SILVER]:    '⚔ Silver',
  [ResourceType.WOOD]:      '🪵 Wood',
  [ResourceType.FOOD]:      '🍞 Food',
  [ResourceType.SCRIPTURE]: '📜 Scripture',
};

export class Tile {
  constructor(col, row, type = TileType.GRASS) {
    this.col = col;
    this.row = row;
    this.type = type;
    this.building = null;   // BuildingType or null
    this.explored = false;
    this.resource = null;   // ResourceType or null (hidden until explored)
    this.fortified = false;
  }
}
