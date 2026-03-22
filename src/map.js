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

// Corner zones — wide enough to stay clear of the river regardless of where it runs
const CORNER_ZONES = [
  { minCol: 0, maxCol: 2,          minRow: 0, maxRow: 3 },               // top-left
  { minCol: MAP_COLS - 3, maxCol: MAP_COLS - 1, minRow: 0, maxRow: 3 },  // top-right
  { minCol: 0, maxCol: 2,          minRow: MAP_ROWS - 4, maxRow: MAP_ROWS - 1 }, // bottom-left
  { minCol: MAP_COLS - 3, maxCol: MAP_COLS - 1, minRow: MAP_ROWS - 4, maxRow: MAP_ROWS - 1 }, // bottom-right
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

// Clustered building placement: buildings tend to group into hamlets of 2–5.
// CLUSTER_CHANCE controls how often a new building tries to settle near an
// existing one; MIN_CLUSTER_DIST prevents adjacent stacking within a cluster;
// MIN_SPREAD_DIST ensures isolated buildings aren't too close to anything.
function _clusteredBuildingPlacements(rand, tiles, reservedKeys = new Set()) {
  const CLUSTER_CHANCE    = 0.65; // probability of trying to cluster near existing
  const CLUSTER_RADIUS    = 3;    // max hexes away to consider "same cluster"
  const MIN_CLUSTER_DIST  = 2;    // min separation within a cluster
  const MIN_SPREAD_DIST   = 4;    // min separation for isolated placement

  const placements = [];
  const usedKeys = new Set(reservedKeys);

  const grassCandidates = () => {
    const out = [];
    for (const [k, t] of tiles) {
      if (t.type !== TileType.GRASS) continue;
      if (usedKeys.has(k)) continue;
      if (t.col < 1 || t.col > MAP_COLS - 2 || t.row < 1 || t.row > MAP_ROWS - 2) continue;
      out.push({ col: t.col, row: t.row });
    }
    return _shuffle(out, rand);
  };

  for (const building of BUILDING_TYPES) {
    const candidates = grassCandidates();

    let placed = false;

    // Try to cluster near an existing building
    if (placements.length > 0 && rand() < CLUSTER_CHANCE) {
      const near = candidates.filter(c =>
        placements.some(p => hexDistance(p.col, p.row, c.col, c.row) <= CLUSTER_RADIUS) &&
        !placements.some(p => hexDistance(p.col, p.row, c.col, c.row) < MIN_CLUSTER_DIST)
      );
      if (near.length > 0) {
        placements.push({ col: near[0].col, row: near[0].row, building });
        usedKeys.add(hexKey(near[0].col, near[0].row));
        placed = true;
      }
    }

    // Fall back to spread placement
    if (!placed) {
      for (const c of candidates) {
        if (!placements.some(p => hexDistance(p.col, p.row, c.col, c.row) < MIN_SPREAD_DIST)) {
          placements.push({ col: c.col, row: c.row, building });
          usedKeys.add(hexKey(c.col, c.row));
          break;
        }
      }
    }
  }
  return placements;
}

// Generate a meandering river path: exactly one tile per row (row 0 → MAP_ROWS-1).
// This guarantees every interior tile has exactly 2 river neighbours (no clusters),
// and the two endpoints each have exactly 1 (so the bezier can extend off-screen).
//
// Hex adjacency in odd-r offset means from an even row you can step to (col, row+1)
// or (col-1, row+1); from an odd row to (col+1, row+1) or (col, row+1).
function _generateRiver(rand) {
  const path = [];
  const startCol = 3 + Math.floor(rand() * 7); // cols 3–9
  let col = startCol;

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

export function generateMap(seed = Date.now()) {
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
  const buildingPlacements = [...cornerPlacements, ..._clusteredBuildingPlacements(rand, tiles, cornerKeys)];
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
      else if (t.type === TileType.RIVER && bridgesPlaced < 4) {
        t.type = TileType.BRIDGE;
        bridgesPlaced++;
      }
    }
  };

  for (const { from, to } of mstEdges) {
    placeRoad(bfsPath(tiles, from.col, from.row, to.col, to.row, rand));
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
