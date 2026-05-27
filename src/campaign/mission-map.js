// ═══════════════════════════════════════════════════════════════════════════
// Data-driven mission-map builder
// ─────────────────────────────────────────────────────────────────────────────
// `buildMissionMap(mapDef)` turns a declarative `map` sub-object (from a JSON
// mission def) into the SAME shape the imperative `buildXMap()` functions and
// `generateMap()` return:
//
//   { tiles, heroStart, witchStart, witchObjectives, mapSize, survivorCounts,
//     cols, rows }
//
// Two modes:
//   • "handmade"   — full explicit tile list (lossless snapshot of a bespoke
//                    map). roadDirs are persisted in the def so roads load
//                    without a regen.
//   • "procedural" — a seeded `generateMap()` base plus an overlay that replaces
//                    individual tiles, edits the road-node set (roads are then
//                    re-derived via the shared road builder), and applies
//                    start / hidden-survivor / objective deltas.
//
// The road-graph source of truth is the road-node set: buildings and bridges
// are implicitly nodes; the overlay toggles additional tiles on/off. See
// docs/design/campaign-mission-editor.md → "map sub-schema".
// ═══════════════════════════════════════════════════════════════════════════

import { Tile, TileType, BuildingType, ResourceType, PathType, StructureType, decomposeTileType, hasBuilding, isBridge, pathOf } from '../tiles.js';
import { hexKey, setMapDimensions } from '../hex.js';
import { generateMap, rng, bfsPath } from '../map.js';
import { buildMST, placeRoadPath } from '../road-network.js';

// Resolve an enum reference that may be written either as the uppercase enum
// KEY ("BUILDING", "CHURCH", "HERBS") — the schema's preferred form — or as the
// raw enum VALUE ("building", "church", "herbs"). Returns null for null/empty.
function _resolveEnum(enumObj, v) {
  if (v == null || v === '') return null;
  if (Object.prototype.hasOwnProperty.call(enumObj, v)) return enumObj[v];
  return v; // already a value (or unknown — pass through verbatim)
}

// Merge a tile-def's fields onto a Tile instance, mapping enum strings and
// converting a roadDirs array of "col,row" strings into a Set.
//
// Two on-disk tile shapes are accepted:
//   • Layered (canonical, P5+): explicit `base` / `structure` / `path` fields
//     (uppercase enum KEYs — GRASS/FOREST/DIRT, BUILDING, ROAD/RIVER/BRIDGE).
//     Each layer is set directly; a missing/null structure or path means "none".
//   • Legacy (type-only): a single `type` field (uppercase TileType KEY). Falls
//     back to the P0 `set type()` shim, which decomposes it into the three
//     layers. Both shapes therefore reconstruct an identical Tile.
function _applyTileDef(tile, def) {
  const hasLayers = 'base' in def || 'structure' in def || 'path' in def;
  if (hasLayers) {
    if ('base' in def) tile.base = _resolveEnum(TileType, def.base) ?? TileType.GRASS;
    tile.structure = 'structure' in def ? _resolveEnum(StructureType, def.structure) : null;
    tile.path = 'path' in def ? _resolveEnum(PathType, def.path) : null;
  } else if (def.type != null) {
    decomposeTileType(tile, _resolveEnum(TileType, def.type));
  }
  if ('building' in def) tile.building = _resolveEnum(BuildingType, def.building);
  if ('resource' in def) tile.resource = _resolveEnum(ResourceType, def.resource);
  if (def.fortifyLevel != null) tile.fortifyLevel = def.fortifyLevel;
  if (def.hiddenSurvivor != null) tile.hiddenSurvivor = !!def.hiddenSurvivor;
  // Carry the editor-authored specific-survivor pin (roster name) so the
  // discovery spawn can materialise THAT survivor instead of random-picking.
  if (def.hiddenSurvivorId != null) tile.hiddenSurvivorId = def.hiddenSurvivorId;
  if (Array.isArray(def.roadDirs)) tile.roadDirs = new Set(def.roadDirs);
  return tile;
}

// ── Handmade ─────────────────────────────────────────────────────────────────

function _buildHandmade(mapDef) {
  const cols = mapDef.cols;
  const rows = mapDef.rows;
  setMapDimensions(cols, rows);

  // Start from a full grass grid so unspecified tiles are still valid Tiles,
  // then overlay each explicit tile def.
  const tiles = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.set(hexKey(col, row), new Tile(col, row, TileType.GRASS));
    }
  }

  for (const def of mapDef.tiles ?? []) {
    const k = hexKey(def.col, def.row);
    const tile = tiles.get(k) ?? new Tile(def.col, def.row, TileType.GRASS);
    _applyTileDef(tile, def);
    tiles.set(k, tile);
  }

  return {
    tiles,
    heroStart: mapDef.heroStart ?? null,
    witchStart: mapDef.witchStart ?? null,
    witchObjectives: mapDef.witchObjectives ?? [],
    mapSize: mapDef.mapSize ?? 'skirmish',
    survivorCounts: mapDef.survivorCounts ?? { buildings: 0, terrain: 0 },
    cols,
    rows,
  };
}

// ── Procedural + overlay ───────────────────────────────────────────────────────

// Default bridge budget for handmade (`bridgeRivers:true`) regen. Generous
// enough for a hand-authored map with several road nodes straddling a river,
// but capped so a pathological MST can't pave the whole waterway.
const HANDMADE_MAX_BRIDGES = 8;

// Re-derive the ROAD layer from a road-node set, in place.
//
// Clears existing ROAD tiles (back to GRASS) and every tile's roadDirs, keeps
// BRIDGE tiles untouched, then lays a fresh MST over the node list.
//
// Two river-crossing modes, selected by `opts.bridgeRivers`:
//
//   • bridgeRivers:true  (DEFAULT — handmade editor regen) — rivers do NOT
//     block BFS; a RIVER tile the path crosses is converted to BRIDGE inline
//     (up to `opts.maxBridges`), exactly like `buildRoadNetwork`. Handmade /
//     editor maps have NO pre-placed bridges, so without this two road nodes on
//     opposite banks could never connect — the MST edge had no legal crossing.
//
//   • bridgeRivers:false (procedural overlay regen) — the legacy
//     generateMap-style behaviour: blockRiver BFS routes AROUND rivers and
//     `convertRiverToBridge:false` creates no new bridges, so bridges only ever
//     sit over the river crossings the generated base map already placed. The
//     procedural overlay sits over such a base, so its output is unchanged.
//
// `bridgeRivers` DEFAULTS TO true so the mission editor's untouched
// `regenerateHandmadeRoads` call bridges by default; the procedural overlay
// path in `_buildProcedural` explicitly opts out (`bridgeRivers:false`).
//
// Exported so the mission editor can run the same regen on a handmade map and
// snapshot the derived roadDirs back into the tile defs (see P5 "Regenerate
// Roads then snapshot" — handmade roads have no load-time regen, so the editor
// must persist them).
export function rederiveRoads(tiles, nodeKeys, rand, opts = {}) {
  const { bridgeRivers = true, maxBridges = HANDMADE_MAX_BRIDGES } = opts;

  // Reset: ROAD → GRASS, clear all connectivity. Bridges stay as crossings.
  for (const t of tiles.values()) {
    if (pathOf(t) === PathType.ROAD) decomposeTileType(t, TileType.GRASS);
    t.roadDirs = new Set();
  }

  const nodes = [];
  for (const k of nodeKeys) {
    const t = tiles.get(k);
    if (t) nodes.push({ col: t.col, row: t.row });
  }
  if (nodes.length < 2) return;

  // Seed roadTiles with pre-placed bridges so BFS treats them as part of the
  // road grid (matching generateMap's bridge handling).
  const roadTiles = new Set();
  for (const t of tiles.values()) {
    if (isBridge(t)) roadTiles.add(hexKey(t.col, t.row));
  }

  // bridgeRivers:true  → rivers are passable (blockRiver=false) and crossings
  //                      become bridges (convertRiverToBridge=true, budgeted).
  // bridgeRivers:false → legacy: route around rivers, place no new bridges.
  let bridgesPlaced = 0;
  for (const { from, to } of buildMST(nodes)) {
    const path = bfsPath(tiles, from.col, from.row, to.col, to.row, rand, roadTiles, !bridgeRivers);
    bridgesPlaced = placeRoadPath(tiles, path, roadTiles, {
      convertRiverToBridge: bridgeRivers,
      maxBridges,
      bridgesPlaced,
    });
  }
}

function _buildProcedural(mapDef) {
  const base = generateMap(mapDef.seed, mapDef.mapSize ?? 'standard', mapDef.nodeCount ?? null);
  const tiles = base.tiles;
  const overlay = mapDef.overlay ?? {};

  // 1. Replace base tiles with overlay tile defs (field-merge).
  for (const def of overlay.tiles ?? []) {
    const k = hexKey(def.col, def.row);
    const tile = tiles.get(k) ?? new Tile(def.col, def.row, TileType.GRASS);
    _applyTileDef(tile, def);
    tiles.set(k, tile);
  }

  // 2. Build the road-node set: buildings + bridges are implicit nodes; the
  //    overlay adds/removes extra waypoints. Buildings/bridges are unioned last
  //    so an over-eager `remove` can never strip a building/bridge node.
  const roadNodes = new Set();
  const rn = overlay.roadNodes ?? {};
  for (const k of rn.add ?? []) roadNodes.add(k);
  for (const k of rn.remove ?? []) roadNodes.delete(k);
  for (const t of tiles.values()) {
    if (hasBuilding(t) || isBridge(t)) {
      roadNodes.add(hexKey(t.col, t.row));
    }
  }

  // 3. Re-derive roads from the node set. The procedural base already has its
  //    rivers + pre-placed bridges, so opt OUT of inline bridging
  //    (bridgeRivers:false) to keep overlay road output byte-identical.
  rederiveRoads(tiles, roadNodes, rng((mapDef.seed ?? 0) + 1), { bridgeRivers: false });

  // 4. Apply deltas.
  const hidden = overlay.hiddenSurvivors ?? {};
  for (const k of hidden.add ?? []) {
    const t = tiles.get(k);
    if (t) t.hiddenSurvivor = true;
  }
  for (const k of hidden.remove ?? []) {
    const t = tiles.get(k);
    if (t) t.hiddenSurvivor = false;
  }

  return {
    tiles,
    heroStart: overlay.heroStart ?? base.heroStart,
    witchStart: overlay.witchStart ?? base.witchStart,
    witchObjectives: overlay.witchObjectives ?? base.witchObjectives,
    mapSize: base.mapSize,
    survivorCounts: base.survivorCounts,
    cols: _maxDim(tiles, 'col'),
    rows: _maxDim(tiles, 'row'),
  };
}

// Derive cols/rows from the tile map (max index + 1) — generateMap doesn't
// return them but downstream callers expect them on the result.
function _maxDim(tiles, axis) {
  let max = -1;
  for (const t of tiles.values()) if (t[axis] > max) max = t[axis];
  return max + 1;
}

/**
 * Build a mission map from a declarative `map` sub-object.
 *
 * @param {object} mapDef — `mode: "handmade"` or `mode: "procedural"`.
 * @returns {{ tiles: Map<string, Tile>, heroStart: object, witchStart: object,
 *             witchObjectives: object[], mapSize: string,
 *             survivorCounts: object, cols: number, rows: number }}
 */
export function buildMissionMap(mapDef) {
  if (!mapDef || typeof mapDef !== 'object') {
    throw new Error('buildMissionMap: mapDef is required');
  }
  switch (mapDef.mode) {
    case 'handmade':
      return _buildHandmade(mapDef);
    case 'procedural':
      return _buildProcedural(mapDef);
    default:
      throw new Error(`buildMissionMap: unknown map mode "${mapDef.mode}"`);
  }
}
