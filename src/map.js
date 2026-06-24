// Procedural map generator for the Caleb's Hollow hex map
import { MAP_COLS, MAP_ROWS, setMapDimensions, getNeighbors, hexKey, hexDistance, neighborDirIndex } from './hex.js';
import { Tile, TileType, BuildingType, PathType, StructureType, legacyTileType, isRiver, isBridge, hasBuilding, isBuildingFootprint, pathOf, deriveBlockedSlots } from './tiles.js';
import { buildMST, placeRoadPath } from './road-network.js';
import { pickFootprintNeighbor } from './building-footprint.js';

// Flavor labels for the witch power nodes (extra labels for larger maps)
const WITCH_OBJECTIVE_LABELS = [
  'Ancient Altar', 'Dark Grove', 'Cursed Crossroads', 'Forgotten Hollow',
  'Witches\' Mound', 'Blighted Fen', 'Shadow Cairn',
];

// Allowed values for state.season. Kept in sync with SEASONS in renderer-3d.js;
// declared here to avoid a map.js → renderer-3d.js (and thus DOM/Babylon) import.
export const SEASONS = Object.freeze(['summer', 'fall', 'spring', 'winter']);

// Distinct colors for each power node index — used in renderer and score tracker.
// Chosen to be visually distinct from hero blue (#4488ff), witch red (#cc3333),
// and the green "you can move here" reachable-hex highlight (~hue 128°, see
// HIGHLIGHT_DEFAULT_RGBA `rgba(60,220,80,…)` in renderer-3d.js). Node 0 used to be
// emerald green (#22c55e, ~hue 142°) which read almost identically to that move
// highlight; it is now magenta/fuchsia (~hue 292°) — far from the green highlight
// and from both faction colors. Lime (index 5, ~hue 84°) is yellow-green and stays
// distinguishable from the highlight; everything else is unchanged.
export const NODE_COLORS = [
  '#d946ef', // fuchsia (was emerald green; clashed with the move-here highlight)
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
    label: 'Skirmish (10×10)',
    cols: 10, rows: 10,
    villages: ['market', 'parish'],
    minVillageDist: 6,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:8,row:1},{col:9,row:0},
      {col:9,row:3},{col:0,row:4},{col:1,row:8},{col:9,row:7},
      {col:4,row:2},{col:6,row:7},
    ],
    nodeCount: 1, nodeCountMin: 1, nodeCountMax: 3,
    survivorCounts: { buildings: 4, terrain: 1 },
    bridgeMax: 1,
    minBridges: 1,
  },
  standard: {
    label: 'Standard (14×14)',
    cols: 14, rows: 14,
    villages: ['market', 'parish', 'harbor'],
    minVillageDist: 6,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:12,row:1},{col:13,row:0},
      {col:13,row:4},{col:0,row:6},{col:1,row:10},{col:13,row:9},
      {col:8,row:3},{col:9,row:9},{col:0,row:4},{col:6,row:10},
      {col:3,row:12},{col:11,row:13},{col:6,row:13},
    ],
    nodeCount: 3, nodeCountMin: 2, nodeCountMax: 5,
    survivorCounts: { buildings: 7, terrain: 1 },
    bridgeMax: 2,
    minBridges: 1,
  },
  regional: {
    label: 'Regional (19×19)',
    cols: 19, rows: 19,
    villages: ['market', 'parish', 'harbor', 'garrison'],
    minVillageDist: 7,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:17,row:1},{col:18,row:0},
      {col:18,row:4},{col:0,row:8},{col:1,row:12},{col:18,row:10},
      {col:10,row:3},{col:11,row:10},{col:0,row:4},{col:8,row:12},
      {col:6,row:1},{col:13,row:7},{col:3,row:7},{col:16,row:12},
      {col:2,row:15},{col:16,row:16},{col:9,row:17},{col:1,row:18},
      {col:17,row:18},
    ],
    nodeCount: 3, nodeCountMin: 2, nodeCountMax: 6,
    survivorCounts: { buildings: 10, terrain: 2 },
    bridgeMax: 2,
    minBridges: 1,
  },
  campaign: {
    label: 'Campaign (23×23)',
    cols: 23, rows: 23,
    villages: ['market', 'parish', 'harbor', 'garrison', 'farmstead'],
    minVillageDist: 8,
    forestSeeds: [
      {col:0,row:0},{col:1,row:1},{col:21,row:1},{col:22,row:0},
      {col:22,row:5},{col:0,row:9},{col:1,row:14},{col:22,row:12},
      {col:12,row:3},{col:13,row:12},{col:0,row:5},{col:9,row:14},
      {col:5,row:1},{col:16,row:8},{col:3,row:8},{col:19,row:14},
      {col:9,row:0},{col:15,row:0},{col:0,row:11},{col:22,row:8},
      {col:3,row:16},{col:19,row:18},{col:11,row:19},{col:5,row:20},
      {col:15,row:21},{col:0,row:22},{col:22,row:22},{col:11,row:22},
    ],
    nodeCount: 3, nodeCountMin: 2, nodeCountMax: 7,
    survivorCounts: { buildings: 13, terrain: 3 },
    bridgeMax: 3,
    minBridges: 1,
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
// Routing through an impassable building footprint is heavily penalised so the
// MST road planner detours around footprints whenever any alternative exists —
// a road over a footprint hex is visually wrong and (once footprints become
// impassable, P3) would be a road the in-game pathfinder can't actually use.
// It is a finite penalty rather than a hard block so a building wedged on a
// tight map (where its footprint is the only approach) still gets connected and
// bridge crossings are never starved below `minBridges`. The companion guard in
// `placeRoadPath` (road-network.js) refuses to paint a ROAD deck onto a
// footprint even on the rare last-resort path, so a footprint never carries a
// road/bridge path — connectivity is recorded via roadDirs only, exactly like a
// building tile.
const FOOTPRINT_ROAD_PENALTY = 50;

// Chance a building's cleared-ground base is GRASS rather than DIRT. Buildings
// never sit on forest (the tile is cleared); this just adds dirt/grass variety
// so settlements aren't a uniform dirt patch. Tunable.
const BUILDING_GRASS_CHANCE = 0.4;

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
      if (blockRiver && isRiver(nTile)) continue;
      const deg = roadDeg(n.col, n.row);
      let step = 1 + Math.max(0, deg - (MAX_ROAD_DEG - 1)) * ROAD_DEG_PENALTY;
      // Strongly avoid routing through impassable building footprints (see
      // FOOTPRINT_ROAD_PENALTY). Finite, so a wedged building still connects.
      if (isBuildingFootprint(nTile)) step += FOOTPRINT_ROAD_PENALTY;
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
    if (legacyTileType(t) !== TileType.GRASS) continue;
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

// Conservative max sight clearance (in hexes) for faction starts. The two
// starts must sit MORE than this far apart so neither leader can see the other
// on turn 1. The game starts at DAWN (leader sight 4–5), but we clear the
// maximum *base* phase sight (DAY = 6) so the starts stay out of sight even as
// the cycle turns to day — a deliberately conservative buffer. (Rogue +1 and a
// Scout +1 can push a unit to 7–8, but those units don't exist at game start
// and rarely march straight back to the enemy spawn, so 6 is the chosen floor.)
export const START_SIGHT_CLEARANCE = 6;

// Place INN (hero start) and GRAVEYARD (witch start) on OPPOSITE sides of the
// river, far enough apart that neither leader can see the other at game start
// (hex distance > START_SIGHT_CLEARANCE). Seeded/deterministic: same seed →
// same starts. The road network (built later) connects the banks via bridges,
// so opposite-bank starts stay mutually reachable.
//
// Replaces the old fixed opposite-corner placement (TL+BR / TR+BL) — corners
// made every game open the same way. Now both starts vary across the whole
// playable area, constrained only by the opposite-bank + out-of-sight rule.
//
// Candidate tiles use the same constraints as the old corner picker: plain
// GRASS, off the 1-tile border, and NOT river-adjacent (so the later building
// footprint claim can't wall a river bank). Tiers degrade gracefully on tight
// maps where a strict pair may not exist:
//   1. opposite banks AND out of sight (dist > clearance)            — strict
//   2. opposite banks, the most-distant pair available               — relax sight
//   3. any two candidates, the most-distant pair                     — relax banks
//   4. legacy opposite-corner fallback                               — last resort
// `riverMap`/`riverEW` describe the carved river; see riverSide().
function _pickFactionStarts(rand, tiles, riverMap, riverEW) {
  const hasRiverNeighbor = (col, row) =>
    getNeighbors(col, row).some(n => isRiver(tiles.get(hexKey(n.col, n.row))));

  // Collect spawn-eligible candidates, classified by river bank.
  const left = [], right = [];
  for (const [, t] of tiles) {
    if (legacyTileType(t) !== TileType.GRASS) continue;
    if (t.col < 1 || t.col > MAP_COLS - 2 || t.row < 1 || t.row > MAP_ROWS - 2) continue;
    if (hasRiverNeighbor(t.col, t.row)) continue;
    (riverSide(t.col, t.row, riverMap, riverEW) === 'left' ? left : right)
      .push({ col: t.col, row: t.row });
  }
  // Seeded shuffle so equal-quality choices vary per seed (determinism preserved
  // because `rand` is the seeded stream and traversal order is stable).
  shuffle(left, rand);
  shuffle(right, rand);

  // Best opposite-bank pair: among all (left,right) pairs whose distance clears
  // the threshold, pick one at random; if none clear it, fall back to the
  // single most-distant opposite-bank pair we can find.
  const pickOppositeBankPair = () => {
    const clearing = [];
    let best = null, bestDist = -1;
    for (const a of left) {
      for (const b of right) {
        const d = hexDistance(a.col, a.row, b.col, b.row);
        if (d > bestDist) { bestDist = d; best = [a, b]; }
        if (d > START_SIGHT_CLEARANCE) clearing.push([a, b]);
      }
    }
    if (clearing.length) return clearing[Math.floor(rand() * clearing.length)];
    return best; // most-distant opposite-bank pair (tier 2), or null if a side is empty
  };

  // Tier 3: ignore banks — most-distant pair among ALL candidates. Only used
  // when the river leaves one bank with no eligible spawn tile (degenerate maps).
  const pickAnyDistantPair = () => {
    const all = [...left, ...right];
    let best = null, bestDist = -1;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const d = hexDistance(all[i].col, all[i].row, all[j].col, all[j].row);
        if (d > bestDist) { bestDist = d; best = [all[i], all[j]]; }
      }
    }
    return best;
  };

  let pair = (left.length && right.length) ? pickOppositeBankPair() : null;
  if (!pair) pair = pickAnyDistantPair();

  // Tier 4: legacy opposite-corner placement — only if we somehow found < 2
  // eligible candidates anywhere (extremely small / pathological map).
  if (!pair) return _pickCornerBuildingsFallback(rand, tiles);

  // Randomly assign which faction starts on which tile of the pair.
  const [first, second] = rand() < 0.5 ? pair : [pair[1], pair[0]];
  return [
    { col: first.col,  row: first.row,  building: BuildingType.INN },
    { col: second.col, row: second.row, building: BuildingType.GRAVEYARD },
  ];
}

// Legacy opposite-corner placement (TL+BR or TR+BL), retained only as the
// last-resort fallback for `_pickFactionStarts` on degenerate maps.
function _pickCornerBuildingsFallback(rand, tiles) {
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
    getNeighbors(col, row).some(n => isRiver(tiles.get(hexKey(n.col, n.row))));

  const pickFrom = zone => {
    const cs = [];
    for (const [, t] of tiles) {
      if (legacyTileType(t) !== TileType.GRASS) continue;
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

// Battle mode: place 5 INNs on one side of the river and 5 GRAVEYARDs on the other.
// Buildings are spread out, avoid edges and center, and get connected to the road network.
function _placeBattleSpawnBuildings(rand, tiles, riverMap, riverEW) {
  const innSide  = rand() < 0.5 ? 'left' : 'right';
  const gravSide = innSide === 'left' ? 'right' : 'left';

  const EDGE_MARGIN = 3;
  const hasRiverNeighbor = (col, row) =>
    getNeighbors(col, row).some(n => isRiver(tiles.get(hexKey(n.col, n.row))));

  // Collect candidates on each side — exclude edges and center third of map
  const collectCandidates = (side) => {
    const cands = [];
    for (const [, t] of tiles) {
      if (legacyTileType(t) !== TileType.GRASS) continue;
      if (t.col < EDGE_MARGIN || t.col > MAP_COLS - 1 - EDGE_MARGIN) continue;
      if (t.row < EDGE_MARGIN || t.row > MAP_ROWS - 1 - EDGE_MARGIN) continue;
      if (hasRiverNeighbor(t.col, t.row)) continue;
      if (riverSide(t.col, t.row, riverMap, riverEW) !== side) continue;
      // Exclude center third — buildings should be away from the middle
      if (riverEW) {
        // E-W river splits top/bottom; exclude center rows
        const centerMin = Math.floor(MAP_ROWS / 3);
        const centerMax = Math.floor(MAP_ROWS * 2 / 3);
        if (t.row >= centerMin && t.row <= centerMax) continue;
      } else {
        // N-S river splits left/right; exclude center columns
        const centerMin = Math.floor(MAP_COLS / 3);
        const centerMax = Math.floor(MAP_COLS * 2 / 3);
        if (t.col >= centerMin && t.col <= centerMax) continue;
      }
      cands.push({ col: t.col, row: t.row });
    }
    return cands;
  };

  const pickSpread = (cands, count, minDist) => {
    shuffle(cands, rand);
    const placed = [];
    for (const c of cands) {
      if (placed.length >= count) break;
      if (placed.some(p => hexDistance(p.col, p.row, c.col, c.row) < minDist)) continue;
      placed.push(c);
    }
    // Relax separation if not enough found
    if (placed.length < count) {
      for (const c of cands) {
        if (placed.length >= count) break;
        if (!placed.some(p => p.col === c.col && p.row === c.row)) placed.push(c);
      }
    }
    return placed;
  };

  const innCands  = collectCandidates(innSide);
  const gravCands = collectCandidates(gravSide);

  const innPositions  = pickSpread(innCands,  5, 5);
  const gravPositions = pickSpread(gravCands, 5, 5);

  const result = [];
  for (const p of innPositions)  result.push({ col: p.col, row: p.row, building: BuildingType.INN });
  for (const p of gravPositions) result.push({ col: p.col, row: p.row, building: BuildingType.GRAVEYARD });
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
    if (isRiver(t) || isBridge(t) || hasBuilding(t)) continue;
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
      if (!t || isRiver(t)) return false;
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
      if (!t || isRiver(t)) return false;
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
// river, preferring tiles close to key settlement points.  Each returned crossing
// includes specific `leftBank` and `rightBank` neighbour tiles so the road planner
// can ensure both banks become part of the road graph.
function _pickRiverCrossings(rand, tiles, riverPath, riverMap, riverEW, keyPoints, minCount, maxCount) {
  // Rank a bank candidate: prefer already-connected tiles, then clean terrain,
  // then proximity to key settlement points (lower score = better).
  const bankRank = (n) => {
    const t = tiles.get(hexKey(n.col, n.row));
    if (!t) return 999;
    let typeRank;
    switch (legacyTileType(t)) {
      case TileType.ROAD:
      case TileType.BRIDGE:
      case TileType.BUILDING: typeRank = 0; break;
      case TileType.GRASS:
      case TileType.DIRT:     typeRank = 1; break;
      case TileType.FOREST:   typeRank = 2; break;
      default:                typeRank = 3;
    }
    const minKeyDist = keyPoints.length > 0
      ? Math.min(...keyPoints.map(kp => hexDistance(kp.col, kp.row, n.col, n.row)))
      : 0;
    return typeRank * 100 + minKeyDist;
  };

  const candidates = [];
  for (let idx = 0; idx < riverPath.length; idx++) {
    const { col, row } = riverPath[idx];
    const neighbors = getNeighbors(col, row);
    // A bank must be passable land: not river, and not an impassable building
    // footprint (capacity 0). Excluding footprints here stops a building wall
    // from starving a crossing of its only approach — defence in depth behind
    // the footprint placement scoring.
    const leftNbrs = neighbors.filter(n => {
      const t = tiles.get(hexKey(n.col, n.row));
      return t && !isRiver(t) && !isBuildingFootprint(t) && riverSide(n.col, n.row, riverMap, riverEW) === 'left';
    });
    const rightNbrs = neighbors.filter(n => {
      const t = tiles.get(hexKey(n.col, n.row));
      return t && !isRiver(t) && !isBuildingFootprint(t) && riverSide(n.col, n.row, riverMap, riverEW) === 'right';
    });
    if (leftNbrs.length === 0 || rightNbrs.length === 0) continue;

    // Pick the best bank on each side (deterministic via shuffle then sort).
    shuffle(leftNbrs, rand);
    shuffle(rightNbrs, rand);
    leftNbrs.sort((a, b) => bankRank(a) - bankRank(b));
    rightNbrs.sort((a, b) => bankRank(a) - bankRank(b));

    // Prefer a left/right bank pair on OPPOSITE hex edges of the crossing tile
    // so the bridge spans straight across (entry edge `d`, exit edge `(d+3)%6`).
    // Both banks are neighbours of (col,row), so an opposite-edge pair is also
    // hex-distance 2 apart — the strictly stronger condition. We keep the banks
    // ranked best-first (already sorted above), so the first opposite pair found
    // is the highest-quality straight crossing. `straight` records whether this
    // tile yields an opposite-edge span; selection prefers straight crossings.
    let leftBank = null, rightBank = null, straight = false;
    oppEdge: for (const l of leftNbrs) {
      for (const r of rightNbrs) {
        if (edgesAreOpposite(col, row, l.col, l.row, r.col, r.row)) {
          leftBank = l; rightBank = r; straight = true;
          break oppEdge;
        }
      }
    }
    if (!leftBank || !rightBank) {
      // Fallback: any non-adjacent bank pair (the original behaviour). Adjacent
      // banks indicate the river doesn't truly separate them at this tile (tight
      // bend or pocket) so the bridge wouldn't actually span anything. A bent
      // crossing is kept as a candidate only so a river with no straight tile
      // anywhere can still reach `minBridges`; the post-gen cleanup straightens
      // it where possible or reverts it.
      outer: for (const l of leftNbrs) {
        for (const r of rightNbrs) {
          if (hexDistance(l.col, l.row, r.col, r.row) >= 2) {
            leftBank = l; rightBank = r;
            break outer;
          }
        }
      }
    }
    if (!leftBank || !rightBank) continue;

    const minKeyDist = keyPoints.length > 0
      ? Math.min(...keyPoints.map(kp => hexDistance(kp.col, kp.row, col, row)))
      : 0;
    candidates.push({ col, row, idx, score: minKeyDist, leftBank, rightBank, straight });
  }

  // Sort by proximity to key points (closest first), preferring straight
  // (opposite-edge) crossings as the tiebreak among similarly-placed tiles, with
  // a seeded shuffle as the final stable random tiebreak. Keeping `score`
  // primary preserves the original well-spaced selection (so bridge counts stay
  // close to baseline); the straight tiebreak just nudges toward opposite-edge
  // crossings so the post-gen audit rarely has to revert a bent span.
  shuffle(candidates, rand);
  candidates.sort((a, b) => (a.score - b.score) || (b.straight - a.straight));

  // Greedily pick well-spaced crossings along the river path
  const minSpacing = Math.max(3, Math.floor(riverPath.length / (maxCount + 1)));
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= maxCount) break;
    if (picked.some(p => Math.abs(p.idx - c.idx) < minSpacing)) continue;
    picked.push(c);
  }

  // Relax spacing to reach minCount if needed. Candidates are already ordered
  // straight-first, so this still prefers straight crossings when relaxing.
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

// Water buildings (the mill's water wheel, the dock's berths) are no longer
// placed by procedural map generation. They remain valid `BuildingType` enum
// values and can still be placed by the Mission Editor — the runtime just
// won't randomly pick them.
const WATER_BUILDINGS = new Set([BuildingType.DOCK, BuildingType.MILL]);

// Place one village's buildings in a compact cluster around a center hex.
// Buildings are sorted closest-first (with seeded random tiebreaking) and
// placed with MIN_SEP gaps so the result reads as a dense but walkable hamlet.
// Any water building requested by the template is silently skipped.
function _placeVillageBuildings(rand, tiles, centerCol, centerRow, buildings, usedKeys) {
  const RADIUS  = 4; // max hex distance from village center
  const MIN_SEP = 3; // min separation between any two buildings in this village

  const landCandidates = [];
  for (const [, t] of tiles) {
    if (legacyTileType(t) !== TileType.GRASS) continue;
    const k = hexKey(t.col, t.row);
    if (usedKeys.has(k)) continue;
    const dist = hexDistance(centerCol, centerRow, t.col, t.row);
    if (dist < 0 || dist > RADIUS) continue;
    landCandidates.push({ col: t.col, row: t.row, dist });
  }
  // Shuffle first so equal-distance tiles are randomly ordered, then stable-sort by distance
  shuffle(landCandidates, rand);
  landCandidates.sort((a, b) => a.dist - b.dist);

  const placed = [];
  for (const building of buildings) {
    if (WATER_BUILDINGS.has(building)) continue;
    for (const c of landCandidates) {
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
// riverMap/riverEW are used to ensure villages are distributed across the river
// (at least 1 on each side when 2+ villages are being placed).
function _generateVillages(rand, tiles, villageNames, minVillageDist, reservedKeys, riverMap, riverEW) {
  const usedKeys = new Set(reservedKeys);
  const reservedPositions = [...reservedKeys].map(k => {
    const [col, row] = k.split(',').map(Number);
    return { col, row };
  });

  // Collect eligible center candidates away from map edges
  const centerCandidates = [];
  for (const [, t] of tiles) {
    if (legacyTileType(t) !== TileType.GRASS) continue;
    if (t.col < 2 || t.col > MAP_COLS - 3 || t.row < 2 || t.row > MAP_ROWS - 3) continue;
    centerCandidates.push({ col: t.col, row: t.row });
  }
  shuffle(centerCandidates, rand);

  const minToCorner = Math.ceil(minVillageDist * 0.75); // slightly smaller buffer to corners
  const ok = c => !centers.some(p => hexDistance(p.col, p.row, c.col, c.row) < minVillageDist) &&
                  !reservedPositions.some(p => hexDistance(p.col, p.row, c.col, c.row) < minToCorner);

  // Split candidates by river side for balanced placement
  const leftCands  = centerCandidates.filter(c => riverSide(c.col, c.row, riverMap, riverEW) === 'left');
  const rightCands = centerCandidates.filter(c => riverSide(c.col, c.row, riverMap, riverEW) === 'right');

  const centers = [];
  const target = villageNames.length;

  // Guarantee at least 1 village on each side when placing 2+ villages
  if (target >= 2 && leftCands.length > 0 && rightCands.length > 0) {
    const l = leftCands.find(ok);
    if (l) centers.push(l);
    const r = rightCands.find(ok);
    if (r) centers.push(r);
  }

  // Cap: at most half (rounded up) of village centers on one side (keeps buildings ≤80%)
  const maxPerSide = Math.ceil(target / 2);
  const sideOf = c => riverSide(c.col, c.row, riverMap, riverEW);
  const countSide = side => centers.filter(p => sideOf(p) === side).length;

  // Fill remaining, respecting the per-side cap
  for (const c of centerCandidates) {
    if (centers.length >= target) break;
    if (centers.some(p => p.col === c.col && p.row === c.row)) continue;
    if (!ok(c)) continue;
    if (countSide(sideOf(c)) >= maxPerSide) continue;
    centers.push(c);
  }
  // Fallback: if per-side cap was too restrictive, fill without cap
  for (const c of centerCandidates) {
    if (centers.length >= target) break;
    if (centers.some(p => p.col === c.col && p.row === c.row)) continue;
    if (ok(c)) centers.push(c);
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
  // Start in the middle range, clamped to the safe river corridor.
  // Buffer from each edge guarantees enough land for buildings on both sides.
  const buf = MAP_COLS >= 12 ? 4 : 3;
  const minStart = Math.max(buf, Math.floor(MAP_COLS / 4));
  const maxStart = MAP_COLS - 1 - buf;
  const rangeLen  = Math.max(1, maxStart - minStart + 1);
  const startCol  = minStart + Math.floor(rand() * rangeLen);
  let col = Math.min(startCol, maxStart);

  for (let row = 0; row < MAP_ROWS; row++) {
    path.push({ col, row });

    if (row < MAP_ROWS - 1) {
      const isEven = row % 2 === 0;
      // Two possible next columns based on offset parity
      const optA = isEven ? col     : col + 1; // "straight"
      const optB = isEven ? col - 1 : col;     // "drift"
      // Clamp both to safe range and pick randomly
      const a = Math.max(buf, Math.min(MAP_COLS - 1 - buf, optA));
      const b = Math.max(buf, Math.min(MAP_COLS - 1 - buf, optB));
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
  // Buffer from each edge guarantees enough land for buildings on both sides.
  const buf = MAP_ROWS >= 12 ? 4 : 3;
  const minStart = Math.max(buf, Math.floor(MAP_ROWS / 4));
  const maxStart = MAP_ROWS - 1 - buf;
  const rangeLen  = Math.max(1, maxStart - minStart + 1);
  const startRow  = minStart + Math.floor(rand() * rangeLen);
  let row = Math.min(startRow, maxStart);

  for (let col = 0; col < MAP_COLS; col++) {
    path.push({ col, row });

    if (col < MAP_COLS - 1) {
      if (row % 2 === 1) {
        // Odd row: three rightward neighbors — pick freely
        const opts = [row - 1, row, row + 1].filter(r => r >= buf && r <= MAP_ROWS - 1 - buf);
        row = opts[Math.floor(rand() * opts.length)];
      } else {
        // Even row: only (col+1, row) is rightward, but we can detour vertically
        // to an odd row first, enabling diagonal movement on the next step.
        // Skip detour if the new tile would neighbor an earlier river tile
        // (path[-2]), which would create a 3-neighbor cluster.
        if (rand() < 0.45) {
          const up   = row - 1;
          const down = row + 1;
          const canUp   = up >= buf;
          const canDown = down <= MAP_ROWS - 1 - buf;
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

// ── Opposite-edge helper ─────────────────────────────────────────────────────
//
// Pointy-top odd-r hex has 6 edge directions (0..5, see `neighborDirIndex` in
// hex.js). The edge directly opposite direction `d` is `(d + 3) % 6` (W↔E,
// NW↔SE, NE↔SW). A bridge spans straight across a hex exactly when its two
// road links sit on opposite edges; an adjacent-edge pair produces a "bent"
// crossing whose 3D plank skews instead of spanning. Returns true when the two
// neighbours of `(col,row)` lie on opposite hex edges. Pure.
function edgesAreOpposite(col, row, ac, ar, bc, br) {
  const da = neighborDirIndex(col, row, ac, ar);
  const db = neighborDirIndex(col, row, bc, br);
  if (da < 0 || db < 0) return false;
  return (da + 3) % 6 === db;
}

// ── Bridge invariant ─────────────────────────────────────────────────────────
//
// Hard post-gen invariant: every BRIDGE tile connects EXACTLY two road
// entry/exit faces (neighbours linked via `roadDirs`), AND those two faces are
// on OPPOSITE hex edges so the span is straight. The 3D bridge model
// (`bridgeRotationY` in renderer-3d.js) orients its plank from `roadDirs` and
// renders a broken/floating span for any other count, and a bent/skewed plank
// for a non-opposite (adjacent-edge) pair. So anything other than two
// opposite-edge links is a hard failure. Returns an array of
// `{ col, row, reason }` violations (empty when the map is clean). Pure —
// usable from both runtime and tests.
export function findBridgeInvariantViolations(tiles) {
  const out = [];
  for (const t of tiles.values()) {
    if (!isBridge(t)) continue;
    const links = [...t.roadDirs];
    if (links.length !== 2) {
      out.push({ col: t.col, row: t.row, reason: `${links.length} road links (must be 2)` });
      continue;
    }
    const bridgeKey = hexKey(t.col, t.row);
    let neighbourly = true;
    for (const nk of links) {
      const [nc, nr] = nk.split(',').map(Number);
      if (hexDistance(t.col, t.row, nc, nr) !== 1) {
        out.push({ col: t.col, row: t.row, reason: `road link ${nk} is not a neighbour` });
        neighbourly = false;
        continue;
      }
      const nt = tiles.get(nk);
      if (!nt || !nt.roadDirs.has(bridgeKey)) {
        out.push({ col: t.col, row: t.row, reason: `road link ${nk} is not reciprocated` });
      }
    }
    // Opposite-edge span: only meaningful when both links are genuine
    // neighbours (otherwise the not-a-neighbour reason above already fired).
    if (neighbourly) {
      const [ac, ar] = links[0].split(',').map(Number);
      const [bc, br] = links[1].split(',').map(Number);
      if (!edgesAreOpposite(t.col, t.row, ac, ar, bc, br)) {
        out.push({ col: t.col, row: t.row, reason: `road links ${links[0]} and ${links[1]} are not on opposite edges (bent span)` });
      }
    }
  }
  return out;
}

// Throwing wrapper around findBridgeInvariantViolations — used by tests (and
// any caller that wants the invariant enforced) so regressions blow up loudly.
export function assertMapInvariants(tiles) {
  const v = findBridgeInvariantViolations(tiles);
  if (v.length) {
    const detail = v.map(x => `(${x.col},${x.row}): ${x.reason}`).join('; ');
    throw new Error(`Map invariant violation — ${v.length} bad bridge(s): ${detail}`);
  }
  return true;
}

// Defensive coercion of a (possibly untrusted) node-count override to a finite
// integer or null. Only a genuine number or numeric string is honored — `+x`
// coerces null/[]/false/'' to 0, so a bare `Number.isFinite(+x)` would wrongly
// accept those. Returns null ("no override" → size default) for anything else.
function _coerceNodeCountOverride(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  return null;
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
    // River is a PATH overlay — set path, leave base material (grass) intact.
    if (t) t.path = PathType.RIVER;
  }

  // 3. Place INN and GRAVEYARD — battle maps get 5+5 faction buildings on opposite
  //    river sides; other maps place a single INN/GRAVEYARD on OPPOSITE river
  //    banks, far enough apart to be out of sight of each other at game start.
  const cornerPlacements = mapSize === 'battle'
    ? _placeBattleSpawnBuildings(rand, tiles, riverMap, riverEW)
    : _pickFactionStarts(rand, tiles, riverMap, riverEW);
  const cornerKeys       = new Set(cornerPlacements.map(b => hexKey(b.col, b.row)));
  const { allPlacements: villagePlacements, villageGroups } =
    _generateVillages(rand, tiles, cfg.villages, cfg.minVillageDist, cornerKeys, riverMap, riverEW);
  // Materialize each building onto its entrance tile and claim one adjacent
  // footprint hex (P2 of the building-footprint rework). Two passes, both in
  // placement order: since `rand` is the seeded RNG and the placement order is
  // deterministic for a given seed, the RNG stream — and the resulting layout —
  // stay reproducible.
  //
  // Pass 1 materializes ALL entrances first so that, in pass 2, the footprint
  // picker sees every entrance via `building != null` and never claims a hex
  // that is itself another building's entrance (buildings can sit one hex apart
  // on tight maps, so we cannot rely on spacing alone).
  const allBuildingPlacements = [...cornerPlacements, ...villagePlacements];
  for (const placement of allBuildingPlacements) {
    const { col, row, building } = placement;
    const t = tiles.get(hexKey(col, row));
    if (!t) { placement.rolledBack = true; continue; }
    // Snapshot the tile's prior terrain so a failed footprint claim (pass 2)
    // can revert the entrance to whatever it was.
    placement.prior = {
      base: t.base, structure: t.structure, path: t.path,
      building: t.building, fortifyLevel: t.fortifyLevel,
      footprintHexes: t.footprintHexes, buildingFootprintOf: t.buildingFootprintOf,
    };
    // Building is a STRUCTURE layer on CLEARED ground. Operator-locked design:
    // a building clears the trees on its tile, so the base is always dirt or
    // grass — NEVER forest. Give the base some variety (not always dirt) so a
    // settlement doesn't read as a uniform dirt patch. The pick is seeded, so
    // same-seed maps stay reproducible. Clear any path — road-through-building
    // is carried by `roadDirs` only, never the path layer (P0 semantics).
    t.base = rand() < BUILDING_GRASS_CHANCE ? TileType.GRASS : TileType.DIRT;
    t.structure = StructureType.BUILDING;
    t.path = null;
    t.building = building;
    t.fortifyLevel = 1;
  }
  // Pass 2: claim one impassable footprint hex per entrance. Power nodes aren't
  // placed until step 6 and roads/forests don't exist yet, so the footprint
  // always lands on open terrain. Writing `buildingFootprintOf` immediately
  // means a later entrance's pick automatically skips this hex.
  for (const placement of allBuildingPlacements) {
    if (placement.rolledBack) continue;
    const { col, row } = placement;
    const fp = pickFootprintNeighbor(tiles, col, row, rand);
    if (fp) {
      const fpKey = hexKey(fp.col, fp.row);
      tiles.get(hexKey(col, row)).footprintHexes = [fpKey];
      tiles.get(fpKey).buildingFootprintOf = hexKey(col, row);
    } else {
      // No eligible neighbour (e.g. wedged against the river / map edge / other
      // buildings). Roll back the placement — the map ends up one building
      // fewer, which is expected and operator-accepted.
      const t = tiles.get(hexKey(col, row));
      const p = placement.prior;
      t.base = p.base;
      t.structure = p.structure;
      t.path = p.path;
      t.building = p.building;
      t.fortifyLevel = p.fortifyLevel;
      t.footprintHexes = p.footprintHexes;
      t.buildingFootprintOf = p.buildingFootprintOf;
      placement.rolledBack = true;
    }
  }

  // Drop rolled-back placements everywhere downstream. The placement objects in
  // `villageGroups` are the SAME references as in `villagePlacements`, so the
  // `rolledBack` tag is visible there too — clean those groups up (re-rooting a
  // village whose root was rolled back) before they drive the road network.
  const buildingPlacements = allBuildingPlacements.filter(p => !p.rolledBack);
  // Number of placements dropped because no eligible footprint hex was found
  // (building wedged against the river / map edge / other buildings). Surfaced
  // on the return for test/diagnostic use; consumers ignore unknown fields.
  const buildingRollbacks = allBuildingPlacements.length - buildingPlacements.length;
  for (const g of villageGroups) {
    g.members = g.members.filter(m => !m.rolledBack);
    if (g.root && g.root.rolledBack) g.root = g.members.shift() ?? null;
  }

  // 4. Grow forest clusters and scatter dirt patches BEFORE the road network.
  //    This is the payoff of the layered tile model: because `placeRoadPath`
  //    preserves the base material (P2), routing the MST over forest/dirt now
  //    yields roads that keep base=FOREST / base=DIRT under the road deck
  //    (operator-locked: roads PRESERVE whatever terrain they cross). Forest
  //    and dirt grow only on plain grass — building tiles report BUILDING and
  //    river tiles report RIVER, so both are skipped automatically and no
  //    building ever ends up on a forest base.

  // 4a. Grow forest clusters from seeds
  for (const seed of cfg.forestSeeds) {
    const neighbors = getNeighbors(seed.col, seed.row);
    const candidates = [seed, ...neighbors];
    for (const { col, row } of candidates) {
      const t = tiles.get(hexKey(col, row));
      if (t && legacyTileType(t) === TileType.GRASS && rand() < 0.70) {
        // Forest is a BASE material change (no path/structure on these grass tiles).
        t.base = TileType.FOREST;
        for (const n of getNeighbors(col, row)) {
          const t2 = tiles.get(hexKey(n.col, n.row));
          if (t2 && legacyTileType(t2) === TileType.GRASS && rand() < 0.40) {
            t2.base = TileType.FOREST;
          }
        }
      }
    }
  }

  // 4b. Scatter small dirt/gravel patches for visual texture
  for (let i = 0; i < 10; i++) {
    const grassTiles = [];
    for (const [, t] of tiles) {
      if (legacyTileType(t) === TileType.GRASS && t.col >= 1 && t.col <= MAP_COLS - 2) grassTiles.push(t);
    }
    shuffle(grassTiles, rand);
    if (grassTiles.length === 0) break;
    const seedTile = grassTiles[0];
    // Dirt patches are a BASE material change on grass tiles.
    seedTile.base = TileType.DIRT;
    const spreadNeighbors = shuffle(
      getNeighbors(seedTile.col, seedTile.row)
        .map(n => tiles.get(hexKey(n.col, n.row)))
        .filter(t => t && legacyTileType(t) === TileType.GRASS),
      rand
    );
    for (const n of spreadNeighbors.slice(0, Math.floor(rand() * 3))) {
      n.base = TileType.DIRT;
    }
  }

  // 5. Two-tier road network — avoids the dense web produced by running MST on
  //    every building when many are clustered tightly in the same village.
  //
  //    Tier 1 — intra-village spokes: each building connects to its village's root
  //    (first-placed = closest to centre). Produces a clean star shape per village.
  //
  //    Tier 2 — inter-village trunk: Kruskal's MST on key points only
  //    (INN, GRAVEYARD, one root per village).  Long roads between settlements,
  //    none of the short overlapping paths within them.
  const roadEdges = [];

  // Tier 1: spoke per building → village root (skip villages emptied by rollback)
  for (const { root, members } of villageGroups) {
    if (!root) continue;
    for (const m of members) roadEdges.push({ from: root, to: m });
  }

  // Tier 2: MST on key points + pre-selected river crossings. Exclude any
  // rolled-back corner building and any village emptied by rollback (null root).
  const keyPoints = [
    ...cornerPlacements.filter(p => !p.rolledBack),
    ...villageGroups.map(v => v.root).filter(Boolean),
  ];

  // Pre-select river crossing points and convert them to bridges.
  // Each crossing also carries a chosen leftBank/rightBank — passable land
  // tiles on opposite sides of the river.  We add BOTH banks as MST key
  // points so the spanning tree is forced to connect each side individually,
  // rather than letting a bridge become a one-sided MST leaf.  An explicit
  // leftBank→rightBank edge is queued first so BFS routes the actual river
  // crossing through the bridge while the road grid is still empty.
  const crossings = _pickRiverCrossings(rand, tiles, riverPath, riverMap, riverEW, keyPoints, cfg.minBridges ?? 1, cfg.bridgeMax);
  for (const c of crossings) {
    const t = tiles.get(hexKey(c.col, c.row));
    // Pre-place a bridge over the river crossing — path overlay only, the
    // (grass) base under the water is preserved.
    if (t) t.path = PathType.BRIDGE;
  }

  for (const c of crossings) {
    keyPoints.push(c.leftBank, c.rightBank);
  }

  // Inter-village trunk: Kruskal's MST over the key points + river-crossing banks.
  const interEdges = buildMST(keyPoints);

  // Prepend bank-to-bank edges so each bridge is routed through first while
  // the road grid is still empty (giving BFS a clean shortest path).
  for (const c of crossings) {
    roadEdges.push({ from: c.leftBank, to: c.rightBank });
  }
  roadEdges.push(...interEdges);

  // Tracks which tiles are already road/bridge so the weighted BFS can
  // penalise over-used hubs and route around them.
  const roadTiles = new Set();
  // Seed roadTiles with pre-placed bridges so BFS considers them connected
  for (const c of crossings) roadTiles.add(hexKey(c.col, c.row));

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
    const path = bfsPath(tiles, from.col, from.row, to.col, to.row, rand, roadTiles, true);
    // Pre-placed-bridge mode: BFS routed with blockRiver, so bridges already
    // exist at crossings — placeRoadPath just records connectivity over them.
    placeRoadPath(tiles, path, roadTiles, { convertRiverToBridge: false });
  }

  // 5b. Bridge audit & stub-road cleanup.
  // A BRIDGE MUST connect exactly two road entry/exit faces — the 3D bridge
  // model (`bridgeRotationY`) orients its plank from `roadDirs` and renders a
  // broken span for any other count. Multiple MST edges can route through the
  // same single river crossing, so a bridge can accumulate 3–4 road links.
  // Iterate until stable over three steps that can cascade into one another:
  //   (a) prune ROAD tiles that became dead-ends (degree ≤ 1, not next to a
  //       building);
  //   (b) normalise any BRIDGE with >2 road links down to a single
  //       opposite-bank span (keep one left + one right, drop the extras —
  //       the dropped approach roads then prune as stubs);
  //   (c) revert BRIDGE tiles to RIVER if their roadDirs no longer reach both
  //       river banks (covers degree 0/1 and one-sided bridges).
  const isAdjacentToBuilding = (col, row) => {
    for (const n of getNeighbors(col, row)) {
      const nt = tiles.get(hexKey(n.col, n.row));
      if (nt && hasBuilding(nt)) return true;
    }
    return false;
  };

  let changed = true;
  let iters = 0;
  while (changed && iters++ < 20) {
    changed = false;

    // Prune stub roads (degree ≤ 1, not next to a building).
    for (const t of tiles.values()) {
      if (pathOf(t) !== PathType.ROAD) continue;
      if (t.roadDirs.size > 1) continue;
      if (isAdjacentToBuilding(t.col, t.row)) continue;
      const nextKey = [...t.roadDirs][0];
      // Strip the road path. Forest/dirt now grow BEFORE roads, so the tile's
      // base may be grass, forest, or dirt — clearing the path correctly
      // reverts it to whatever terrain the road was laid over (the base layer
      // was never touched when the road was placed).
      t.path = null;
      t.roadDirs.clear();
      roadTiles.delete(hexKey(t.col, t.row));
      if (nextKey) tiles.get(nextKey)?.roadDirs.delete(hexKey(t.col, t.row));
      changed = true;
    }

    // Normalise each bridge to a single STRAIGHT opposite-edge span. A bridge
    // must enter and exit on opposite hex edges (entry edge `d`, exit edge
    // `(d+3)%6`) so the 3D plank spans straight rather than skewing across the
    // hex. Among the bridge's current road links, find the opposite-edge pair
    // that also straddles both river banks; keep exactly that pair and drop the
    // rest. We prefer the crossing's originally-designated banks, then a
    // deterministic sorted tiebreak, so same-seed maps stay reproducible.
    // Dropped approaches become stubs and prune on the next pass. A bridge with
    // no opposite-edge cross-bank pair is left for step (c) to revert to river.
    for (const c of crossings) {
      const t = tiles.get(hexKey(c.col, c.row));
      if (!t || !isBridge(t) || t.roadDirs.size < 2) continue;
      const bridgeKey = hexKey(c.col, c.row);
      const desiredLeft  = hexKey(c.leftBank.col, c.leftBank.row);
      const desiredRight = hexKey(c.rightBank.col, c.rightBank.row);

      // Bucket links by river side, sorted for determinism.
      const leftLinks = [], rightLinks = [];
      for (const nk of t.roadDirs) {
        const [nc, nr] = nk.split(',').map(Number);
        (riverSide(nc, nr, riverMap, riverEW) === 'left' ? leftLinks : rightLinks).push(nk);
      }
      leftLinks.sort();
      rightLinks.sort();
      // Designated bank first (when present), so a clean crossing keeps its
      // intended span; otherwise the sorted order gives a stable tiebreak.
      const orderBank = (links, desired) =>
        links.includes(desired) ? [desired, ...links.filter(k => k !== desired)] : links;
      const lefts  = orderBank(leftLinks, desiredLeft);
      const rights = orderBank(rightLinks, desiredRight);

      // Find the first left/right pair on opposite hex edges (straight span).
      let keepLeft, keepRight;
      pick: for (const lk of lefts) {
        const [lc, lr] = lk.split(',').map(Number);
        for (const rk of rights) {
          const [rc2, rr2] = rk.split(',').map(Number);
          if (edgesAreOpposite(c.col, c.row, lc, lr, rc2, rr2)) {
            keepLeft = lk; keepRight = rk; break pick;
          }
        }
      }
      // No straight cross-bank pair — leave it for the straightening pass
      // below (and, failing that, step (c)'s revert).
      if (keepLeft === undefined || keepRight === undefined) continue;
      const keep = new Set([keepLeft, keepRight]);
      for (const nk of [...t.roadDirs]) {
        if (keep.has(nk)) continue;
        t.roadDirs.delete(nk);
        tiles.get(nk)?.roadDirs.delete(bridgeKey);
        changed = true;
      }
    }

    // Straighten bent two-sided bridges by re-routing one approach. A bridge can
    // be connected to BOTH river banks yet have no opposite-edge pair among its
    // current links (the straight bank tile pruned away as a stub, leaving a
    // skewed approach). Rather than discard the whole crossing — which can
    // starve the map below `minBridges` — re-route the connected side onto the
    // STRAIGHT exit edge so the span becomes opposite-edge while staying linked
    // to the existing road network.
    //
    // For an anchor link on edge `d`, the straight exit is the neighbour on edge
    // `(d+3)%6`. We splice that straight tile into the road grid iff it is
    // passable land already wired to the network on its own bank (it is, or is
    // adjacent to, an existing road tile on its river side). All choices are
    // deterministic (sorted candidates) so same-seed maps stay reproducible.
    for (const c of crossings) {
      const t = tiles.get(hexKey(c.col, c.row));
      if (!t || !isBridge(t) || t.roadDirs.size < 2) continue;
      const bridgeKey = hexKey(c.col, c.row);

      // Already straight? Skip.
      const links = [...t.roadDirs];
      const hasStraight = links.some((ka, i) => links.some((kb, j) => {
        if (i >= j) return false;
        const [ac, ar] = ka.split(',').map(Number);
        const [bc, br] = kb.split(',').map(Number);
        return edgesAreOpposite(c.col, c.row, ac, ar, bc, br);
      }));
      if (hasStraight) continue;

      // Must already touch both river sides — we only re-shape a genuinely
      // two-sided crossing, never fabricate a bridge that doesn't span.
      const sideOf = (k) => { const [nc, nr] = k.split(',').map(Number); return riverSide(nc, nr, riverMap, riverEW); };
      if (!links.some(k => sideOf(k) === 'left') || !links.some(k => sideOf(k) === 'right')) continue;

      // A candidate straight tile is wired-in iff it is itself road, or borders
      // an existing road tile on its own river side (so adding it doesn't create
      // a fresh stub that prunes next pass).
      const wiredIn = (col, row, side) => {
        const k = hexKey(col, row);
        if (roadTiles.has(k)) return true;
        for (const n of getNeighbors(col, row)) {
          const nk = hexKey(n.col, n.row);
          if (nk === bridgeKey) continue;
          if (!roadTiles.has(nk)) continue;
          if (riverSide(n.col, n.row, riverMap, riverEW) !== side) continue;
          return true;
        }
        return false;
      };

      // Try each existing anchor link; route its straight opposite edge.
      let straightened = false;
      for (const anchor of [...links].sort()) {
        const [anc, anr] = anchor.split(',').map(Number);
        const d = neighborDirIndex(c.col, c.row, anc, anr);
        if (d < 0) continue;
        const opp = (d + 3) % 6;
        // Resolve the neighbour on the opposite edge.
        const sNbr = getNeighbors(c.col, c.row).find(n => neighborDirIndex(c.col, c.row, n.col, n.row) === opp);
        if (!sNbr) continue;
        const sTile = tiles.get(hexKey(sNbr.col, sNbr.row));
        if (!sTile || isRiver(sTile) || isBuildingFootprint(sTile)) continue;
        const anchorSide = sideOf(anchor);
        const sSide = riverSide(sNbr.col, sNbr.row, riverMap, riverEW);
        if (sSide === anchorSide) continue; // straight exit must reach the far bank
        if (!wiredIn(sNbr.col, sNbr.row, sSide)) continue;

        // Commit: lay road on the straight tile (preserving base material), wire
        // it to its existing same-side road, then re-link the bridge to just
        // {anchor, straightTile}. Bent links drop and prune next pass.
        const sKey = hexKey(sNbr.col, sNbr.row);
        if (pathOf(sTile) === null && !hasBuilding(sTile)) sTile.path = PathType.ROAD;
        roadTiles.add(sKey);
        // Connect the straight tile onward to a same-side road neighbour.
        for (const n of getNeighbors(sNbr.col, sNbr.row)) {
          const nk = hexKey(n.col, n.row);
          if (nk === bridgeKey || nk === sKey) continue;
          if (!roadTiles.has(nk)) continue;
          if (riverSide(n.col, n.row, riverMap, riverEW) !== sSide) continue;
          sTile.roadDirs.add(nk);
          tiles.get(nk)?.roadDirs.add(sKey);
          break;
        }
        // Re-link the bridge to exactly {anchor, straightTile}.
        for (const nk of [...t.roadDirs]) {
          if (nk === anchor) continue;
          t.roadDirs.delete(nk);
          tiles.get(nk)?.roadDirs.delete(bridgeKey);
        }
        t.roadDirs.add(sKey);
        sTile.roadDirs.add(bridgeKey);
        changed = true;
        straightened = true;
        break;
      }
      // If we couldn't straighten, step (c) reverts it to river.
      void straightened;
    }

    // Revert bridges that are NOT a straight, two-link, both-banks span. This
    // covers one-sided/unreached bridges (degree 0/1, single river side) AND
    // any bent span step (b) couldn't straighten — both render as a broken plank
    // and must become plain river. minBridges is protected by candidate
    // sourcing (opposite-edge crossings are preferred) plus the relax pass in
    // `_pickRiverCrossings`; the seed-sweep tests assert the floor still holds.
    for (const c of crossings) {
      const t = tiles.get(hexKey(c.col, c.row));
      if (!t || !isBridge(t)) continue;
      let leftSide = false, rightSide = false;
      for (const nk of t.roadDirs) {
        const [nc, nr] = nk.split(',').map(Number);
        if (riverSide(nc, nr, riverMap, riverEW) === 'left') leftSide = true;
        else rightSide = true;
      }
      // Straight iff exactly two links AND they sit on opposite hex edges.
      let straight = false;
      if (t.roadDirs.size === 2 && leftSide && rightSide) {
        const [ka, kb] = [...t.roadDirs];
        const [ac, ar] = ka.split(',').map(Number);
        const [bc, br] = kb.split(',').map(Number);
        straight = edgesAreOpposite(c.col, c.row, ac, ar, bc, br);
      }
      if (straight) continue;
      const stubStarts = [...t.roadDirs];
      // Revert the bridge back to plain river — path overlay only, base intact.
      t.path = PathType.RIVER;
      t.roadDirs.clear();
      roadTiles.delete(hexKey(c.col, c.row));
      for (const nk of stubStarts) tiles.get(nk)?.roadDirs.delete(hexKey(c.col, c.row));
      changed = true;
    }
  }

  // Building reconnect repair. Straightening a bridge can drop a bent road link
  // that was a building's ONLY connection to the road grid (the building hung off
  // the bridge's now-removed approach). The 3D renderer requires every building
  // to carry ≥1 roadDirs entry to draw its road ribbon, so re-wire any building
  // left with zero links to an adjacent PLAIN-ROAD tile (or an already-wired
  // neighbouring building). Deterministic: pick the lowest-sorted eligible
  // neighbour. We deliberately never re-link to a BRIDGE tile — that would add a
  // third road face and break the just-straightened opposite-edge span — and we
  // only fire when the building still borders the network, never fabricating a
  // connection across a gap.
  for (const t of tiles.values()) {
    if (!hasBuilding(t) || t.roadDirs.size > 0) continue;
    const bKey = hexKey(t.col, t.row);
    const cands = getNeighbors(t.col, t.row)
      .map(n => ({ key: hexKey(n.col, n.row) }))
      .filter(({ key }) => {
        const nt = tiles.get(key);
        if (!nt || isBridge(nt)) return false;
        // Re-attach to a plain road tile, or to a building already on the grid.
        return (roadTiles.has(key) && pathOf(nt) === PathType.ROAD)
            || (hasBuilding(nt) && nt.roadDirs.size > 0);
      })
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    if (cands.length === 0) continue;
    const { key } = cands[0];
    t.roadDirs.add(key);
    tiles.get(key)?.roadDirs.add(bKey);
  }

  // Hard post-gen invariant: every surviving bridge now has exactly two
  // reciprocal road links on opposite river banks. The 3D bridge model's
  // plank orientation is derived from `roadDirs`, so any other count renders
  // a broken / floating span — there's no graceful degrade for a wrong
  // count. The cleanup pass above is supposed to guarantee this. If a
  // future change reintroduces a hole, fail LOUDLY here rather than ship a
  // broken-looking map; the regression suite (`tests/bridge-invariants.test.js`,
  // `tests/map-bridges.test.js`) sweeps the seed range to keep this assert
  // from ever firing in practice.
  assertMapInvariants(tiles);

  // 5b. Derive sub-hex blocked slots now that forests, bridges, and the road
  //     network are final. Forest trees avoid the road faces; bridges block all
  //     non-road slots. Runs before node/survivor placement so any capacity
  //     check downstream sees the reduced bridge capacity.
  for (const t of tiles.values()) {
    t.blockedSlots = deriveBlockedSlots(t);
  }

  // 6. Place witch objectives — well-spread, guaranteed across both sides of the river,
  //    with 3-hex clusters and minimum distance from starting positions.
  const buildingKeys = new Set(buildingPlacements.map(b => hexKey(b.col, b.row)));
  // Also forbid building-footprint hexes as node centers/satellites. Footprints
  // carry `buildingFootprintOf` (not `building`), so `hasBuilding()` is false for
  // them — without this, a node could land on a footprint that becomes
  // impassable (P3), leaving the node unreachable and uncontestable.
  for (const [k, t] of tiles) {
    if (isBuildingFootprint(t)) buildingKeys.add(k);
  }
  // Extract start positions now (buildings are placed; INN = hero start, GRAVEYARD = witch start)
  const heroStart  = buildingPlacements.find(b => b.building === BuildingType.INN)
                  || buildingPlacements[0];
  const witchStart = buildingPlacements.find(b => b.building === BuildingType.GRAVEYARD)
                  || buildingPlacements[buildingPlacements.length - 1];
  const startPositions = [heroStart, witchStart];

  // Coerce the override defensively (depth behind the server boundary): a non-finite
  // value (NaN, "banana", {}, [] from a hostile client) would otherwise clamp to NaN
  // here, which _pickNodesAcrossRiver treats as "place as many as possible" (its
  // `count >= 2` / `placed.length >= count` guards both fail on NaN) — an unintended
  // max-out. Only a genuine number or numeric string is honored; everything else
  // (incl. null/undefined and empty/nullish shapes that `+x` would coerce to 0) means
  // "no override" → the size default. Finite values floor + clamp into the band.
  const numericOverride = _coerceNodeCountOverride(nodeCountOverride);
  const resolvedNodeCount = (numericOverride != null)
    ? Math.max(cfg.nodeCountMin ?? 1, Math.min(cfg.nodeCountMax ?? cfg.nodeCount, numericOverride))
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

  const season = SEASONS[Math.floor(rand() * SEASONS.length)];

  return { tiles, witchObjectives, heroStart, witchStart, mapSize, seed, season, survivorCounts: cfg.survivorCounts, buildingRollbacks };
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
      if (!t || isRiver(t)) continue;
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
 * First N players (up to building count) spawn at faction buildings (INN for hero,
 * GRAVEYARD for witch). Beyond that, overflow players get a neighboring tile of each
 * building, cycling through the sequence.
 *
 * @param {Map<string,Tile>} tiles
 * @param {'hero'|'witch'} faction
 * @param {number} count
 * @param {number} [minSep=2]  (kept for API compat; not used by building-based logic)
 * @returns {{ col: number, row: number }[]}
 */
export function generateBattleStarts(tiles, faction, count, minSep = 2) {
  const targetBuilding = faction === 'hero' ? BuildingType.INN : BuildingType.GRAVEYARD;

  // Find all faction buildings on the map
  const buildings = [];
  for (const [, t] of tiles) {
    if (hasBuilding(t) && t.building === targetBuilding) {
      buildings.push({ col: t.col, row: t.row });
    }
  }

  // Fallback: if no faction buildings found (e.g. non-battle map), use edge-column logic
  if (buildings.length === 0) {
    const cols = faction === 'hero' ? [0, 1, 2] : [MAP_COLS - 3, MAP_COLS - 2, MAP_COLS - 1];
    const candidates = [];
    for (const [, t] of tiles) {
      if (!cols.includes(t.col)) continue;
      if (isRiver(t)) continue;
      candidates.push({ col: t.col, row: t.row });
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const placed = [];
    for (const cand of candidates) {
      if (placed.length >= count) break;
      if (!placed.some(p => hexDistance(cand.col, cand.row, p.col, p.row) < minSep)) {
        placed.push({ col: cand.col, row: cand.row });
      }
    }
    return placed;
  }

  const placed = [];
  const usedKeys = new Set();

  for (let i = 0; i < count; i++) {
    const bldg = buildings[i % buildings.length];
    if (i < buildings.length) {
      // First pass: spawn at the building itself
      placed.push({ col: bldg.col, row: bldg.row });
      usedKeys.add(hexKey(bldg.col, bldg.row));
    } else {
      // Overflow: pick a passable neighbor of the building not already used
      const neighbors = getNeighbors(bldg.col, bldg.row);
      let found = false;
      for (const n of neighbors) {
        const k = hexKey(n.col, n.row);
        if (usedKeys.has(k)) continue;
        const t = tiles.get(k);
        if (!t || isRiver(t)) continue;
        placed.push({ col: n.col, row: n.row });
        usedKeys.add(k);
        found = true;
        break;
      }
      // Fallback: place at the building itself
      if (!found) placed.push({ col: bldg.col, row: bldg.row });
    }
  }

  return placed;
}
