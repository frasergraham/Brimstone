// Procedural map generator for the Salem hex map
import { MAP_COLS, MAP_ROWS, getNeighbors, hexKey } from './hex.js';
import { Tile, TileType, BuildingType } from './tiles.js';

// Fixed building positions (col, row) for a 13×11 grid
const BUILDING_PLACEMENTS = [
  // Core named buildings
  { col: 6,  row: 5,  building: BuildingType.TOWN_HALL   },
  { col: 6,  row: 1,  building: BuildingType.CHURCH      },
  { col: 10, row: 5,  building: BuildingType.INN         },
  { col: 2,  row: 5,  building: BuildingType.BLACKSMITH  },
  { col: 10, row: 9,  building: BuildingType.GRAVEYARD   },
  { col: 3,  row: 2,  building: BuildingType.MILL        },
  { col: 5,  row: 9,  building: BuildingType.DOCK        },
  // Speciality buildings
  { col: 7,  row: 8,  building: BuildingType.BARN        },
  { col: 1,  row: 7,  building: BuildingType.BARN        },
  { col: 8,  row: 2,  building: BuildingType.WATCHTOWER  },
  { col: 1,  row: 3,  building: BuildingType.APOTHECARY  },
  { col: 11, row: 7,  building: BuildingType.STOREHOUSE  },
  { col: 8,  row: 0,  building: BuildingType.STABLE      },
  // Houses
  { col: 2,  row: 2,  building: BuildingType.HOUSE       },
  { col: 10, row: 2,  building: BuildingType.HOUSE       },
  { col: 9,  row: 7,  building: BuildingType.HOUSE       },
  { col: 4,  row: 7,  building: BuildingType.HOUSE       },
  { col: 11, row: 3,  building: BuildingType.HOUSE       },
  { col: 12, row: 6,  building: BuildingType.HOUSE       },
  { col: 3,  row: 8,  building: BuildingType.HOUSE       },
  { col: 8,  row: 6,  building: BuildingType.HOUSE       },
  { col: 6,  row: 3,  building: BuildingType.HOUSE       },
  { col: 9,  row: 4,  building: BuildingType.HOUSE       },
  { col: 0,  row: 5,  building: BuildingType.HOUSE       },
];

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

// Three strategic locations the witch is trying to dominate
export const WITCH_OBJECTIVES = [
  { col: 8,  row: 1,  label: 'Ancient Altar'    },
  { col: 1,  row: 9,  label: 'Dark Grove'        },
  { col: 11, row: 5,  label: 'Cursed Crossroads' },
];

function rng(seed) {
  // Simple seeded LCG so the map is reproducible per session
  let s = seed | 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) | 0;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

// BFS pathfinding returning array of {col,row} cells between start and end
// Prefers road/grass over river/buildings; used for road placement
function bfsPath(tiles, startCol, startRow, endCol, endRow, rand) {
  const key = (c, r) => `${c},${r}`;
  const start = key(startCol, startRow);
  const end   = key(endCol, endRow);
  if (start === end) return [];

  const prev = new Map([[start, null]]);
  const queue = [{ col: startCol, row: startRow }];

  while (queue.length) {
    // Shuffle neighbors slightly for organic paths
    const { col, row } = queue.shift();
    const k = key(col, row);
    if (k === end) break;

    const neighbors = getNeighbors(col, row).sort(() => rand() - 0.5);
    for (const n of neighbors) {
      const nk = key(n.col, n.row);
      if (prev.has(nk)) continue;
      const tile = tiles.get(nk);
      if (!tile) continue;
      // Allow crossing rivers — they become BRIDGE tiles during road placement
      prev.set(nk, { col, row });
      queue.push(n);
    }
  }

  // Reconstruct path
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

  // 3. Place buildings
  for (const { col, row, building } of BUILDING_PLACEMENTS) {
    const t = tiles.get(hexKey(col, row));
    if (!t) continue;
    t.type = TileType.BUILDING;
    t.building = building;
    // Town Hall and Inn pre-explored; all others are hidden
    t.explored = building === BuildingType.TOWN_HALL ||
                 building === BuildingType.INN;
  }

  // 4. Build roads between buildings and Town Hall (hub-and-spoke + a few extras)
  const hub = BUILDING_PLACEMENTS[0]; // Town Hall
  const roadTargets = BUILDING_PLACEMENTS.slice(1);
  // Also connect some pairs for a ring feel
  const extraPairs = [
    [1, 2], // Church <-> Inn
    [2, 3], // Inn <-> Blacksmith
    [5, 6], // Mill <-> Dock
  ];

  const placeRoad = path => {
    for (const { col, row } of path) {
      const t = tiles.get(hexKey(col, row));
      if (!t) continue;
      if (t.type === TileType.GRASS)  t.type = TileType.ROAD;
      else if (t.type === TileType.RIVER) t.type = TileType.BRIDGE;
      // Leave BUILDING, ROAD, BRIDGE, FOREST tiles unchanged
    }
  };

  for (const target of roadTargets) {
    placeRoad(bfsPath(tiles, hub.col, hub.row, target.col, target.row, rand));
  }
  for (const [i, j] of extraPairs) {
    const a = BUILDING_PLACEMENTS[i], b = BUILDING_PLACEMENTS[j];
    placeRoad(bfsPath(tiles, a.col, a.row, b.col, b.row, rand));
  }

  // 5. Grow forest clusters from seeds
  for (const seed of FOREST_SEEDS) {
    const neighbors = getNeighbors(seed.col, seed.row);
    const candidates = [seed, ...neighbors];
    for (const { col, row } of candidates) {
      const t = tiles.get(hexKey(col, row));
      if (t && t.type === TileType.GRASS && rand() < 0.70) {
        t.type = TileType.FOREST;
        // Second ring, sparser
        for (const n of getNeighbors(col, row)) {
          const t2 = tiles.get(hexKey(n.col, n.row));
          if (t2 && t2.type === TileType.GRASS && rand() < 0.40) {
            t2.type = TileType.FOREST;
          }
        }
      }
    }
  }

  return tiles;
}


// Accessor helpers used by other modules
export function getStartPosition(role) {
  if (role === 'hero') {
    const inn = BUILDING_PLACEMENTS.find(b => b.building === BuildingType.INN);
    return { col: inn.col, row: inn.row };
  }
  const grave = BUILDING_PLACEMENTS.find(b => b.building === BuildingType.GRAVEYARD);
  return { col: grave.col, row: grave.row };
}
