// Hand-crafted map data for campaign missions.
// Each builder returns the same shape as generateMap() / generateTutorialMap():
//   { tiles, witchObjectives, heroStart, witchStart, mapSize, survivorCounts, cols, rows }

import { Tile, TileType, BuildingType, ResourceType } from '../tiles.js';
import { hexKey, setMapDimensions } from '../hex.js';
import { NODE_COLORS } from '../map.js';

// ── Helper ──────────────────────────────────────────────────────────────────
function makeTiles(cols, rows) {
  const tiles = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.set(hexKey(col, row), new Tile(col, row, TileType.GRASS));
    }
  }
  return tiles;
}

function setBuilding(tiles, col, row, building, fortLevel = 0) {
  const t = tiles.get(hexKey(col, row));
  if (t) { t.type = TileType.BUILDING; t.building = building; t.fortifyLevel = fortLevel; }
}

function setForest(tiles, hexes) {
  for (const { col, row } of hexes) {
    const t = tiles.get(hexKey(col, row));
    if (t && t.type === TileType.GRASS) t.type = TileType.FOREST;
  }
}

function addRoad(tiles, from, to) {
  const a = tiles.get(hexKey(from.col, from.row));
  const b = tiles.get(hexKey(to.col, to.row));
  if (a) a.roadDirs.add(hexKey(to.col, to.row));
  if (b) b.roadDirs.add(hexKey(from.col, from.row));
}

function setResource(tiles, col, row, resource) {
  const t = tiles.get(hexKey(col, row));
  if (t) t.resource = resource;
}

function setHiddenSurvivor(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  if (t) t.hiddenSurvivor = true;
}

// ═════════════════════════════════════════════════════════════════════════════
// Mission 1: "The Awakening" — small skirmish village
// 9×9 grid. Inn in the south, buildings scattered. No power nodes needed
// (victory is eliminate_all, not node control). One hidden survivor.
// ═════════════════════════════════════════════════════════════════════════════
function buildPrologueMap() {
  const COLS = 9, ROWS = 9;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  // Buildings
  setBuilding(tiles, 2, 7, BuildingType.INN, 1);        // hero start
  setBuilding(tiles, 4, 5, BuildingType.CHURCH, 0);
  setBuilding(tiles, 3, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 6, 4, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 7, 6, BuildingType.BARN, 0);

  // Forest clusters
  setForest(tiles, [
    { col: 0, row: 2 }, { col: 1, row: 2 }, { col: 0, row: 3 },
    { col: 7, row: 1 }, { col: 8, row: 1 }, { col: 8, row: 2 },
  ]);

  // Roads: Inn → Church → House
  addRoad(tiles, { col: 2, row: 7 }, { col: 3, row: 6 });
  addRoad(tiles, { col: 3, row: 6 }, { col: 4, row: 5 });
  addRoad(tiles, { col: 4, row: 5 }, { col: 3, row: 4 });
  addRoad(tiles, { col: 3, row: 4 }, { col: 3, row: 3 });
  addRoad(tiles, { col: 4, row: 5 }, { col: 5, row: 4 });
  addRoad(tiles, { col: 5, row: 4 }, { col: 6, row: 4 });

  // Make road tiles actual roads
  for (const rc of [{ col: 3, row: 6 }, { col: 3, row: 4 }, { col: 5, row: 4 }]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && t.type === TileType.GRASS) t.type = TileType.ROAD;
  }

  // Resources scattered
  setResource(tiles, 1, 5, ResourceType.HERBS);
  setResource(tiles, 5, 3, ResourceType.WOOD);

  // Hidden survivor in the church
  setHiddenSurvivor(tiles, 4, 5);

  // No power nodes for prologue (victory = eliminate all enemies)
  const witchObjectives = [];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 2, row: 7 },
    witchStart:     { col: 7, row: 1 }, // off-screen fallback; witch won't be created
    mapSize:        'skirmish',
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Mission 2: "The First Night" — defend a village through one full cycle
// 13×13 grid. Village in the west, graveyard in the east (spawn source).
// One power node to give positional objectives. Waves spawn from graveyard.
// ═════════════════════════════════════════════════════════════════════════════
function buildFirstNightMap() {
  const COLS = 13, ROWS = 13;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  // Village cluster (west)
  setBuilding(tiles, 2, 8, BuildingType.INN, 1);
  setBuilding(tiles, 3, 6, BuildingType.CHURCH, 1);
  setBuilding(tiles, 1, 6, BuildingType.HOUSE, 0);
  setBuilding(tiles, 4, 7, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 2, 5, BuildingType.APOTHECARY, 0);
  setBuilding(tiles, 5, 9, BuildingType.BARN, 0);

  // Graveyard (east) — wave spawn point
  setBuilding(tiles, 10, 3, BuildingType.GRAVEYARD, 0);

  // Watchtower in the middle
  setBuilding(tiles, 6, 6, BuildingType.WATCHTOWER, 0);

  // Forest
  setForest(tiles, [
    { col: 7, row: 4 }, { col: 8, row: 4 }, { col: 7, row: 5 }, { col: 8, row: 5 },
    { col: 9, row: 5 }, { col: 9, row: 6 },
    { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 },
    { col: 11, row: 10 }, { col: 12, row: 10 }, { col: 12, row: 11 },
  ]);

  // Roads
  addRoad(tiles, { col: 2, row: 8 }, { col: 3, row: 7 });
  addRoad(tiles, { col: 3, row: 7 }, { col: 3, row: 6 });
  addRoad(tiles, { col: 3, row: 7 }, { col: 4, row: 7 });
  addRoad(tiles, { col: 3, row: 6 }, { col: 4, row: 6 });
  addRoad(tiles, { col: 4, row: 6 }, { col: 5, row: 6 });
  addRoad(tiles, { col: 5, row: 6 }, { col: 6, row: 6 });
  for (const rc of [{ col: 3, row: 7 }, { col: 4, row: 6 }, { col: 5, row: 6 }]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && t.type === TileType.GRASS) t.type = TileType.ROAD;
  }

  // Resources
  setResource(tiles, 5, 8, ResourceType.WOOD);
  setResource(tiles, 1, 7, ResourceType.HERBS);
  setResource(tiles, 8, 7, ResourceType.FOOD);

  // Hidden survivor in the watchtower
  setHiddenSurvivor(tiles, 6, 6);

  // One power node — village center area
  const witchObjectives = [
    {
      col: 4, row: 7,
      label: 'Village Square',
      hexes: [{ col: 4, row: 7 }, { col: 3, row: 7 }, { col: 5, row: 7 }],
      color: NODE_COLORS[0],
      seenByHero: true,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 2, row: 8 },
    witchStart:     { col: 10, row: 3 }, // graveyard area; witch won't be created
    mapSize:        'standard',
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Mission 3: "The Witch's Trail" — first witch encounter
// 13×13 grid. Forest-heavy with a clearing containing 2 power nodes.
// Witch starts in the northeast near the graveyard.
// ═════════════════════════════════════════════════════════════════════════════
function buildWitchsTrailMap() {
  const COLS = 13, ROWS = 13;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  // Hero village (southwest)
  setBuilding(tiles, 1, 10, BuildingType.INN, 1);
  setBuilding(tiles, 2, 9, BuildingType.HOUSE, 0);
  setBuilding(tiles, 3, 10, BuildingType.STABLE, 0);

  // Witch territory (northeast)
  setBuilding(tiles, 10, 2, BuildingType.GRAVEYARD, 1);
  setBuilding(tiles, 11, 3, BuildingType.HOUSE, 0);

  // Mid-map structures
  setBuilding(tiles, 6, 6, BuildingType.CHURCH, 0);
  setBuilding(tiles, 5, 4, BuildingType.WATCHTOWER, 0);
  setBuilding(tiles, 8, 8, BuildingType.BLACKSMITH, 0);

  // Heavy forest — the witch's trail
  setForest(tiles, [
    { col: 3, row: 7 }, { col: 4, row: 7 }, { col: 4, row: 6 },
    { col: 5, row: 6 }, { col: 5, row: 5 },
    { col: 7, row: 4 }, { col: 8, row: 4 }, { col: 8, row: 3 }, { col: 9, row: 3 },
    { col: 3, row: 8 }, { col: 2, row: 7 },
    { col: 9, row: 7 }, { col: 10, row: 7 }, { col: 10, row: 6 },
    { col: 7, row: 9 }, { col: 8, row: 9 },
  ]);

  // Roads from village through forest to mid-map
  addRoad(tiles, { col: 1, row: 10 }, { col: 2, row: 9 });
  addRoad(tiles, { col: 2, row: 9 }, { col: 3, row: 9 });
  addRoad(tiles, { col: 3, row: 9 }, { col: 4, row: 8 });
  addRoad(tiles, { col: 4, row: 8 }, { col: 5, row: 7 });
  addRoad(tiles, { col: 5, row: 7 }, { col: 6, row: 6 });
  for (const rc of [{ col: 3, row: 9 }, { col: 4, row: 8 }, { col: 5, row: 7 }]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && t.type === TileType.GRASS) t.type = TileType.ROAD;
  }

  // Resources
  setResource(tiles, 2, 8, ResourceType.WOOD);
  setResource(tiles, 7, 5, ResourceType.METAL);
  setResource(tiles, 9, 9, ResourceType.HERBS);
  setResource(tiles, 4, 3, ResourceType.SILVER);

  // Hidden survivor
  setHiddenSurvivor(tiles, 6, 6);

  // Two power nodes
  const witchObjectives = [
    {
      col: 5, row: 5,
      label: 'Forest Shrine',
      hexes: [{ col: 5, row: 5 }, { col: 6, row: 5 }, { col: 5, row: 4 }],
      color: NODE_COLORS[0],
      seenByHero: false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
    {
      col: 9, row: 6,
      label: 'Dark Hollow',
      hexes: [{ col: 9, row: 6 }, { col: 8, row: 6 }, { col: 9, row: 5 }],
      color: NODE_COLORS[1],
      seenByHero: false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 1, row: 10 },
    witchStart:     { col: 10, row: 2 },
    mapSize:        'standard',
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

// ── Registry ────────────────────────────────────────────────────────────────
export const MISSION_MAP_BUILDERS = {
  prologue:     buildPrologueMap,
  first_night:  buildFirstNightMap,
  witchs_trail: buildWitchsTrailMap,
};
