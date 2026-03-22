// Procedural map generator for the Salem hex map
import { MAP_COLS, MAP_ROWS, getNeighbors, hexKey, hexDistance } from './hex.js';
import { Tile, TileType, BuildingType } from './tiles.js';

// Building types to scatter across the map each game
// INN and GRAVEYARD are excluded — they are placed in opposite corners by _pickCornerBuildings
const BUILDING_TYPES = [
  BuildingType.TOWN_HALL,
  BuildingType.CHURCH,
  BuildingType.BLACKSMITH,
  BuildingType.MILL,
  BuildingType.DOCK,
  BuildingType.BARN, BuildingType.BARN,
  BuildingType.WATCHTOWER,
  BuildingType.APOTHECARY,
  BuildingType.STOREHOUSE,
  BuildingType.STABLE,
  BuildingType.HOUSE, BuildingType.HOUSE, BuildingType.HOUSE,
  BuildingType.HOUSE, BuildingType.HOUSE, BuildingType.HOUSE,
  BuildingType.HOUSE, BuildingType.HOUSE, BuildingType.HOUSE,
  BuildingType.HOUSE, BuildingType.HOUSE,
];

// Flavor labels for the three witch power nodes
const WITCH_OBJECTIVE_LABELS = ['Ancient Altar', 'Dark Grove', 'Cursed Crossroads'];

// River meanders roughly down the left-center of the map
const RIVER_PATH = [
  {col:4,row:0},{col:4,row:1},{col:4,row:2},
  {col:3,row:3},{col:3,row:4},{col:4,row:5},
  {col:4,row:6},{col:4,row:7},{col:5,row:8},
  {col:5,row:9},{col:5,row:10},
];

// Forest seed positions; clusters grown from each
const FOREST_SEEDS = [
  {col:0,row:0},{col:1,row:1},{col:11,row:1},{col:12,row:0},
  {col:12,row:4},{col:0,row:6},{col:1,row:9},{col:12,row:8},
  {col:7,row:3},{col:8,row:8},{col:0,row:4},{col:6,row:9},
];

function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) | 0;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

function _shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// BFS pathfinding returning array of {col,row} cells between start and end
function bfsPath(tiles, startCol, startRow, endCol, endRow, rand) {
  const key = (c, r) => `${c},${r}`;
  const start = key(startCol, startRow);
  const end   = key(endCol, endRow);
  if (start === end) return [];

  const prev = new Map([[start, null]]);
  const queue = [{ col: startCol, row: startRow }];

  while (queue.length) {
    const { col, row } = queue.shift();
    const k = key(col, row);
    if (k === end) break;

    const neighbors = getNeighbors(col, row).sort(() => rand() - 0.5);
    for (const n of neighbors) {
      const nk = key(n.col, n.row);
      if (prev.has(nk)) continue;
      const tile = tiles.get(nk);
      if (!tile) continue;
      prev.set(nk, { col, row });
      queue.push(n);
    }
  }

  const path = [];
  let cur = key(endCol, endRow);
  while (cur && prev.get(cur) !== null) {
    const p = prev.get(cur);
    if (!p) break;
    path.unshift({ col: p.col, row: p.row });
    cur = key(p.col, p.row);
  }
  path.push({ col: endCol, row: endRow });
  return path;
}

// Pick N positions from available grass tiles with a minimum hex-distance between them.
// Avoids forbidden keys and a 1-tile border around the map.
function _pickSpread(rand, tiles, count, minDist, forbiddenKeys = new Set()) {
  const candidates = [];
  for (const [k, t] of tiles) {
    if (t.type !== TileType.GRASS) continue;
    if (forbiddenKeys.has(k)) continue;
    if (t.col < 1 || t.col > MAP_COLS - 2 || t.row < 1 || t.row > MAP_ROWS - 2) continue;
    candidates.push({ col: t.col, row: t.row });
  }
  _shuffle(candidates, rand);

  const placed = [];
  for (const c of candidates) {
    if (placed.length >= count) break;
    const tooClose = placed.some(p => hexDistance(p.col, p.row, c.col, c.row) < minDist);
    if (!tooClose) placed.push(c);
  }
  return placed;
}

// Corner zones: [topLeft, topRight, bottomLeft, bottomRight]
// River runs ~col 3-5, so left corners use cols 1-2 to stay clear of it
const CORNER_ZONES = [
  { minCol: 1, maxCol: 2, minRow: 1, maxRow: 3 },              // top-left
  { minCol: MAP_COLS - 4, maxCol: MAP_COLS - 2, minRow: 1, maxRow: 3 },  // top-right
  { minCol: 1, maxCol: 2, minRow: MAP_ROWS - 4, maxRow: MAP_ROWS - 2 }, // bottom-left
  { minCol: MAP_COLS - 4, maxCol: MAP_COLS - 2, minRow: MAP_ROWS - 4, maxRow: MAP_ROWS - 2 }, // bottom-right
];

// Place INN and GRAVEYARD in opposite corners (TL+BR or TR+BL, randomly assigned).
function _pickCornerBuildings(rand, tiles) {
  const useTLBR   = rand() < 0.5;
  const [zA, zB]  = useTLBR ? [CORNER_ZONES[0], CORNER_ZONES[3]] : [CORNER_ZONES[1], CORNER_ZONES[2]];
  const innZone   = rand() < 0.5 ? zA : zB;
  const gravZone  = innZone === zA ? zB : zA;

  const pickFrom = zone => {
    const cs = [];
    for (const [, t] of tiles) {
      if (t.type !== TileType.GRASS) continue;
      if (t.col < zone.minCol || t.col > zone.maxCol) continue;
      if (t.row < zone.minRow || t.row > zone.maxRow) continue;
      cs.push(t);
    }
    _shuffle(cs, rand);
    return cs[0] || null;
  };

  const inn  = pickFrom(innZone);
  const grav = pickFrom(gravZone);
  const result = [];
  if (inn)  result.push({ col: inn.col,  row: inn.row,  building: BuildingType.INN });
  if (grav) result.push({ col: grav.col, row: grav.row, building: BuildingType.GRAVEYARD });
  return result;
}

// Randomly scatter buildings with a minimum separation heuristic.
function _randomBuildingPlacements(rand, tiles, reservedKeys = new Set()) {
  const MIN_DIST = 2; // minimum hexes between any two buildings
  const placements = [];
  const usedKeys = new Set(reservedKeys);

  for (const building of BUILDING_TYPES) {
    const candidates = [];
    for (const [k, t] of tiles) {
      if (t.type !== TileType.GRASS) continue;
      if (usedKeys.has(k)) continue;
      if (t.col < 1 || t.col > MAP_COLS - 2 || t.row < 1 || t.row > MAP_ROWS - 2) continue;
      candidates.push({ col: t.col, row: t.row });
    }
    _shuffle(candidates, rand);

    for (const c of candidates) {
      const tooClose = placements.some(p => hexDistance(p.col, p.row, c.col, c.row) < MIN_DIST);
      if (!tooClose) {
        placements.push({ col: c.col, row: c.row, building });
        usedKeys.add(hexKey(c.col, c.row));
        break;
      }
    }
  }
  return placements;
}

export function generateMap(seed = Date.now()) {
  const rand = rng(seed);
  const tiles = new Map();

  // 1. Fill with grass
  for (let row = 0; row < MAP_ROWS; row++) {
    for (let col = 0; col < MAP_COLS; col++) {
      tiles.set(hexKey(col, row), new Tile(col, row, TileType.GRASS));
    }
  }

  // 2. Carve river
  for (const { col, row } of RIVER_PATH) {
    const t = tiles.get(hexKey(col, row));
    if (t) t.type = TileType.RIVER;
  }

  // 3. Place INN and GRAVEYARD in opposite corners, then scatter remaining buildings
  const cornerPlacements   = _pickCornerBuildings(rand, tiles);
  const cornerKeys         = new Set(cornerPlacements.map(b => hexKey(b.col, b.row)));
  const buildingPlacements = [...cornerPlacements, ..._randomBuildingPlacements(rand, tiles, cornerKeys)];
  for (const { col, row, building } of buildingPlacements) {
    const t = tiles.get(hexKey(col, row));
    if (!t) continue;
    t.type = TileType.BUILDING;
    t.building = building;
    // No tiles are pre-explored — player must discover everything
  }

  // 4. Build roads between buildings and Town Hall (hub-and-spoke)
  const hub = buildingPlacements.find(b => b.building === BuildingType.TOWN_HALL)
           || buildingPlacements[0];
  const roadTargets = buildingPlacements.filter(b => b !== hub);

  let bridgesPlaced = 0;
  const placeRoad = path => {
    for (const { col, row } of path) {
      const t = tiles.get(hexKey(col, row));
      if (!t) continue;
      if (t.type === TileType.GRASS)  t.type = TileType.ROAD;
      else if (t.type === TileType.RIVER && bridgesPlaced < 2) {
        t.type = TileType.BRIDGE;
        bridgesPlaced++;
      }
    }
  };

  for (const target of roadTargets) {
    placeRoad(bfsPath(tiles, hub.col, hub.row, target.col, target.row, rand));
  }

  // 5. Grow forest clusters from seeds
  for (const seed of FOREST_SEEDS) {
    const neighbors = getNeighbors(seed.col, seed.row);
    const candidates = [seed, ...neighbors];
    for (const { col, row } of candidates) {
      const t = tiles.get(hexKey(col, row));
      if (t && t.type === TileType.GRASS && rand() < 0.70) {
        t.type = TileType.FOREST;
        for (const n of getNeighbors(col, row)) {
          const t2 = tiles.get(hexKey(n.col, n.row));
          if (t2 && t2.type === TileType.GRASS && rand() < 0.40) {
            t2.type = TileType.FOREST;
          }
        }
      }
    }
  }

  // 6. Place witch objectives — 3 well-spread positions not overlapping buildings
  const buildingKeys = new Set(buildingPlacements.map(b => hexKey(b.col, b.row)));
  const objPositions = _pickSpread(rand, tiles, 3, 4, buildingKeys);
  // Pad if not enough positions found
  while (objPositions.length < 3) objPositions.push({ col: 1, row: 1 });
  const witchObjectives = objPositions.map((pos, i) => ({
    col: pos.col, row: pos.row, label: WITCH_OBJECTIVE_LABELS[i],
  }));

  // 7. Determine start positions
  const heroStart  = buildingPlacements.find(b => b.building === BuildingType.INN)
                  || buildingPlacements[0];
  const witchStart = buildingPlacements.find(b => b.building === BuildingType.GRAVEYARD)
                  || buildingPlacements[buildingPlacements.length - 1];

  return { tiles, witchObjectives, heroStart, witchStart };
}
