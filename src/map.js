// Procedural map generator for the Caleb's Hollow hex map
import { MAP_COLS, MAP_ROWS, setMapDimensions, getNeighbors, hexKey, hexDistance } from './hex.js';
import { Tile, TileType, BuildingType } from './tiles.js';

// Flavor labels for the witch power nodes (extra labels for larger maps)
const WITCH_OBJECTIVE_LABELS = [
  'Ancient Altar', 'Dark Grove', 'Cursed Crossroads', 'Forgotten Hollow',
  'Witches\' Mound', 'Blighted Fen', 'Shadow Cairn',
];

// Distinct colors for each power node index — used in renderer and score tracker.
// Chosen to be visually distinct from hero blue (#4488ff) and witch red (#cc3333).
export const NODE_COLORS = [
  '#22c55e', // emerald green
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#a855f7', // violet
  '#ec4899', // pink
  '#84cc16', // lime
  '#f97316', // orange
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
// nodeCount: default number of witch power-node objectives.
// nodeCountMin / nodeCountMax: allowed range for configurable node count.
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
    nodeCount: 1, nodeCountMin: 1, nodeCountMax: 3,
    survivorCounts: { buildings: 4, terrain: 1 },
    bridgeMax: 2,
    minBridges: 1,
  },
  standard: {
    label: 'Standard (13×13)',
    cols: 13, rows: 13,
    villages: ['market', 'parish', 'harbor'],
    minVillageDist: 6,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:11,row:1},{col:12,row:0},
      {col:12,row:4},{col:0,row:6},{col:1,row:9},{col:12,row:8},
      {col:7,row:3},{col:8,row:8},{col:0,row:4},{col:6,row:9},
      {col:3,row:11},{col:10,row:12},{col:6,row:12},
    ],
    nodeCount: 3, nodeCountMin: 2, nodeCountMax: 5,
    survivorCounts: { buildings: 7, terrain: 1 },
    bridgeMax: 4,
    minBridges: 2,
  },
  regional: {
    label: 'Regional (17×17)',
    cols: 17, rows: 17,
    villages: ['market', 'parish', 'harbor', 'garrison'],
    minVillageDist: 6,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:15,row:1},{col:16,row:0},
      {col:16,row:4},{col:0,row:7},{col:1,row:11},{col:16,row:9},
      {col:9,row:3},{col:10,row:9},{col:0,row:4},{col:7,row:11},
      {col:5,row:1},{col:12,row:6},{col:3,row:6},{col:14,row:11},
      {col:2,row:13},{col:14,row:14},{col:8,row:15},{col:1,row:16},{col:15,row:16},
    ],
    nodeCount: 3, nodeCountMin: 2, nodeCountMax: 6,
    survivorCounts: { buildings: 10, terrain: 2 },
    bridgeMax: 5,
    minBridges: 2,
  },
  campaign: {
    label: 'Campaign (21×21)',
    cols: 21, rows: 21,
    villages: ['market', 'parish', 'harbor', 'garrison', 'farmstead'],
    minVillageDist: 7,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:19,row:1},{col:20,row:0},
      {col:20,row:5},{col:0,row:8},{col:1,row:13},{col:20,row:11},
      {col:11,row:3},{col:12,row:11},{col:0,row:5},{col:8,row:13},
      {col:5,row:1},{col:15,row:7},{col:3,row:7},{col:17,row:13},
      {col:8,row:0},{col:14,row:0},{col:0,row:10},{col:20,row:7},
      {col:3,row:15},{col:17,row:16},{col:10,row:17},{col:5,row:18},
      {col:14,row:19},{col:0,row:20},{col:20,row:20},{col:10,row:20},
    ],
    nodeCount: 3, nodeCountMin: 2, nodeCountMax: 7,
    survivorCounts: { buildings: 13, terrain: 3 },
    bridgeMax: 6,
    minBridges: 3,
  },
  /** 2x Campaign — used exclusively for The Battle for Caleb's Hollow. */
  battle: {
    label: 'Battle (42×42)',
    cols: 42, rows: 42,
    villages: ['market', 'parish', 'harbor', 'garrison', 'farmstead',
               'market', 'parish', 'harbor', 'garrison', 'farmstead'],
    minVillageDist: 8,
    forestSeeds: [
      // Corners
      {col:0,row:0},{col:1,row:2},{col:40,row:1},{col:41,row:0},
      {col:41,row:10},{col:0,row:16},{col:1,row:26},{col:41,row:22},
      // Mid edges
      {col:0,row:8},{col:41,row:5},{col:0,row:34},{col:41,row:38},
      {col:20,row:0},{col:20,row:41},{col:10,row:41},{col:32,row:41},
      // Interior scatter
      {col:10,row:6},{col:22,row:6},{col:34,row:8},{col:8,row:14},
      {col:28,row:12},{col:14,row:20},{col:30,row:18},{col:6,row:28},
      {col:20,row:22},{col:36,row:26},{col:12,row:34},{col:26,row:32},
      {col:18,row:38},{col:34,row:36},{col:4,row:40},{col:38,row:40},
      {col:16,row:10},{col:26,row:16},{col:8,row:22},{col:34,row:30},
      {col:2,row:38},{col:40,row:34},{col:22,row:28},{col:10,row:18},
      {col:30,row:6},{col:14,row:14},{col:38,row:16},{col:4,row:20},
      {col:24,row:38},{col:36,row:10},{col:6,row:10},{col:32,row:22},
    ],
    nodeCount: 5, nodeCountMin: 3, nodeCountMax: 7,
    survivorCounts: { buildings: 28, terrain: 8 },
    bridgeMax: 10,
    minBridges: 5,
  },
};

export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) | 0;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

export function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// BFS pathfinding returning array of {col,row} cells between start and end
// Dijkstra road-path finder.  Tiles whose road-neighbour count already
// reaches MAX_ROAD_DEG are penalised so subsequent roads route around them
// rather than piling through the same hub.
const MAX_ROAD_DEG = 3;
const ROAD_DEG_PENALTY = 10; // extra cost per degree above the cap

export function bfsPath(tiles, startCol, startRow, endCol, endRow, rand, roadTiles = new Set(), blockRiver = false) {
  const key = (c, r) => `${c},${r}`;
  const start = key(startCol, startRow);
  const end   = key(endCol, endRow);
  if (start === end) return [];

  const roadDeg = (col, row) => {
    let n = 0;
    for (const nb of getNeighbors(col, row)) if (roadTiles.has(key(nb.col, nb.row))) n++;
    return n;
  };

  const dist = new Map([[start, 0]]);
  const prev = new Map([[start, null]]);
  // Simple sorted array as priority queue — grid is tiny (≤143 tiles)
  const queue = [{ col: startCol, row: startRow, cost: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const { col, row, cost } = queue.shift();
    const k = key(col, row);
    if (k === end) break;
    if (cost > (dist.get(k) ?? Infinity)) continue;

    for (const n of getNeighbors(col, row).sort(() => rand() - 0.5)) {
      const nk = key(n.col, n.row);
      const nTile = tiles.get(nk);
      if (!nTile) continue;
      if (blockRiver && nTile.type === TileType.RIVER) continue;
      const deg = roadDeg(n.col, n.row);
      const step = 1 + Math.max(0, deg - (MAX_ROAD_DEG - 1)) * ROAD_DEG_PENALTY;
      const nc = cost + step;
      if (nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        prev.set(nk, { col, row });
        queue.push({ col: n.col, row: n.row, cost: nc });
      }
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
  shuffle(candidates, rand);

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

  const hasRiverNeighbor = (col, row) =>
    getNeighbors(col, row).some(n => tiles.get(hexKey(n.col, n.row))?.type === TileType.RIVER);

  const pickFrom = zone => {
    const cs = [];
    for (const [, t] of tiles) {
      if (t.type !== TileType.GRASS) continue;
      if (t.col < zone.minCol || t.col > zone.maxCol) continue;
      if (t.row < zone.minRow || t.row > zone.maxRow) continue;
      if (hasRiverNeighbor(t.col, t.row)) continue;
      cs.push(t);
    }
    shuffle(cs, rand);
    return cs[0] || null;
  };

  const inn  = pickFrom(innZone);
  const grav = pickFrom(gravZone);
  const result = [];
  if (inn)  result.push({ col: inn.col,  row: inn.row,  building: BuildingType.INN });
  if (grav) result.push({ col: grav.col, row: grav.row, building: BuildingType.GRAVEYARD });
  return result;
}

// Build a lookup map from the generated river path (captured before tiles are mutated).
// N-S river: row→col map.  E-W river: col→row map.
// E-W rivers may have vertical detour tiles (two tiles in one column); the last row
// per column wins, which is the exit position — correct for riverSide().
export function buildRiverMap(riverPath, riverEW = false) {
  const m = new Map();
  if (riverEW) {
    for (const { col, row } of riverPath) m.set(col, row);
  } else {
    for (const { col, row } of riverPath) m.set(row, col);
  }
  return m;
}

// Which side of the river is a hex on?
// N-S river: 'left' (west) or 'right' (east).
// E-W river: 'left' (north/top) or 'right' (south/bottom).
// Hexes at the exact river position are treated as 'right' (consistent tiebreak).
export function riverSide(col, row, riverMap, riverEW = false) {
  if (riverEW) {
    const rr = riverMap.get(col);
    return (rr === undefined || row < rr) ? 'left' : 'right';
  }
  const rc = riverMap.get(row);
  return (rc === undefined || col < rc) ? 'left' : 'right';
}

// Like _pickSpread but guarantees at least one node on each side of the river
// when count >= 2 and both sides have valid candidates.
// startPositions: array of {col,row} — no node center may be within 3 hexes of these.
function _pickNodesAcrossRiver(rand, tiles, count, minDist, forbiddenKeys, riverMap, riverEW = false, startPositions = [], nodeColRange = null) {
  const colMin = nodeColRange?.min ?? 1;
  const colMax = nodeColRange?.max ?? (MAP_COLS - 2);
  const left = [], right = [];
  for (const [k, t] of tiles) {
    if (t.type === TileType.RIVER || t.type === TileType.BRIDGE || t.type === TileType.BUILDING) continue;
    if (forbiddenKeys.has(k)) continue;
    if (t.col < colMin || t.col > colMax || t.row < 1 || t.row > MAP_ROWS - 2) continue;
    if (startPositions.some(sp => hexDistance(sp.col, sp.row, t.col, t.row) <= 3)) continue;
    (riverSide(t.col, t.row, riverMap, riverEW) === 'left' ? left : right).push({ col: t.col, row: t.row });
  }
  shuffle(left, rand);
  shuffle(right, rand);

  const placed = [];
  const ok = c => !placed.some(p => hexDistance(p.col, p.row, c.col, c.row) < minDist);

  if (count >= 2 && left.length > 0 && right.length > 0) {
    const l = left.find(ok);  if (l) placed.push(l);
    const r = right.find(ok); if (r) placed.push(r);
  }

  const rest = shuffle([...left, ...right], rand);
  for (const c of rest) {
    if (placed.length >= count) break;
    if (!placed.some(p => p.col === c.col && p.row === c.row) && ok(c)) placed.push(c);
  }

  return placed;
}

// Pick 2 satellite hexes adjacent to center to form a 3-hex cluster.
// Prefers a "triangle" (two neighbors that are also adjacent to each other).
// startPositions: no satellite may be within 3 hexes of these.
function _pickNodeCluster(rand, tiles, center, forbiddenKeys, startPositions = []) {
  const neighbors = shuffle(
    getNeighbors(center.col, center.row).filter(n => {
      const t = tiles.get(hexKey(n.col, n.row));
      if (!t || t.type === TileType.RIVER) return false;
      if (forbiddenKeys.has(hexKey(n.col, n.row))) return false;
      if (startPositions.some(sp => hexDistance(sp.col, sp.row, n.col, n.row) <= 3)) return false;
      return true;
    }),
    rand
  );

  // Pick two neighbors that are adjacent to each other (triangle, not a line).
  // On a hex grid, consecutive neighbors always form a triangle with the center.
  for (let i = 0; i < neighbors.length; i++) {
    for (let j = i + 1; j < neighbors.length; j++) {
      if (hexDistance(neighbors[i].col, neighbors[i].row, neighbors[j].col, neighbors[j].row) === 1) {
        return [{ col: center.col, row: center.row }, neighbors[i], neighbors[j]];
      }
    }
  }
  // Fallback: expand search to distance-2 neighbors to find a triangle partner
  if (neighbors.length >= 1) {
    const n0 = neighbors[0];
    const ring2 = getNeighbors(n0.col, n0.row).filter(n2 => {
      if (n2.col === center.col && n2.row === center.row) return false;
      const t = tiles.get(hexKey(n2.col, n2.row));
      if (!t || t.type === TileType.RIVER) return false;
      if (forbiddenKeys.has(hexKey(n2.col, n2.row))) return false;
      return hexDistance(center.col, center.row, n2.col, n2.row) === 1;
    });
    if (ring2.length > 0) return [{ col: center.col, row: center.row }, n0, ring2[0]];
  }
  // Last resort: any two valid neighbors (may be a line, but very rare)
  if (neighbors.length >= 2) return [{ col: center.col, row: center.row }, neighbors[0], neighbors[1]];
  if (neighbors.length === 1) return [{ col: center.col, row: center.row }, neighbors[0], { col: center.col, row: center.row }];
  return [{ col: center.col, row: center.row }, { col: center.col, row: center.row }, { col: center.col, row: center.row }];
}

// Pick river tiles suitable as bridge crossings — tiles with passable land on both
// sides of the river.  Returns up to `maxCount` positions, well-spaced along the
// river, preferring tiles close to key settlement points.
function _pickRiverCrossings(rand, tiles, riverPath, riverMap, riverEW, keyPoints, minCount, maxCount) {
  const candidates = [];
  for (let idx = 0; idx < riverPath.length; idx++) {
    const { col, row } = riverPath[idx];
    const neighbors = getNeighbors(col, row);
    const leftNbrs = neighbors.filter(n => {
      const t = tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER && riverSide(n.col, n.row, riverMap, riverEW) === 'left';
    });
    const rightNbrs = neighbors.filter(n => {
      const t = tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER && riverSide(n.col, n.row, riverMap, riverEW) === 'right';
    });
    if (leftNbrs.length === 0 || rightNbrs.length === 0) continue;

    const minKeyDist = keyPoints.length > 0
      ? Math.min(...keyPoints.map(kp => hexDistance(kp.col, kp.row, col, row)))
      : 0;
    candidates.push({ col, row, idx, score: minKeyDist });
  }

  // Sort by proximity to key points (closest first), random tiebreak
  shuffle(candidates, rand);
  candidates.sort((a, b) => a.score - b.score);

  // Greedily pick well-spaced crossings along the river path
  const minSpacing = Math.max(3, Math.floor(riverPath.length / (maxCount + 1)));
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= maxCount) break;
    if (picked.some(p => Math.abs(p.idx - c.idx) < minSpacing)) continue;
    picked.push(c);
  }

  // Relax spacing to reach minCount if needed
  if (picked.length < minCount) {
    for (const c of candidates) {
      if (picked.length >= minCount) break;
      if (picked.some(p => p.col === c.col && p.row === c.row)) continue;
      if (picked.some(p => Math.abs(p.idx - c.idx) < 2)) continue;
      picked.push(c);
    }
  }

  return picked;
}

// Place one village's buildings in a compact cluster around a center hex.
// Buildings are sorted closest-first (with seeded random tiebreaking) and
// placed with MIN_SEP gaps so the result reads as a dense but walkable hamlet.
function _placeVillageBuildings(rand, tiles, centerCol, centerRow, buildings, usedKeys) {
  const RADIUS  = 4; // max hex distance from village center
  const MIN_SEP = 3; // min separation between any two buildings in this village

  const hasRiverNeighbor = (col, row) =>
    getNeighbors(col, row).some(n => tiles.get(hexKey(n.col, n.row))?.type === TileType.RIVER);

  const candidates = [];
  for (const [, t] of tiles) {
    if (t.type !== TileType.GRASS) continue;
    const k = hexKey(t.col, t.row);
    if (usedKeys.has(k)) continue;
    if (hasRiverNeighbor(t.col, t.row)) continue;
    const dist = hexDistance(centerCol, centerRow, t.col, t.row);
    if (dist >= 0 && dist <= RADIUS) candidates.push({ col: t.col, row: t.row, dist });
  }
  // Shuffle first so equal-distance tiles are randomly ordered, then stable-sort by distance
  shuffle(candidates, rand);
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
  shuffle(centerCandidates, rand);

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
  const shuffledNames = shuffle([...villageNames], rand);
  const allPlacements = [];
  const villageGroups = []; // [{ root, members }] — used for two-tier road building
  for (let i = 0; i < centers.length; i++) {
    const name = shuffledNames[i] ?? shuffledNames[0];
    const buildings = VILLAGE_TEMPLATES[name];
    if (!buildings) continue;
    const placed = _placeVillageBuildings(rand, tiles, centers[i].col, centers[i].row, buildings, usedKeys);
    allPlacements.push(...placed);
    if (placed.length > 0) villageGroups.push({ root: placed[0], members: placed.slice(1) });
  }
  return { allPlacements, villageGroups };
}

// Generate a north-south meandering river path: exactly one tile per row (row 0 → MAP_ROWS-1).
// This guarantees every interior tile has exactly 2 river neighbours (no clusters),
// and the two endpoints each have exactly 1 (so the bezier can extend off-screen).
//
// Hex adjacency in odd-r offset means from an even row you can step to (col, row+1)
// or (col-1, row+1); from an odd row to (col+1, row+1) or (col, row+1).
export function generateRiverNS(rand) {
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

/// Generate an east-west meandering river path spanning col 0 → MAP_COLS-1.
// In odd-r offset, even-row hexes have only one rightward neighbor (col+1, row),
// while odd-row hexes have three: (col+1, row-1), (col+1, row), (col+1, row+1).
// To avoid near-straight rivers, even-row hexes may insert a vertical detour step
// (same column, row±1) to reach an odd row before continuing rightward.
// This means some columns may contain two river tiles.
export function generateRiverEW(rand) {
  const path = [];
  const minStart = Math.max(2, Math.floor(MAP_ROWS / 4));
  const rangeLen  = Math.max(1, Math.floor(MAP_ROWS / 2));
  const startRow  = minStart + Math.floor(rand() * rangeLen);
  let row = Math.min(startRow, MAP_ROWS - 3);

  for (let col = 0; col < MAP_COLS; col++) {
    path.push({ col, row });

    if (col < MAP_COLS - 1) {
      if (row % 2 === 1) {
        // Odd row: three rightward neighbors — pick freely
        const opts = [row - 1, row, row + 1].filter(r => r >= 2 && r <= MAP_ROWS - 3);
        row = opts[Math.floor(rand() * opts.length)];
      } else {
        // Even row: only (col+1, row) is rightward, but we can detour vertically
        // to an odd row first, enabling diagonal movement on the next step.
        // Skip detour if the new tile would neighbor an earlier river tile
        // (path[-2]), which would create a 3-neighbor cluster.
        if (rand() < 0.45) {
          const up   = row - 1;
          const down = row + 1;
          const canUp   = up >= 2;
          const canDown = down <= MAP_ROWS - 3;
          let target;
          if (canUp && canDown) {
            target = rand() < 0.5 ? up : down;
          } else if (canUp) {
            target = up;
          } else if (canDown) {
            target = down;
          }
          if (target !== undefined) {
            // Ensure detour tile won't be hex-adjacent to the previous column's tile
            const prev = path.length >= 2 ? path[path.length - 2] : null;
            const wouldCluster = prev &&
              getNeighbors(col, target).some(n => n.col === prev.col && n.row === prev.row);
            if (!wouldCluster) {
              row = target;
              path.push({ col, row });
            }
          }
        }
        // else: go straight to (col+1, row)
      }
    }
  }

  return path;
}

export function generateMap(seed = Date.now(), mapSize = 'standard', nodeCountOverride = null) {
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

  // 2. Carve meandering river — randomly N-S or E-W.
  //    Capture path to build a positional lookup for later checks.
  const riverEW   = rand() < 0.5;
  const riverPath = riverEW ? generateRiverEW(rand) : generateRiverNS(rand);
  const riverMap  = buildRiverMap(riverPath, riverEW);
  for (const { col, row } of riverPath) {
    const t = tiles.get(hexKey(col, row));
    if (t) t.type = TileType.RIVER;
  }

  // 3. Place INN and GRAVEYARD in opposite corners, then scatter remaining buildings
  const cornerPlacements = _pickCornerBuildings(rand, tiles);
  const cornerKeys       = new Set(cornerPlacements.map(b => hexKey(b.col, b.row)));
  const { allPlacements: villagePlacements, villageGroups } =
    _generateVillages(rand, tiles, cfg.villages, cfg.minVillageDist, cornerKeys);
  const buildingPlacements = [...cornerPlacements, ...villagePlacements];
  for (const { col, row, building } of buildingPlacements) {
    const t = tiles.get(hexKey(col, row));
    if (!t) continue;
    t.type = TileType.BUILDING;
    t.building = building;
    t.fortifyLevel = 1;
  }

  // 4. Two-tier road network — avoids the dense web produced by running MST on
  //    every building when many are clustered tightly in the same village.
  //
  //    Tier 1 — intra-village spokes: each building connects to its village's root
  //    (first-placed = closest to centre). Produces a clean star shape per village.
  //
  //    Tier 2 — inter-village trunk: Kruskal's MST on key points only
  //    (INN, GRAVEYARD, one root per village).  Long roads between settlements,
  //    none of the short overlapping paths within them.
  const roadEdges = [];

  // Tier 1: spoke per building → village root
  for (const { root, members } of villageGroups) {
    for (const m of members) roadEdges.push({ from: root, to: m });
  }

  // Tier 2: MST on key points + pre-selected river crossings
  const keyPoints = [...cornerPlacements, ...villageGroups.map(v => v.root)];

  // Pre-select river crossing points and convert them to bridges.
  // Adding crossings as key points in the MST ensures roads route through them
  // rather than dead-ending at the river when the bridge cap is reached.
  const crossings = _pickRiverCrossings(rand, tiles, riverPath, riverMap, riverEW, keyPoints, cfg.minBridges ?? 1, cfg.bridgeMax);
  for (const c of crossings) {
    const t = tiles.get(hexKey(c.col, c.row));
    if (t) t.type = TileType.BRIDGE;
  }
  keyPoints.push(...crossings);

  const nk = keyPoints.length;
  const interEdges = [];
  if (nk > 1) {
    const allEdges = [];
    for (let i = 0; i < nk; i++) {
      for (let j = i + 1; j < nk; j++) {
        allEdges.push({ i, j, d: hexDistance(keyPoints[i].col, keyPoints[i].row, keyPoints[j].col, keyPoints[j].row) });
      }
    }
    allEdges.sort((a, b) => a.d - b.d);
    const parent = Array.from({ length: nk }, (_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const { i, j } of allEdges) {
      if (find(i) !== find(j)) {
        parent[find(i)] = find(j);
        interEdges.push({ from: keyPoints[i], to: keyPoints[j] });
        if (interEdges.length === nk - 1) break;
      }
    }
  }

  roadEdges.push(...interEdges);

  // Tracks which tiles are already road/bridge so the weighted BFS can
  // penalise over-used hubs and route around them.
  const roadTiles = new Set();
  // Seed roadTiles with pre-placed bridges so BFS considers them connected
  for (const c of crossings) roadTiles.add(hexKey(c.col, c.row));
  const placeRoad = path => {
    for (let i = 0; i < path.length; i++) {
      const { col, row } = path[i];
      const t = tiles.get(hexKey(col, row));
      if (!t) continue;
      if (t.type === TileType.GRASS || t.type === TileType.DIRT || t.type === TileType.FOREST) {
        t.type = TileType.ROAD;
        roadTiles.add(hexKey(col, row));
      } else if (t.type === TileType.BRIDGE) {
        roadTiles.add(hexKey(col, row));
      }
      // Record bidirectional connectivity so the renderer and floodConnected
      // can use exact road topology rather than inferring from tile types.
      if (i > 0) {
        const prev = path[i - 1];
        const prevTile = tiles.get(hexKey(prev.col, prev.row));
        if (prevTile) {
          t.roadDirs.add(hexKey(prev.col, prev.row));
          prevTile.roadDirs.add(hexKey(col, row));
        }
      }
    }
  };

  // Returns true if 'to' is already reachable from 'from' via roadDirs links.
  // Used to skip edges that are already satisfied by previously-placed roads.
  const floodConnected = (from, to) => {
    const target = hexKey(to.col, to.row);
    const start  = hexKey(from.col, from.row);
    if (start === target) return true;
    const visited = new Set();
    const stack   = [start];
    while (stack.length) {
      const k = stack.pop();
      if (k === target) return true;
      if (visited.has(k)) continue;
      visited.add(k);
      const t = tiles.get(k);
      if (t) for (const nk of t.roadDirs) stack.push(nk);
    }
    return false;
  };

  for (const { from, to } of roadEdges) {
    if (floodConnected(from, to)) continue;
    placeRoad(bfsPath(tiles, from.col, from.row, to.col, to.row, rand, roadTiles, true));
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
    shuffle(grassTiles, rand);
    if (grassTiles.length === 0) break;
    const seedTile = grassTiles[0];
    seedTile.type = TileType.DIRT;
    const spreadNeighbors = shuffle(
      getNeighbors(seedTile.col, seedTile.row)
        .map(n => tiles.get(hexKey(n.col, n.row)))
        .filter(t => t && t.type === TileType.GRASS),
      rand
    );
    for (const n of spreadNeighbors.slice(0, Math.floor(rand() * 3))) {
      n.type = TileType.DIRT;
    }
  }

  // 6. Place witch objectives — well-spread, guaranteed across both sides of the river,
  //    with 3-hex clusters and minimum distance from starting positions.
  const buildingKeys = new Set(buildingPlacements.map(b => hexKey(b.col, b.row)));
  // Extract start positions now (buildings are placed; INN = hero start, GRAVEYARD = witch start)
  const heroStart  = buildingPlacements.find(b => b.building === BuildingType.INN)
                  || buildingPlacements[0];
  const witchStart = buildingPlacements.find(b => b.building === BuildingType.GRAVEYARD)
                  || buildingPlacements[buildingPlacements.length - 1];
  const startPositions = [heroStart, witchStart];

  const resolvedNodeCount = (nodeCountOverride != null)
    ? Math.max(cfg.nodeCountMin ?? 1, Math.min(cfg.nodeCountMax ?? cfg.nodeCount, nodeCountOverride))
    : cfg.nodeCount;
  // Battle maps: restrict nodes to the middle 2/3 of the map (away from spawn columns)
  const nodeColRange = mapSize === 'battle'
    ? { min: Math.floor(cfg.cols / 6), max: Math.floor(cfg.cols * 5 / 6) }
    : null;
  const objPositions = _pickNodesAcrossRiver(rand, tiles, resolvedNodeCount, 4, buildingKeys, riverMap, riverEW, startPositions, nodeColRange);
  const witchObjectives = objPositions.map((pos, i) => ({
    col: pos.col, row: pos.row,
    label: WITCH_OBJECTIVE_LABELS[i] ?? `Power Node ${i + 1}`,
    hexes: _pickNodeCluster(rand, tiles, pos, buildingKeys, startPositions),
    color: NODE_COLORS[i % NODE_COLORS.length],
    seenByHero:  false,
    seenByWitch: false,
    prevCtrl:    'neutral',
  }));

  return { tiles, witchObjectives, heroStart, witchStart, mapSize, survivorCounts: cfg.survivorCounts };
}

// ── Multiple start positions (multiplayer) ───────────────────────────────────
//
// Returns an array of `count` distinct start positions for a faction.
// The first position is always `primaryStart` (the INN or GRAVEYARD).
// Additional positions fan out from the primary within `searchRadius` hexes,
// preferring open tiles that are at least `minSep` hexes apart from each other.

export function generateMultipleStarts(tiles, primaryStart, count, minSep = 2, searchRadius = 5) {
  if (count <= 1) return [{ col: primaryStart.col, row: primaryStart.row }];

  const placed = [{ col: primaryStart.col, row: primaryStart.row }];
  const visited = new Set([`${primaryStart.col},${primaryStart.row}`]);
  const queue = [{ col: primaryStart.col, row: primaryStart.row, dist: 0 }];
  const candidates = [];

  // BFS to collect tiles within searchRadius
  while (queue.length) {
    const cur = queue.shift();
    if (cur.dist >= searchRadius) continue;
    for (const n of getNeighbors(cur.col, cur.row)) {
      const k = `${n.col},${n.row}`;
      if (visited.has(k)) continue;
      visited.add(k);
      const t = tiles.get(k);
      if (!t || t.type === TileType.RIVER) continue;
      candidates.push({ col: n.col, row: n.row });
      queue.push({ col: n.col, row: n.row, dist: cur.dist + 1 });
    }
  }

  for (const cand of candidates) {
    if (placed.length >= count) break;
    const tooClose = placed.some(p => hexDistance(cand.col, cand.row, p.col, p.row) < minSep);
    if (!tooClose) placed.push({ col: cand.col, row: cand.row });
  }

  // If we still don't have enough (map is tiny), repeat primary start for overflow
  while (placed.length < count) placed.push({ col: primaryStart.col, row: primaryStart.row });

  return placed;
}

/**
 * Generate spawn positions for battle mode.
 * Heroes spawn in the leftmost 3 columns; witches in the rightmost 3.
 * Returns `count` positions spread at least `minSep` hexes apart.
 *
 * @param {Map<string,Tile>} tiles
 * @param {'hero'|'witch'} faction
 * @param {number} count
 * @param {number} [minSep=2]
 * @returns {{ col: number, row: number }[]}
 */
export function generateBattleStarts(tiles, faction, count, minSep = 2) {
  const cols = faction === 'hero'
    ? [0, 1, 2]
    : [MAP_COLS - 3, MAP_COLS - 2, MAP_COLS - 1];

  // Collect all passable candidate tiles in the faction's starting columns
  const candidates = [];
  for (const [, t] of tiles) {
    if (!cols.includes(t.col)) continue;
    if (t.type === TileType.RIVER) continue;
    candidates.push({ col: t.col, row: t.row });
  }

  // Shuffle deterministically (caller can seed via tiles order)
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  // Greedily pick positions that respect minSep
  const placed = [];
  for (const cand of candidates) {
    if (placed.length >= count) break;
    const tooClose = placed.some(p => hexDistance(cand.col, cand.row, p.col, p.row) < minSep);
    if (!tooClose) placed.push({ col: cand.col, row: cand.row });
  }

  // If not enough (tiny map), relax separation
  if (placed.length < count) {
    for (const cand of candidates) {
      if (placed.length >= count) break;
      if (!placed.some(p => p.col === cand.col && p.row === cand.row)) {
        placed.push({ col: cand.col, row: cand.row });
      }
    }
  }

  return placed;
}
