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

import { Tile, TileType, BuildingType, ResourceType } from '../tiles.js';
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
function _applyTileDef(tile, def) {
  if (def.type != null) tile.type = _resolveEnum(TileType, def.type);
  if ('building' in def) tile.building = _resolveEnum(BuildingType, def.building);
  if ('resource' in def) tile.resource = _resolveEnum(ResourceType, def.resource);
  if (def.fortifyLevel != null) tile.fortifyLevel = def.fortifyLevel;
  if (def.hiddenSurvivor != null) tile.hiddenSurvivor = !!def.hiddenSurvivor;
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

// Re-derive the ROAD layer from a road-node set, in place.
//
// Clears existing ROAD tiles (back to GRASS) and every tile's roadDirs, keeps
// BRIDGE tiles untouched, then lays a fresh MST over the node list using the
// same primitives + invocation style as the procedural generator
// (blockRiver BFS + convertRiverToBridge:false / pre-placed-bridge semantics).
// No new bridges are created, so bridges only ever sit over the river crossings
// the base map already placed.
function _rederiveRoads(tiles, nodeKeys, rand) {
  // Reset: ROAD → GRASS, clear all connectivity. Bridges stay as crossings.
  for (const t of tiles.values()) {
    if (t.type === TileType.ROAD) t.type = TileType.GRASS;
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
    if (t.type === TileType.BRIDGE) roadTiles.add(hexKey(t.col, t.row));
  }

  for (const { from, to } of buildMST(nodes)) {
    const path = bfsPath(tiles, from.col, from.row, to.col, to.row, rand, roadTiles, true);
    placeRoadPath(tiles, path, roadTiles, { convertRiverToBridge: false });
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
    if (t.type === TileType.BUILDING || t.type === TileType.BRIDGE) {
      roadNodes.add(hexKey(t.col, t.row));
    }
  }

  // 3. Re-derive roads from the node set.
  _rederiveRoads(tiles, roadNodes, rng((mapDef.seed ?? 0) + 1));

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
