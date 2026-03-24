// Procedural map generator for the Salem hex map
import { MAP_COLS, MAP_ROWS, setMapDimensions, getNeighbors, hexKey, hexDistance } from './hex.js';
import { Tile, TileType, BuildingType } from './tiles.js';

// Flavor labels for the witch power nodes (extra labels for larger maps)
const WITCH_OBJECTIVE_LABELS = [
  'Ancient Altar', 'Dark Grove', 'Cursed Crossroads', 'Forgotten Hollow',
];

// ── Village archetypes ────────────────────────────────────────────────────────
// Each entry defines a thematic cluster of buildings placed together.
// INN and GRAVEYARD are always placed separately in spawn corners.
// Building order matters: the first entry in each list is placed closest to the
// village center, giving key buildings (town hall, church) prime position.
const VILLAGE_TEMPLATES = {
  market:    [BuildingType.TOWN_HALL,  BuildingType.BLACKSMITH, BuildingType.STABLE,
              BuildingType.HOUSE,      BuildingType.HOUSE,      BuildingType.HOUSE],
  parish:    [BuildingType.CHURCH,     BuildingType.APOTHECARY, BuildingType.HOUSE,
              BuildingType.HOUSE,      BuildingType.HOUSE],
  harbor:    [BuildingType.DOCK,       BuildingType.MILL,       BuildingType.STOREHOUSE,
              BuildingType.HOUSE,      BuildingType.HOUSE],
  garrison:  [BuildingType.WATCHTOWER, BuildingType.STOREHOUSE, BuildingType.HOUSE,
              BuildingType.HOUSE],
  farmstead: [BuildingType.BARN,       BuildingType.BARN,       BuildingType.STABLE,
              BuildingType.HOUSE,      BuildingType.HOUSE],
};

// ── Map size presets ─────────────────────────────────────────────────────────
// villages: ordered list of VILLAGE_TEMPLATES keys to generate (shuffled per seed).
//   'market' and 'parish' appear in every size — they hold the gameplay-critical
//   CHURCH, APOTHECARY, TOWN_HALL, BLACKSMITH buildings.
// minVillageDist: minimum hex distance between village centers.
// forestSeeds: starting positions for cluster growth.
// nodeCount: number of witch power-node objectives.
// survivorCounts: { buildings, terrain } — tiles flagged hiddenSurvivor=true.
// bridgeMax: max river-crossing bridges.

export const MAP_SIZES = {
  skirmish: {
    label: 'Skirmish (9×9)',
    cols: 9, rows: 9,
    villages: ['market', 'parish'],
    minVillageDist: 5,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:7,row:1},{col:8,row:0},
      {col:8,row:3},{col:0,row:4},{col:1,row:7},{col:8,row:6},
      {col:4,row:2},{col:5,row:6},
    ],
    nodeCount: 2,
    survivorCounts: { buildings: 9, terrain: 2 },
    bridgeMax: 2,
  },
  standard: {
    label: 'Standard (13×11)',
    cols: 13, rows: 11,
    villages: ['market', 'parish', 'harbor'],
    minVillageDist: 6,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:11,row:1},{col:12,row:0},
      {col:12,row:4},{col:0,row:6},{col:1,row:9},{col:12,row:8},
      {col:7,row:3},{col:8,row:8},{col:0,row:4},{col:6,row:9},
    ],
    nodeCount: 3,
    survivorCounts: { buildings: 13, terrain: 2 },
    bridgeMax: 4,
  },
  regional: {
    label: 'Regional (17×13)',
    cols: 17, rows: 13,
    villages: ['market', 'parish', 'harbor', 'garrison'],
    minVillageDist: 6,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:15,row:1},{col:16,row:0},
      {col:16,row:4},{col:0,row:7},{col:1,row:11},{col:16,row:9},
      {col:9,row:3},{col:10,row:9},{col:0,row:4},{col:7,row:11},
      {col:5,row:1},{col:12,row:6},{col:3,row:6},{col:14,row:11},
    ],
    nodeCount: 3,
    survivorCounts: { buildings: 16, terrain: 4 },
    bridgeMax: 5,
  },
  campaign: {
    label: 'Campaign (21×15)',
    cols: 21, rows: 15,
    villages: ['market', 'parish', 'harbor', 'garrison', 'farmstead'],
    minVillageDist: 7,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:19,row:1},{col:20,row:0},
      {col:20,row:5},{col:0,row:8},{col:1,row:13},{col:20,row:11},
      {col:11,row:3},{col:12,row:11},{col:0,row:5},{col:8,row:13},
      {col:5,row:1},{col:15,row:7},{col:3,row:7},{col:17,row:13},
      {col:8,row:0},{col:14,row:0},{col:0,row:10},{col:20,row:7},
    ],
    nodeCount: 3,
    survivorCounts: { buildings: 20, terrain: 5 },
    bridgeMax: 6,
  },
};

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

// Place INN and GRAVEYARD in opposite corners (TL+BR or TR+BL, randomly assigned).
// Corner zones are computed at call time from the current MAP_COLS/MAP_ROWS.
function _pickCornerBuildings(rand, tiles) {
  const cz = [
    { minCol: 0,           maxCol: 2,           minRow: 0,           maxRow: 3           }, // TL
    { minCol: MAP_COLS-3,  maxCol: MAP_COLS-1,  minRow: 0,           maxRow: 3           }, // TR
    { minCol: 0,           maxCol: 2,           minRow: MAP_ROWS-4,  maxRow: MAP_ROWS-1  }, // BL
    { minCol: MAP_COLS-3,  maxCol: MAP_COLS-1,  minRow: MAP_ROWS-4,  maxRow: MAP_ROWS-1  }, // BR
  ];
  const useTLBR   = rand() < 0.5;
  const [zA, zB]  = useTLBR ? [cz[0], cz[3]] : [cz[1], cz[2]];
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

// Place one village's buildings in a compact cluster around a center hex.
// Buildings are sorted closest-first (with seeded random tiebreaking) and
// placed with MIN_SEP gaps so the result reads as a dense but walkable hamlet.
function _placeVillageBuildings(rand, tiles, centerCol, centerRow, buildings, usedKeys) {
  const RADIUS  = 3; // max hex distance from village center
  const MIN_SEP = 2; // min separation between any two buildings in this village

  const candidates = [];
  for (const [, t] of tiles) {
    if (t.type !== TileType.GRASS) continue;
    const k = hexKey(t.col, t.row);
    if (usedKeys.has(k)) continue;
    const dist = hexDistance(centerCol, centerRow, t.col, t.row);
    if (dist >= 0 && dist <= RADIUS) candidates.push({ col: t.col, row: t.row, dist });
  }
  // Shuffle first so equal-distance tiles are randomly ordered, then stable-sort by distance
  _shuffle(candidates, rand);
  candidates.sort((a, b) => a.dist - b.dist);

  const placed = [];
  for (const building of buildings) {
    for (const c of candidates) {
      const k = hexKey(c.col, c.row);
      if (usedKeys.has(k)) continue;
      if (placed.some(p => hexDistance(p.col, p.row, c.col, c.row) < MIN_SEP)) continue;
      placed.push({ col: c.col, row: c.row, building });
      usedKeys.add(k);
      break;
    }
  }
  return placed;
}

// Pick N well-spread village center positions then fill each from its archetype.
// Village centers are kept minVillageDist apart from each other and from the
// reserved corner buildings (INN / GRAVEYARD).
function _generateVillages(rand, tiles, villageNames, minVillageDist, reservedKeys) {
  const usedKeys = new Set(reservedKeys);
  const reservedPositions = [...reservedKeys].map(k => {
    const [col, row] = k.split(',').map(Number);
    return { col, row };
  });

  // Collect eligible center candidates away from map edges
  const centerCandidates = [];
  for (const [, t] of tiles) {
    if (t.type !== TileType.GRASS) continue;
    if (t.col < 2 || t.col > MAP_COLS - 3 || t.row < 2 || t.row > MAP_ROWS - 3) continue;
    centerCandidates.push({ col: t.col, row: t.row });
  }
  _shuffle(centerCandidates, rand);

  const minToCorner = Math.ceil(minVillageDist * 0.75); // slightly smaller buffer to corners
  const centers = [];
  for (const c of centerCandidates) {
    if (centers.length >= villageNames.length) break;
    const tooClose =
      centers.some(p => hexDistance(p.col, p.row, c.col, c.row) < minVillageDist) ||
      reservedPositions.some(p => hexDistance(p.col, p.row, c.col, c.row) < minToCorner);
    if (!tooClose) centers.push(c);
  }

  // Shuffle template order per seed so village positions vary across seeds
  const shuffledNames = _shuffle([...villageNames], rand);
  const allPlacements = [];
  for (let i = 0; i < centers.length; i++) {
    const name = shuffledNames[i] ?? shuffledNames[0];
    const buildings = VILLAGE_TEMPLATES[name];
    if (!buildings) continue;
    const placed = _placeVillageBuildings(rand, tiles, centers[i].col, centers[i].row, buildings, usedKeys);
    allPlacements.push(...placed);
  }
  return allPlacements;
}

// Generate a meandering river path: exactly one tile per row (row 0 → MAP_ROWS-1).
// This guarantees every interior tile has exactly 2 river neighbours (no clusters),
// and the two endpoints each have exactly 1 (so the bezier can extend off-screen).
//
// Hex adjacency in odd-r offset means from an even row you can step to (col, row+1)
// or (col-1, row+1); from an odd row to (col+1, row+1) or (col, row+1).
function _generateRiver(rand) {
  const path = [];
  // Start in the middle third of the map, clamped to the safe river range
  const minStart = Math.max(2, Math.floor(MAP_COLS / 4));
  const rangeLen  = Math.max(1, Math.floor(MAP_COLS / 2));
  const startCol  = minStart + Math.floor(rand() * rangeLen);
  let col = Math.min(startCol, MAP_COLS - 3);

  for (let row = 0; row < MAP_ROWS; row++) {
    path.push({ col, row });

    if (row < MAP_ROWS - 1) {
      const isEven = row % 2 === 0;
      // Two possible next columns based on offset parity
      const optA = isEven ? col     : col + 1; // "straight"
      const optB = isEven ? col - 1 : col;     // "drift"
      // Clamp both to safe range and pick randomly
      const a = Math.max(2, Math.min(MAP_COLS - 3, optA));
      const b = Math.max(2, Math.min(MAP_COLS - 3, optB));
      col = (rand() < 0.5) ? a : b;
    }
  }

  return path;
}

export function generateMap(seed = Date.now(), mapSize = 'standard') {
  const cfg = MAP_SIZES[mapSize] ?? MAP_SIZES.standard;
  setMapDimensions(cfg.cols, cfg.rows);

  const rand = rng(seed);
  const tiles = new Map();

  // 1. Fill with grass
  for (let row = 0; row < MAP_ROWS; row++) {
    for (let col = 0; col < MAP_COLS; col++) {
      tiles.set(hexKey(col, row), new Tile(col, row, TileType.GRASS));
    }
  }

  // 2. Carve meandering river
  for (const { col, row } of _generateRiver(rand)) {
    const t = tiles.get(hexKey(col, row));
    if (t) t.type = TileType.RIVER;
  }

  // 3. Place INN and GRAVEYARD in opposite corners, then scatter remaining buildings
  const cornerPlacements   = _pickCornerBuildings(rand, tiles);
  const cornerKeys         = new Set(cornerPlacements.map(b => hexKey(b.col, b.row)));
  const buildingPlacements = [
    ...cornerPlacements,
    ..._generateVillages(rand, tiles, cfg.villages, cfg.minVillageDist, cornerKeys),
  ];
  for (const { col, row, building } of buildingPlacements) {
    const t = tiles.get(hexKey(col, row));
    if (!t) continue;
    t.type = TileType.BUILDING;
    t.building = building;
    t.fortifyLevel = 1; // all buildings start with minimal fortification
  }

  // 4. Build a minimum spanning tree of roads connecting all buildings.
  // Kruskal's algorithm on hex-distance edges gives a natural organic network
  // where most buildings have 1–2 connections rather than all roads radiating
  // from a single hub.
  const n = buildingPlacements.length;
  const mstEdges = [];
  if (n > 1) {
    const allEdges = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = hexDistance(
          buildingPlacements[i].col, buildingPlacements[i].row,
          buildingPlacements[j].col, buildingPlacements[j].row,
        );
        allEdges.push({ i, j, d });
      }
    }
    allEdges.sort((a, b) => a.d - b.d);

    const parent = Array.from({ length: n }, (_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

    for (const { i, j } of allEdges) {
      if (find(i) !== find(j)) {
        parent[find(i)] = find(j);
        mstEdges.push({ from: buildingPlacements[i], to: buildingPlacements[j] });
        if (mstEdges.length === n - 1) break;
      }
    }
  }

  let bridgesPlaced = 0;
  const placeRoad = path => {
    for (const { col, row } of path) {
      const t = tiles.get(hexKey(col, row));
      if (!t) continue;
      if (t.type === TileType.GRASS || t.type === TileType.DIRT || t.type === TileType.FOREST) t.type = TileType.ROAD;
      else if (t.type === TileType.RIVER && bridgesPlaced < cfg.bridgeMax) {
        t.type = TileType.BRIDGE;
        bridgesPlaced++;
      }
    }
  };

  for (const { from, to } of mstEdges) {
    placeRoad(bfsPath(tiles, from.col, from.row, to.col, to.row, rand));
  }

  // 5. Grow forest clusters from seeds
  for (const seed of cfg.forestSeeds) {
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

  // 5.5 Scatter small dirt/gravel patches for visual texture
  for (let i = 0; i < 10; i++) {
    const grassTiles = [];
    for (const [, t] of tiles) {
      if (t.type === TileType.GRASS && t.col >= 1 && t.col <= MAP_COLS - 2) grassTiles.push(t);
    }
    _shuffle(grassTiles, rand);
    if (grassTiles.length === 0) break;
    const seedTile = grassTiles[0];
    seedTile.type = TileType.DIRT;
    const spreadNeighbors = _shuffle(
      getNeighbors(seedTile.col, seedTile.row)
        .map(n => tiles.get(hexKey(n.col, n.row)))
        .filter(t => t && t.type === TileType.GRASS),
      rand
    );
    for (const n of spreadNeighbors.slice(0, Math.floor(rand() * 3))) {
      n.type = TileType.DIRT;
    }
  }

  // 6. Place witch objectives — well-spread positions not overlapping buildings
  const buildingKeys = new Set(buildingPlacements.map(b => hexKey(b.col, b.row)));
  const objPositions = _pickSpread(rand, tiles, cfg.nodeCount, 4, buildingKeys);
  // Pad if not enough positions found
  while (objPositions.length < cfg.nodeCount) objPositions.push({ col: 1, row: 1 });
  const witchObjectives = objPositions.map((pos, i) => ({
    col: pos.col, row: pos.row, label: WITCH_OBJECTIVE_LABELS[i] ?? `Power Node ${i + 1}`,
  }));

  // 7. Determine start positions
  const heroStart  = buildingPlacements.find(b => b.building === BuildingType.INN)
                  || buildingPlacements[0];
  const witchStart = buildingPlacements.find(b => b.building === BuildingType.GRAVEYARD)
                  || buildingPlacements[buildingPlacements.length - 1];

  return { tiles, witchObjectives, heroStart, witchStart, mapSize, survivorCounts: cfg.survivorCounts };
}
