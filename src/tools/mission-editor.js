// ═══════════════════════════════════════════════════════════════════════════
// Mission editor — core model + edit loop (DOM-free)
// ─────────────────────────────────────────────────────────────────────────────
// This module is the *logic* half of the Campaign Mission Editor (P5). It owns
// the working `mapDef` (the P1 map sub-schema), the sibling `enemyUnits` list,
// editor UI state (active tool, paint selections), and an undo stack. It is
// deliberately DOM-free: the controller takes an injected `render` callback so
// the whole edit loop can be unit-tested without a canvas/Renderer. The thin
// canvas + palette wiring lives in `mission-editor-ui.js`.
//
// CONSISTENCY RULES mirrored from the P1 builder (break these and missions
// silently corrupt — see docs/design/campaign-mission-editor.md):
//   1. Tile defs are always COMPLETE — every field present with explicit nulls.
//      buildMissionMap FIELD-MERGES tiles, so a partial def would leave stale
//      fields from the grass base.
//   2. Buildings & bridges are ALWAYS structural road-graph nodes. To drop one
//      from the graph you change its TILE TYPE — never its road-node membership.
//      "Mark Road Node" only manages EXTRA authored waypoints.
//   3. Handmade roads have no load-time regen, so "Regenerate Roads" must run the
//      derivation AND snapshot the resulting roadDirs back into the tile defs,
//      or roads vanish on reload. (regen-then-snapshot.)
//   4. Enum fields are emitted in uppercase KEY form ("BUILDING", "INN", "HERBS").
//      enemyUnits keep the runtime lowercase `type` ("zombie") — they are a
//      pass-through to the existing runtime shape, not a map enum.
// ═══════════════════════════════════════════════════════════════════════════

import {
  TileType, BuildingType, ResourceType, PathType, StructureType,
  baseOf, pathOf, structureOf, hasBuilding, isBridge,
} from '../tiles.js';
import { hexKey } from '../hex.js';
import { rng, generateMap, MAP_SIZES } from '../map.js';
import { buildMissionMap, rederiveRoads } from '../campaign/mission-map.js';

/** Active-tool ids the click loop dispatches on. */
export const EditorTool = Object.freeze({
  // Three independent layer-paint tools (P6 tile-model refactor). Each touches
  // exactly ONE of the (base, structure, path) layers — a road can sit over a
  // forest base, a building on dirt, etc.
  PAINT_BASE: 'paint-base',           // base material: grass | forest | dirt
  PAINT_STRUCTURE: 'paint-structure', // building (BuildingType) or clear
  PAINT_PATH: 'paint-path',           // path overlay: none | road | river | bridge
  SET_RESOURCE: 'set-resource',
  HIDDEN_SURVIVOR: 'hidden-survivor',
  ENEMY_UNIT: 'enemy-unit',
  HERO_START: 'hero-start',
  WITCH_START: 'witch-start',
  ROAD_NODE: 'road-node',
  POWER_NODE: 'power-node',
});

/** Enemy unit types the placement tool can stamp (runtime lowercase values). */
export const ENEMY_UNIT_TYPES = Object.freeze([
  'zombie', 'minion', 'wood_golem', 'iron_golem',
]);

// ── Tool → VALUE-panel mapping (item 7) ──────────────────────────────────────
// The side-panel VALUE section is context-sensitive: each tool exposes exactly
// one kind of value selector (or none). The UI reads `valuePanelKind(tool)` to
// decide what to render; kept here (DOM-free) so the mapping is unit-testable.
export const ToolValueKind = Object.freeze({
  BASE: 'base',         // base-material swatches (grass/forest/dirt)
  STRUCTURE: 'structure', // building swatches + None/clear
  PATH: 'path',         // none/road/river/bridge
  RESOURCE: 'resource', // resource picker
  ENEMY: 'enemy',       // enemy unit-type picker
  NONE: 'none',         // no value — show a hint
});

const _TOOL_VALUE_KIND = Object.freeze({
  [EditorTool.PAINT_BASE]: ToolValueKind.BASE,
  [EditorTool.PAINT_STRUCTURE]: ToolValueKind.STRUCTURE,
  [EditorTool.PAINT_PATH]: ToolValueKind.PATH,
  [EditorTool.SET_RESOURCE]: ToolValueKind.RESOURCE,
  [EditorTool.ENEMY_UNIT]: ToolValueKind.ENEMY,
  [EditorTool.HIDDEN_SURVIVOR]: ToolValueKind.NONE,
  [EditorTool.HERO_START]: ToolValueKind.NONE,
  [EditorTool.WITCH_START]: ToolValueKind.NONE,
  [EditorTool.ROAD_NODE]: ToolValueKind.NONE,
  [EditorTool.POWER_NODE]: ToolValueKind.NONE,
});

/** Which VALUE-panel kind a given tool exposes. Unknown tools → NONE. */
export function valuePanelKind(tool) {
  return _TOOL_VALUE_KIND[tool] ?? ToolValueKind.NONE;
}

// ── Editor canvas layer visibility (item 6) ──────────────────────────────────
// Visibility is implemented EDITOR-SIDE (renderer.js stays untouched): the
// `base`/`roads+buildings` toggles drive a filtered display copy of the built
// tiles (stripTileOverlays); power-node / player-start visibility is applied at
// build time (omit from the rendered GameState); road-network node markers are
// drawn as an editor overlay on top of the canvas. These pure helpers describe
// the model so the toggle semantics + auto-show rule are unit-testable.

/** A fresh layer-visibility state — everything but the road-node markers on. */
export function createLayerVisibility() {
  return {
    baseOnly: false,        // when on: hide structures + paths (terrain only)
    roadsBuildings: true,   // draw the structure + path layers
    powerNodes: true,       // draw the Power-Node objectives
    playerStarts: true,     // draw the hero / witch start markers
    roadNodeMarkers: false, // draw the road-network node overlay
  };
}

/** True when the structure + path layers should be drawn for the given state. */
export function showStructures(layers) {
  return !!layers && !!layers.roadsBuildings && !layers.baseOnly;
}

/**
 * Whether the road-network node markers should be drawn. They AUTO-SHOW whenever
 * the Road Node tool is active (so authoring waypoints is always visible), and
 * are otherwise gated on the explicit `roadNodeMarkers` toggle.
 */
export function roadNodeMarkersVisible(layers, activeTool) {
  return (!!layers && !!layers.roadNodeMarkers) || activeTool === EditorTool.ROAD_NODE;
}

// Deterministic seed for handmade road regen so repeated regens are stable.
const HANDMADE_ROAD_SEED = 1337;

// ── Enum key ↔ value helpers ─────────────────────────────────────────────────

// Map an enum VALUE back to its uppercase KEY (rule #4). Passes through nulls
// and unknown values verbatim.
function _enumKey(enumObj, value) {
  if (value == null) return null;
  for (const [k, v] of Object.entries(enumObj)) if (v === value) return k;
  return value;
}

// ── Tile-def access (mode-aware) ─────────────────────────────────────────────
//
// Both modes store edits as a list of COMPLETE tile defs:
//   • handmade   → mapDef.tiles
//   • procedural → mapDef.overlay.tiles  (field-merged over the seeded base)

function _tileList(mapDef) {
  if (mapDef.mode === 'procedural') {
    if (!mapDef.overlay || typeof mapDef.overlay !== 'object') mapDef.overlay = {};
    if (!Array.isArray(mapDef.overlay.tiles)) mapDef.overlay.tiles = [];
    return mapDef.overlay.tiles;
  }
  if (!Array.isArray(mapDef.tiles)) mapDef.tiles = [];
  return mapDef.tiles;
}

// A blank, COMPLETE tile def (rule #1) — all fields explicit, in the canonical
// P5 layered shape: base/structure/path layers (NO legacy `type`). Field order
// matches the migrated mission JSONs so snapshots diff cleanly.
function _blankTileDef(col, row) {
  return {
    col, row,
    base: _enumKey(TileType, TileType.GRASS),
    structure: null,
    path: null,
    building: null,
    fortifyLevel: 0,
    resource: null,
    hiddenSurvivor: false,
    roadDirs: [],
  };
}

// Find the existing tile def at (col,row), or create+append a complete blank.
function _getOrCreateTileDef(mapDef, col, row) {
  const list = _tileList(mapDef);
  let def = list.find(t => t.col === col && t.row === row);
  if (!def) {
    def = _blankTileDef(col, row);
    list.push(def);
  }
  return def;
}

// ── Pure tool functions (mutate the mapDef in place) ─────────────────────────

const _GRASS_KEY = _enumKey(TileType, TileType.GRASS);
const _DIRT_KEY = _enumKey(TileType, TileType.DIRT);
const _BUILDING_STRUCT_KEY = _enumKey(StructureType, StructureType.BUILDING); // 'BUILDING'

/**
 * PAINT_BASE — set ONLY the base material ∈ {GRASS, FOREST, DIRT}. Does not
 * touch structure (building) or path (road/river/bridge), so e.g. re-basing a
 * road tile to forest keeps the road overlay.
 */
export function paintBase(mapDef, { col, row }, baseKey) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  def.base = baseKey;
  return mapDef;
}

/**
 * PAINT_STRUCTURE — place a building (BuildingType KEY) or clear it. Touches
 * ONLY the structure layer (`structure` + `building`); base & path untouched.
 *
 * CRITICAL (P5 review note): a building must build on DIRT, not GRASS. The
 * runtime `set type = BUILDING` shim forces base=DIRT, but the layered build
 * path applies each layer literally — a def with base=GRASS would yield a
 * grass-floored building. So when placing a building we emit an EXPLICIT
 * base=DIRT *unless* the user already painted a non-default base (GRASS is the
 * blank-def default ⇒ "unset"; FOREST/DIRT ⇒ a deliberate choice we keep).
 * Clearing a building leaves the base as-is.
 */
export function paintStructure(mapDef, { col, row }, buildingKey) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  if (buildingKey) {
    def.structure = _BUILDING_STRUCT_KEY;
    def.building = buildingKey;
    if (def.base === _GRASS_KEY) def.base = _DIRT_KEY; // default building floor
  } else {
    def.structure = null;
    def.building = null;
  }
  return mapDef;
}

/**
 * PAINT_PATH — set the path overlay ∈ {none(null), ROAD, RIVER, BRIDGE}. Touches
 * ONLY the path layer; base & structure untouched (a road can sit over forest).
 * roadDirs are derived separately by "Regenerate Roads"; this just sets the
 * per-tile path value.
 */
export function paintPath(mapDef, { col, row }, pathKey) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  def.path = pathKey || null;
  return mapDef;
}

/** Set (or clear) a resource on a tile. */
export function setResource(mapDef, { col, row }, resourceKey) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  def.resource = resourceKey || null;
  return mapDef;
}

/** Toggle the hidden-survivor flag on a tile. */
export function toggleHiddenSurvivor(mapDef, { col, row }) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  def.hiddenSurvivor = !def.hiddenSurvivor;
  return mapDef;
}

/** Move the single hero-start marker. Procedural mode writes it to the overlay. */
export function setHeroStart(mapDef, { col, row }) {
  if (mapDef.mode === 'procedural') {
    if (!mapDef.overlay) mapDef.overlay = {};
    mapDef.overlay.heroStart = { col, row };
  } else {
    mapDef.heroStart = { col, row };
  }
  return mapDef;
}

/** Move the single witch-start marker. */
export function setWitchStart(mapDef, { col, row }) {
  if (mapDef.mode === 'procedural') {
    if (!mapDef.overlay) mapDef.overlay = {};
    mapDef.overlay.witchStart = { col, row };
  } else {
    mapDef.witchStart = { col, row };
  }
  return mapDef;
}

// The authored extra-waypoint road-node set (rule #2 — structural building /
// bridge nodes are NOT stored here; they are unioned at build time).
function _roadNodeSet(mapDef) {
  if (mapDef.mode === 'procedural') {
    if (!mapDef.overlay) mapDef.overlay = {};
    if (!mapDef.overlay.roadNodes || typeof mapDef.overlay.roadNodes !== 'object') {
      mapDef.overlay.roadNodes = { add: [], remove: [] };
    }
    if (!Array.isArray(mapDef.overlay.roadNodes.add)) mapDef.overlay.roadNodes.add = [];
    return mapDef.overlay.roadNodes.add;
  }
  if (!Array.isArray(mapDef.roadNodes)) mapDef.roadNodes = [];
  return mapDef.roadNodes;
}

/** Toggle an EXTRA authored road-node waypoint (not a structural node). */
export function toggleRoadNode(mapDef, { col, row }) {
  const key = hexKey(col, row);
  const set = _roadNodeSet(mapDef);
  const i = set.indexOf(key);
  if (i >= 0) set.splice(i, 1);
  else set.push(key);
  return mapDef;
}

function _witchObjectives(mapDef) {
  if (mapDef.mode === 'procedural') {
    if (!mapDef.overlay) mapDef.overlay = {};
    if (!Array.isArray(mapDef.overlay.witchObjectives)) mapDef.overlay.witchObjectives = [];
    return mapDef.overlay.witchObjectives;
  }
  if (!Array.isArray(mapDef.witchObjectives)) mapDef.witchObjectives = [];
  return mapDef.witchObjectives;
}

/** Toggle a Power Node (witchObjectives entry) on a tile. */
export function togglePowerNode(mapDef, { col, row }) {
  const objs = _witchObjectives(mapDef);
  const i = objs.findIndex(o => o.col === col && o.row === row);
  if (i >= 0) {
    objs.splice(i, 1);
  } else {
    objs.push({
      col, row,
      hexes: [{ col, row }],
      label: `Power Node ${objs.length + 1}`,
    });
  }
  return mapDef;
}

/** Place / toggle an enemy unit at a hex. Same type → remove; different →
 *  replace; none → add. Mutates the sibling enemyUnits array. */
export function placeEnemyUnit(enemyUnits, { col, row }, typeValue) {
  const existing = enemyUnits.find(u => u.col === col && u.row === row);
  if (existing) {
    if (existing.type === typeValue) {
      const i = enemyUnits.indexOf(existing);
      enemyUnits.splice(i, 1);
    } else {
      existing.type = typeValue;
    }
  } else {
    enemyUnits.push({ type: typeValue, col, row, overrides: {} });
  }
  return enemyUnits;
}

// ── Tile snapshot (Map<key,Tile> → complete tile-def array) ──────────────────

// Serialise a built Tile Map back to COMPLETE tile defs in the canonical P5
// LAYERED shape (base/structure/path uppercase KEYS, NO legacy `type`), dropping
// plain-grass tiles (buildMissionMap re-fills those). ALWAYS emits an explicit
// base. Lossless for everything non-trivial: base material, building, path,
// resources, fortify, hidden survivors, and derived roadDirs.
export function snapshotTiles(tilesMap) {
  const out = [];
  for (const t of tilesMap.values()) {
    const baseKey = _enumKey(TileType, baseOf(t)); // GRASS | FOREST | DIRT
    const structKey = structureOf(t) ? _BUILDING_STRUCT_KEY : null;
    const pathKey = _enumKey(PathType, pathOf(t)); // ROAD | RIVER | BRIDGE | null
    const roadDirs = t.roadDirs ? [...t.roadDirs] : [];
    const trivial = baseKey === 'GRASS' && !structKey && !pathKey && !t.building &&
      !t.resource && !t.fortifyLevel && !t.hiddenSurvivor && roadDirs.length === 0;
    if (trivial) continue;
    out.push({
      col: t.col, row: t.row,
      base: baseKey,
      structure: structKey,
      path: pathKey,
      building: _enumKey(BuildingType, t.building),
      fortifyLevel: t.fortifyLevel || 0,
      resource: _enumKey(ResourceType, t.resource),
      hiddenSurvivor: !!t.hiddenSurvivor,
      roadDirs,
    });
  }
  return out;
}

/**
 * Strip the structure + path layers off a BUILT tiles Map in place, leaving only
 * the base terrain. Used by the "Base only" / "Roads + Buildings" visibility
 * toggles (item 6) to render a display-only copy without touching renderer.js.
 * Mutates and returns the same Map (callers pass a throwaway display build).
 */
export function stripTileOverlays(tilesMap) {
  for (const t of tilesMap.values()) {
    t.structure = null;
    t.building = null;
    t.path = null;
    if (t.roadDirs instanceof Set) t.roadDirs.clear();
    else if (Array.isArray(t.roadDirs)) t.roadDirs = [];
  }
  return tilesMap;
}

/**
 * Regenerate roads on a HANDMADE map and snapshot the result (rule #3).
 *
 * Builds the current tiles, derives the road network from the node set
 * (structural building/bridge nodes ∪ authored waypoints — rule #2), then
 * writes the derived ROAD types + roadDirs back into mapDef.tiles so they
 * persist across a reload. No-op for procedural maps (those regen at build).
 */
export function regenerateHandmadeRoads(mapDef) {
  if (mapDef.mode !== 'handmade') return mapDef;
  const built = buildMissionMap(mapDef); // tiles Map (also sets map dimensions)

  const nodeKeys = new Set(mapDef.roadNodes ?? []);
  for (const t of built.tiles.values()) {
    if (hasBuilding(t) || isBridge(t)) {
      nodeKeys.add(hexKey(t.col, t.row));
    }
  }

  rederiveRoads(built.tiles, nodeKeys, rng(mapDef.roadSeed ?? HANDMADE_ROAD_SEED));
  mapDef.tiles = snapshotTiles(built.tiles);
  return mapDef;
}

// ═══════════════════════════════════════════════════════════════════════════
// Map creation (item 4) — three LOCKED modes
// ─────────────────────────────────────────────────────────────────────────────
// A mission's map mode is chosen once, at creation, and then LOCKED — there is
// no mid-edit toggle (the old side-panel handmade↔procedural toggle is gone).
// Three creation modes, mapped onto the two underlying model shapes:
//
//   • "blank"   → mode:"handmade", an empty grass grid at the chosen cols×rows.
//   • "baked"   → mode:"handmade", but SNAPSHOTTED from generateMap(seed,size)
//                 so it starts generated yet every tile is directly editable
//                 (NO overlay). Carries `baked:true` purely as an editor marker.
//   • "overlay" → mode:"procedural", a regenerable seeded base + an edit overlay.
//
// `cols`/`rows` are stored EXPLICITLY on every mapDef (item 3) so the size model
// and the per-edge resize are uniform across modes (procedural derives its dims
// from MAP_SIZES at build time, but tracking them here keeps the editor honest).
// ═══════════════════════════════════════════════════════════════════════════

const _DEFAULT_COLS = 9;
const _DEFAULT_ROWS = 9;

/** A fresh handmade BLANK map: an all-grass grid with proportionally-placed
 *  starts (clamped in-bounds). */
export function createBlankMapDef(cols = _DEFAULT_COLS, rows = _DEFAULT_ROWS) {
  cols = Math.max(1, Math.floor(cols));
  rows = Math.max(1, Math.floor(rows));
  const cc = (c) => Math.max(0, Math.min(cols - 1, c));
  const cr = (r) => Math.max(0, Math.min(rows - 1, r));
  return {
    mode: 'handmade',
    cols,
    rows,
    heroStart: { col: cc(Math.floor(cols * 0.2)), row: cr(Math.floor(rows * 0.75)) },
    witchStart: { col: cc(Math.floor(cols * 0.75)), row: cr(Math.floor(rows * 0.2)) },
    witchObjectives: [],
    roadNodes: [],
    tiles: [],
  };
}

/** The editor's initial map (a blank 9×9 handmade grid). */
export function createDefaultMapDef() {
  return createBlankMapDef(_DEFAULT_COLS, _DEFAULT_ROWS);
}

/**
 * A BAKED GENERATED map: run generateMap(seed, size) and snapshot the result
 * into the explicit handmade shape (canonical layered tile defs) so it starts
 * as a generated map but every tile is directly editable — no overlay. Marked
 * `baked:true` so the locked-mode readout can say "handmade (baked)".
 */
export function createBakedMapDef({ seed = 12345, mapSize = 'standard', nodeCount = null } = {}) {
  const built = generateMap(seed, mapSize, nodeCount);
  const cfg = MAP_SIZES[mapSize] ?? MAP_SIZES.standard;
  return {
    mode: 'handmade',
    baked: true,
    cols: cfg.cols,
    rows: cfg.rows,
    heroStart: built.heroStart ?? { col: 0, row: 0 },
    witchStart: built.witchStart ?? { col: 0, row: 0 },
    witchObjectives: built.witchObjectives ?? [],
    roadNodes: [],
    tiles: snapshotTiles(built.tiles),
  };
}

/**
 * An OVERLAY map: a seeded procedural base (regenerable) plus an edit overlay.
 * Stores explicit cols/rows (from MAP_SIZES) alongside the named `mapSize` so
 * the size model is uniform with handmade.
 */
export function createOverlayMapDef({ seed = 12345, mapSize = 'standard', nodeCount = null } = {}) {
  const cfg = MAP_SIZES[mapSize] ?? MAP_SIZES.standard;
  return {
    mode: 'procedural',
    seed,
    mapSize,
    nodeCount: nodeCount ?? cfg.nodeCount ?? 3,
    cols: cfg.cols,
    rows: cfg.rows,
    overlay: {
      tiles: [],
      roadNodes: { add: [], remove: [] },
      witchObjectives: [],
    },
  };
}

/** Creation-dialog modes (item 4). */
export const CreationMode = Object.freeze({
  BLANK: 'blank',
  BAKED: 'baked',
  OVERLAY: 'overlay',
});

/**
 * Build a fresh mapDef for one of the three creation modes. The single entry
 * point the creation dialog calls; the resulting mode is then LOCKED.
 */
export function buildCreationMapDef(opts = {}) {
  switch (opts.mode ?? CreationMode.BLANK) {
    case CreationMode.BLANK:
      return createBlankMapDef(opts.cols ?? _DEFAULT_COLS, opts.rows ?? _DEFAULT_ROWS);
    case CreationMode.BAKED:
      return createBakedMapDef(opts);
    case CreationMode.OVERLAY:
      return createOverlayMapDef(opts);
    default:
      throw new Error(`buildCreationMapDef: unknown creation mode "${opts.mode}"`);
  }
}

/** A human-readable label for the LOCKED map mode (item 4 read-only readout). */
export function mapModeLabel(mapDef) {
  if (!mapDef) return '—';
  if (mapDef.mode === 'procedural') return 'overlay';
  return mapDef.baked ? 'handmade (baked)' : 'handmade';
}

// ═══════════════════════════════════════════════════════════════════════════
// Map sizing (item 3) — explicit cols/rows + per-edge add/remove with remap
// ─────────────────────────────────────────────────────────────────────────────
// HANDMADE maps resize by adding/removing one row/column on a named edge.
// Adding/removing on the TOP or LEFT edge shifts every existing coordinate, so
// `resizeHandmadeMap` remaps ALL coordinate-bearing data consistently: tile
// positions + their roadDirs neighbour keys, heroStart, witchStart, every
// witchObjective (anchor + hexes), the authored roadNode key set, enemyUnits,
// and meta.survivorStartPositions. BOTTOM/RIGHT edits don't shift — they just
// extend (grass fills implicitly) or truncate the grid.
//
// Removing an edge that holds a hero/witch start or a power node is BLOCKED
// (guarded) rather than silently orphaning it. The function is PURE: it takes
// and returns the full `{ mapDef, enemyUnits, meta }` model and never mutates
// its input. OVERLAY maps resize differently — see `setOverlayMapSize`.
// ═══════════════════════════════════════════════════════════════════════════

/** The four resizable edges. */
export const MAP_EDGES = Object.freeze(['top', 'bottom', 'left', 'right']);

function _shiftKey(key, dCol, dRow) {
  const [c, r] = String(key).split(',').map(Number);
  return hexKey(c + dCol, r + dRow);
}
function _keyInBounds(key, cols, rows) {
  const [c, r] = String(key).split(',').map(Number);
  return c >= 0 && r >= 0 && c < cols && r < rows;
}
function _crInBounds(col, row, cols, rows) {
  return col >= 0 && row >= 0 && col < cols && row < rows;
}

/**
 * Resize a HANDMADE map by adding (`delta:+1`) or removing (`delta:-1`) one
 * row/column on `edge` ∈ MAP_EDGES, remapping ALL coordinate-bearing model
 * data. PURE — returns `{ ok, model, warning }` and never mutates the input.
 * A blocked removal (start/node on the edge, or shrinking below 1×1) returns
 * `{ ok:false, warning }` with the input model unchanged.
 *
 * @param {{ mapDef: object, enemyUnits?: object[], meta?: object }} model
 */
export function resizeHandmadeMap(model, edge, delta) {
  const md = model.mapDef;
  if (!md || md.mode !== 'handmade') {
    return { ok: false, model, warning: 'Edge resize applies to handmade maps only.' };
  }
  if (delta !== 1 && delta !== -1) {
    return { ok: false, model, warning: 'delta must be +1 or -1.' };
  }
  if (!MAP_EDGES.includes(edge)) {
    return { ok: false, model, warning: `Unknown edge "${edge}".` };
  }

  const C = md.cols;
  const R = md.rows;
  let newCols = C;
  let newRows = R;
  let dCol = 0;
  let dRow = 0;
  let dropAxis = null; // 'col' | 'row' for a removal's dropped line
  let dropIndex = -1;

  switch (edge) {
    case 'right':
      newCols = C + delta;
      if (delta < 0) { dropAxis = 'col'; dropIndex = C - 1; }
      break;
    case 'bottom':
      newRows = R + delta;
      if (delta < 0) { dropAxis = 'row'; dropIndex = R - 1; }
      break;
    case 'left':
      newCols = C + delta;
      if (delta > 0) dCol = 1; else { dropAxis = 'col'; dropIndex = 0; dCol = -1; }
      break;
    case 'top':
      newRows = R + delta;
      if (delta > 0) dRow = 1; else { dropAxis = 'row'; dropIndex = 0; dRow = -1; }
      break;
  }

  if (newCols < 1 || newRows < 1) {
    return { ok: false, model, warning: 'Map must keep at least 1×1.' };
  }

  // Guard: a removal must not orphan a start or a power node on the dropped line.
  if (delta < 0) {
    const onEdge = (col, row) => (dropAxis === 'col' ? col === dropIndex : row === dropIndex);
    const orphans = new Set();
    if (md.heroStart && onEdge(md.heroStart.col, md.heroStart.row)) orphans.add('hero start');
    if (md.witchStart && onEdge(md.witchStart.col, md.witchStart.row)) orphans.add('witch start');
    for (const o of md.witchObjectives ?? []) {
      if (onEdge(o.col, o.row) || (o.hexes ?? []).some(h => onEdge(h.col, h.row))) {
        orphans.add('a power node');
        break;
      }
    }
    if (orphans.size) {
      return { ok: false, model, warning: `Cannot remove that edge — it holds ${[...orphans].join(', ')}.` };
    }
  }

  // Build the remapped model on a deep clone (purity).
  const out = _clone(model);
  const nd = out.mapDef;
  nd.cols = newCols;
  nd.rows = newRows;
  const keep = (col, row) => _crInBounds(col, row, newCols, newRows);
  let dropped = 0;

  // Tiles: shift position + roadDirs neighbour keys, drop out-of-bounds tiles,
  // then prune roadDirs that now point past the (possibly shrunk) edge.
  const tilesBefore = (nd.tiles ?? []).length;
  nd.tiles = (nd.tiles ?? [])
    .map(t => ({
      ...t,
      col: t.col + dCol,
      row: t.row + dRow,
      roadDirs: (t.roadDirs ?? []).map(k => _shiftKey(k, dCol, dRow)),
    }))
    .filter(t => keep(t.col, t.row))
    .map(t => ({ ...t, roadDirs: t.roadDirs.filter(k => _keyInBounds(k, newCols, newRows)) }));
  dropped += tilesBefore - nd.tiles.length;

  // Starts (guarded above, so always in-bounds after the shift).
  if (nd.heroStart) nd.heroStart = { col: nd.heroStart.col + dCol, row: nd.heroStart.row + dRow };
  if (nd.witchStart) nd.witchStart = { col: nd.witchStart.col + dCol, row: nd.witchStart.row + dRow };

  // Power nodes: shift anchor + hexes; drop out-of-bounds hexes / objectives.
  const objsBefore = (nd.witchObjectives ?? []).length;
  nd.witchObjectives = (nd.witchObjectives ?? [])
    .map(o => ({
      ...o,
      col: o.col + dCol,
      row: o.row + dRow,
      hexes: (o.hexes ?? [])
        .map(h => ({ col: h.col + dCol, row: h.row + dRow }))
        .filter(h => keep(h.col, h.row)),
    }))
    .filter(o => keep(o.col, o.row));
  dropped += objsBefore - nd.witchObjectives.length;

  // Authored road-node waypoint keys.
  const rnBefore = (nd.roadNodes ?? []).length;
  nd.roadNodes = (nd.roadNodes ?? [])
    .map(k => _shiftKey(k, dCol, dRow))
    .filter(k => _keyInBounds(k, newCols, newRows));
  dropped += rnBefore - nd.roadNodes.length;

  // Sibling enemy units.
  const euBefore = (out.enemyUnits ?? []).length;
  out.enemyUnits = (out.enemyUnits ?? [])
    .map(u => ({ ...u, col: u.col + dCol, row: u.row + dRow }))
    .filter(u => keep(u.col, u.row));
  dropped += euBefore - out.enemyUnits.length;

  // Survivor start positions live on meta.
  if (out.meta && Array.isArray(out.meta.survivorStartPositions)) {
    const ssBefore = out.meta.survivorStartPositions.length;
    out.meta.survivorStartPositions = out.meta.survivorStartPositions
      .map(s => ({ ...s, col: s.col + dCol, row: s.row + dRow }))
      .filter(s => keep(s.col, s.row));
    dropped += ssBefore - out.meta.survivorStartPositions.length;
  }

  const warning = (delta < 0 && dropped > 0)
    ? `Removed ${edge} edge — dropped ${dropped} item(s) on it.`
    : '';
  return { ok: true, model: out, warning };
}

/**
 * Resize an OVERLAY (procedural) map by switching its named generation size.
 * generateMap only produces the discrete MAP_SIZES, so overlay maps resize by
 * picking a different size (the base regenerates at build time); overlay edits
 * and placements that fall outside the new bounds are dropped (with a warning).
 * PURE — returns `{ ok, model, warning }`.
 */
export function setOverlayMapSize(model, mapSize) {
  const md = model.mapDef;
  if (!md || md.mode !== 'procedural') {
    return { ok: false, model, warning: 'Size change via map size applies to overlay maps.' };
  }
  const cfg = MAP_SIZES[mapSize];
  if (!cfg) return { ok: false, model, warning: `Unknown map size "${mapSize}".` };

  const out = _clone(model);
  const nd = out.mapDef;
  nd.mapSize = mapSize;
  nd.cols = cfg.cols;
  nd.rows = cfg.rows;
  const keep = (col, row) => _crInBounds(col, row, cfg.cols, cfg.rows);
  const keepKey = (k) => _keyInBounds(k, cfg.cols, cfg.rows);
  let dropped = 0;

  const ov = nd.overlay ?? (nd.overlay = {});
  if (Array.isArray(ov.tiles)) {
    const b = ov.tiles.length;
    ov.tiles = ov.tiles.filter(t => keep(t.col, t.row));
    dropped += b - ov.tiles.length;
  }
  if (ov.roadNodes && typeof ov.roadNodes === 'object') {
    for (const k of ['add', 'remove']) {
      if (Array.isArray(ov.roadNodes[k])) {
        const b = ov.roadNodes[k].length;
        ov.roadNodes[k] = ov.roadNodes[k].filter(keepKey);
        dropped += b - ov.roadNodes[k].length;
      }
    }
  }
  if (Array.isArray(ov.witchObjectives)) {
    const b = ov.witchObjectives.length;
    ov.witchObjectives = ov.witchObjectives
      .filter(o => keep(o.col, o.row))
      .map(o => ({ ...o, hexes: (o.hexes ?? []).filter(h => keep(h.col, h.row)) }));
    dropped += b - ov.witchObjectives.length;
  }
  if (ov.hiddenSurvivors && typeof ov.hiddenSurvivors === 'object') {
    for (const k of ['add', 'remove']) {
      if (Array.isArray(ov.hiddenSurvivors[k])) ov.hiddenSurvivors[k] = ov.hiddenSurvivors[k].filter(keepKey);
    }
  }
  if (ov.heroStart && !keep(ov.heroStart.col, ov.heroStart.row)) { delete ov.heroStart; dropped++; }
  if (ov.witchStart && !keep(ov.witchStart.col, ov.witchStart.row)) { delete ov.witchStart; dropped++; }

  const euBefore = (out.enemyUnits ?? []).length;
  out.enemyUnits = (out.enemyUnits ?? []).filter(u => keep(u.col, u.row));
  dropped += euBefore - out.enemyUnits.length;

  if (out.meta && Array.isArray(out.meta.survivorStartPositions)) {
    const b = out.meta.survivorStartPositions.length;
    out.meta.survivorStartPositions = out.meta.survivorStartPositions.filter(s => keep(s.col, s.row));
    dropped += b - out.meta.survivorStartPositions.length;
  }

  const warning = dropped > 0
    ? `Resized to ${cfg.cols}×${cfg.rows} — dropped ${dropped} edit(s) outside the new bounds.`
    : '';
  return { ok: true, model: out, warning };
}

// ── Mode toggle (legacy; retained for the model, no UI path post-lock) ─────────

/**
 * Switch the map between handmade and procedural while keeping a coherent
 * model. handmade→procedural seeds a fresh procedural def (with overlay);
 * procedural→handmade BAKES the current procedural build into an explicit
 * handmade snapshot. Returns a NEW mapDef (does not mutate the input).
 */
export function setMode(mapDef, mode, opts = {}) {
  if (mode === mapDef.mode) return _clone(mapDef);

  if (mode === 'procedural') {
    return {
      mode: 'procedural',
      seed: opts.seed ?? 12345,
      mapSize: opts.mapSize ?? 'standard',
      nodeCount: opts.nodeCount ?? 3,
      overlay: {
        tiles: [],
        roadNodes: { add: [], remove: [] },
        witchObjectives: [],
      },
    };
  }

  // → handmade: bake the procedural build into explicit tiles.
  const built = buildMissionMap(mapDef);
  return {
    mode: 'handmade',
    cols: built.cols,
    rows: built.rows,
    heroStart: built.heroStart ?? { col: 0, row: 0 },
    witchStart: built.witchStart ?? { col: 0, row: 0 },
    witchObjectives: built.witchObjectives ?? [],
    roadNodes: [],
    tiles: snapshotTiles(built.tiles),
  };
}

function _clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ═══════════════════════════════════════════════════════════════════════════
// Mission META model + form operations (P6)
// ─────────────────────────────────────────────────────────────────────────────
// The editor's working model is three pieces:
//   • mapDef     — the P1 map sub-schema (above).
//   • enemyUnits — the sibling placement list (above).
//   • meta       — EVERYTHING ELSE in the mission JSON (scalars, briefing text,
//                  phaseCycle, resources, waves, objectives, storyTriggers,
//                  survivorStartPositions). The authoring forms edit `meta`.
//
// `assembleMission` recombines the three into a complete schema:1 mission JSON;
// `populateFromMission` splits a parsed mission back into the three. The two are
// inverses (lossless round-trip), which the forms tests pin.
// ═══════════════════════════════════════════════════════════════════════════

/** A fresh, complete mission meta block (all fields present). */
export function createDefaultMeta() {
  return {
    id: 'new_mission',
    title: 'New Mission',
    chapter: 1,
    campaignId: null,
    requires: null,
    briefing: '',
    victoryText: '',
    defeatText: '',
    phaseCycle: { phases: ['dawn', 'day', 'day', 'day'], loop: true },
    mapSize: 'skirmish',
    hasWitch: false,
    disableScoring: true,
    aiPersonality: 'balanced',
    aiBudgetBonus: 0,
    maxSurvivorsFromRoster: 0,
    missionSurvivors: 0,
    maxDiscoverableSurvivors: 0,
    startingResources: {},
    rewards: {},
    healBonus: 0,
    lootOverrides: null,
    waves: [],
    objectives: { win: { type: 'eliminate_all' }, lose: { type: 'hero_killed' } },
    storyTriggers: [],
    survivorStartPositions: [],
  };
}

// ── storyTriggers list ops ────────────────────────────────────────────────────

/** Append a story trigger (round-based by default). `entry` overrides fields. */
export function addStoryTrigger(meta, entry = {}) {
  if (!Array.isArray(meta.storyTriggers)) meta.storyTriggers = [];
  meta.storyTriggers.push({ type: 'round', round: 1, title: '', text: '', ...entry });
  return meta;
}

export function removeStoryTrigger(meta, idx) {
  if (Array.isArray(meta.storyTriggers) && idx >= 0 && idx < meta.storyTriggers.length) {
    meta.storyTriggers.splice(idx, 1);
  }
  return meta;
}

/** Reorder a story trigger by `dir` (−1 up, +1 down). No-op at the edges. */
export function moveStoryTrigger(meta, idx, dir) {
  const list = meta.storyTriggers;
  if (!Array.isArray(list)) return meta;
  const j = idx + dir;
  if (idx < 0 || idx >= list.length || j < 0 || j >= list.length) return meta;
  [list[idx], list[j]] = [list[j], list[idx]];
  return meta;
}

// ── waves list ops ────────────────────────────────────────────────────────────

/** Append a wave (round-triggered by default). `wave` overrides fields. */
export function addWave(meta, wave = {}) {
  if (!Array.isArray(meta.waves)) meta.waves = [];
  meta.waves.push({ trigger: 'round', round: 1, count: 1, units: [], ...wave });
  return meta;
}

export function removeWave(meta, idx) {
  if (Array.isArray(meta.waves) && idx >= 0 && idx < meta.waves.length) {
    meta.waves.splice(idx, 1);
  }
  return meta;
}

// ── objectives ────────────────────────────────────────────────────────────────

/** Set the win/lose objective (a def `{type, ...params}` or array for lose). */
export function setObjective(meta, side, def) {
  if (side !== 'win' && side !== 'lose') return meta;
  if (!meta.objectives || typeof meta.objectives !== 'object') meta.objectives = {};
  meta.objectives[side] = def;
  return meta;
}

// ── Assemble / populate (inverses) ─────────────────────────────────────────────

/**
 * Recombine the working model into a complete schema:1 mission JSON object.
 * Tiles are already COMPLETE defs (mapDef stores them in snapshot form);
 * storyTrigger conditions are already STRING keys; enemyUnits keep their
 * lowercase runtime `type`. `map.roadSeed` (if any) rides along inside `mapDef`.
 *
 * @param {{ meta: object, mapDef: object, enemyUnits: object[] }} model
 */
export function assembleMission({ meta, mapDef, enemyUnits }) {
  return {
    schema: 1,
    ...meta,
    map: mapDef,
    enemyUnits: enemyUnits ?? [],
  };
}

/**
 * Split a parsed mission JSON into the editor's three model pieces (inverse of
 * {@link assembleMission}). `schema`, `map`, and `enemyUnits` are peeled off;
 * everything else becomes `meta`.
 *
 * @param {object} parsed
 * @returns {{ meta: object, mapDef: object, enemyUnits: object[] }}
 */
export function populateFromMission(parsed) {
  // eslint-disable-next-line no-unused-vars
  const { schema, map, enemyUnits, ...meta } = parsed;
  return {
    meta,
    mapDef: map,
    enemyUnits: enemyUnits ?? [],
  };
}

// ── Controller ───────────────────────────────────────────────────────────────

const _TOOL_DISPATCH = {
  [EditorTool.PAINT_BASE]: (m, hex, pv) => paintBase(m.mapDef, hex, pv.base),
  [EditorTool.PAINT_STRUCTURE]: (m, hex, pv) => paintStructure(m.mapDef, hex, pv.structure),
  [EditorTool.PAINT_PATH]: (m, hex, pv) => paintPath(m.mapDef, hex, pv.path),
  [EditorTool.SET_RESOURCE]: (m, hex, pv) => setResource(m.mapDef, hex, pv.resource),
  [EditorTool.HIDDEN_SURVIVOR]: (m, hex) => toggleHiddenSurvivor(m.mapDef, hex),
  [EditorTool.ENEMY_UNIT]: (m, hex, pv) => placeEnemyUnit(m.enemyUnits, hex, pv.enemyType),
  [EditorTool.HERO_START]: (m, hex) => setHeroStart(m.mapDef, hex),
  [EditorTool.WITCH_START]: (m, hex) => setWitchStart(m.mapDef, hex),
  [EditorTool.ROAD_NODE]: (m, hex) => toggleRoadNode(m.mapDef, hex),
  [EditorTool.POWER_NODE]: (m, hex) => togglePowerNode(m.mapDef, hex),
};

/**
 * Create a mission-editor controller. DOM-free: pass an injected `render`
 * callback (invoked after every model change) so the edit loop is unit-testable
 * without a canvas. The canvas/Renderer wiring (mission-editor-ui.js) supplies
 * that callback.
 *
 * Seam for P6: getMapDef()/setMapDef() and getEnemyUnits()/setEnemyUnits()
 * expose the full working model so the authoring-forms + load/save phase can
 * read and replace it.
 *
 * @param {{ render?: () => void }} [opts]
 */
export function createMissionEditor({ render } = {}) {
  let mapDef = createDefaultMapDef();
  let enemyUnits = [];
  let meta = createDefaultMeta();
  let activeTool = EditorTool.PAINT_BASE;
  const paintValues = {
    base: _enumKey(TileType, TileType.GRASS),
    // Default building so a fresh PAINT_STRUCTURE click places one; the UI's
    // "None" option clears (null ⇒ paintStructure removes the building).
    structure: _enumKey(BuildingType, BuildingType.HOUSE),
    path: null, // none — PAINT_PATH paints null until a path is picked
    resource: _enumKey(ResourceType, ResourceType.HERBS),
    enemyType: ENEMY_UNIT_TYPES[0],
  };
  // Full undo + redo history (item 5). Each entry is a serialised snapshot of
  // the whole working model. A NEW action (snapshot) invalidates the redo stack;
  // undo/redo shuttle snapshots between the two stacks (standard semantics).
  const undoStack = [];
  const redoStack = [];
  // Unsaved-work flag (carried-over nit): lives on the controller so a fresh
  // editor starts CLEAN and `isDirty()` is unit-testable. Set on every model
  // mutation (emit), cleared by markClean() after a load / save / New.
  let dirty = false;

  const emit = () => { dirty = true; if (render) render(); };
  const model = () => ({ mapDef, enemyUnits });

  const _serialize = () => JSON.stringify({ mapDef, enemyUnits, meta });
  function _restore(json) {
    const prev = JSON.parse(json);
    mapDef = prev.mapDef;
    enemyUnits = prev.enemyUnits;
    if (prev.meta) meta = prev.meta;
  }

  // Snapshot the full serialisable model before each edit (undo). A fresh edit
  // clears the redo stack — you can't redo past a new branch of history.
  function snapshot() {
    undoStack.push(_serialize());
    redoStack.length = 0;
  }

  function _inBounds({ col, row }) {
    if (col == null || row == null || col < 0 || row < 0) return false;
    if (mapDef.mode === 'handmade') {
      return col < (mapDef.cols ?? Infinity) && row < (mapDef.rows ?? Infinity);
    }
    return true; // procedural extent is known only post-build; accept.
  }

  return {
    // ── Accessors (P6 seam) ──────────────────────────────────────────────
    getMapDef: () => mapDef,
    setMapDef(def) { snapshot(); mapDef = def; emit(); },
    getEnemyUnits: () => enemyUnits,
    setEnemyUnits(list) { snapshot(); enemyUnits = list; emit(); },
    getMeta: () => meta,
    setMeta(m) { snapshot(); meta = m; emit(); },

    // ── Full-mission assemble / load (P6) ────────────────────────────────
    /** Recombine the model into a complete schema:1 mission JSON object. */
    assemble() { return assembleMission({ meta, mapDef, enemyUnits }); },
    /** Replace the whole model atomically (one undo step) from a split mission. */
    applyMission({ meta: m, mapDef: md, enemyUnits: eu }) {
      snapshot();
      meta = m;
      mapDef = md;
      enemyUnits = eu ?? [];
      emit();
    },

    // ── Tool / paint state ───────────────────────────────────────────────
    get activeTool() { return activeTool; },
    setActiveTool(tool) { activeTool = tool; },
    getPaintValue(kind) { return paintValues[kind]; },
    setPaintValue(kind, value) { paintValues[kind] = value; },

    // ── Edit loop ────────────────────────────────────────────────────────
    /** Apply the active tool to a hex. No-op outside bounds. */
    applyAt(hex) {
      if (!hex || !_inBounds(hex)) return;
      const fn = _TOOL_DISPATCH[activeTool];
      if (!fn) return;
      snapshot();
      fn(model(), { col: hex.col, row: hex.row }, paintValues);
      emit();
    },

    // ── Creation (item 4) — one of the three LOCKED modes ────────────────
    /**
     * Start a fresh mission with a newly-created map (blank / baked / overlay).
     * Resets enemyUnits and meta; the chosen map mode is then LOCKED (no UI
     * toggle). One undo step. `opts` is passed to buildCreationMapDef.
     */
    createNew(opts = {}) {
      snapshot();
      mapDef = buildCreationMapDef(opts);
      enemyUnits = [];
      meta = createDefaultMeta();
      if (opts.mapSize) meta.mapSize = opts.mapSize;
      emit();
    },

    // ── Sizing (item 3) — explicit dims + per-edge resize ────────────────
    getDims: () => ({ cols: mapDef.cols, rows: mapDef.rows }),
    getMapModeLabel: () => mapModeLabel(mapDef),
    /**
     * Add/remove a row/column on `edge` (handmade) with full coordinate remap.
     * Returns `{ ok, warning }`; on a blocked resize the model is untouched.
     */
    resizeEdge(edge, delta) {
      const res = resizeHandmadeMap({ mapDef, enemyUnits, meta }, edge, delta);
      if (!res.ok) return { ok: false, warning: res.warning };
      snapshot();
      ({ mapDef, enemyUnits, meta } = res.model);
      emit();
      return { ok: true, warning: res.warning };
    },
    /** Switch an overlay map's generation size; drops out-of-bounds edits. */
    setOverlaySize(mapSize) {
      const res = setOverlayMapSize({ mapDef, enemyUnits, meta }, mapSize);
      if (!res.ok) return { ok: false, warning: res.warning };
      snapshot();
      ({ mapDef, enemyUnits, meta } = res.model);
      emit();
      return { ok: true, warning: res.warning };
    },

    // ── Mode / seed / roads ──────────────────────────────────────────────
    getMode: () => mapDef.mode,
    setMode(mode, opts) { snapshot(); mapDef = setMode(mapDef, mode, opts); emit(); },
    getSeed: () => mapDef.seed,
    setSeed(seed) {
      if (mapDef.mode !== 'procedural') return;
      snapshot();
      mapDef.seed = seed;
      emit();
    },
    regenerateRoads() {
      snapshot();
      regenerateHandmadeRoads(mapDef);
      emit();
    },

    // ── Undo / Redo (item 5) ─────────────────────────────────────────────
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undo() {
      if (undoStack.length === 0) return false;
      redoStack.push(_serialize()); // current state becomes redoable
      _restore(undoStack.pop());
      emit();
      return true;
    },
    redo() {
      if (redoStack.length === 0) return false;
      undoStack.push(_serialize()); // current state becomes undoable again
      _restore(redoStack.pop());
      emit();
      return true;
    },

    // ── Dirty tracking (carried-over nit) ────────────────────────────────
    isDirty: () => dirty,
    markClean() { dirty = false; },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3D preview lifecycle bookkeeping (P7)
// ─────────────────────────────────────────────────────────────────────────────
// DOM-free and Babylon-free: the renderer is constructed/disposed through
// injected callbacks so the lazy-construct + dispose-before-rebuild bookkeeping
// is unit-testable without a canvas or a Babylon engine. The UI half
// (mission-editor-ui.js) supplies `construct` (build a Renderer3D on the current
// editor state) and `dispose` (tear down its scene + engine).
//
// Guarantees:
//   • Lazy: nothing is constructed until the first `rebuild()`.
//   • Single live renderer: `rebuild()` disposes any prior one before building
//     a fresh one, so pressing "Preview in 3D" repeatedly never leaks an engine.
//   • `teardown()` is idempotent and dispose errors are swallowed, so it's safe
//     to call on close AND on tab-switch without double-dispose crashes.
//
// @param {{ construct: (...args) => object, dispose: (renderer: object) => void }} cbs
export function createPreviewController({ construct, dispose }) {
  let active = null; // current renderer instance, or null when torn down

  return {
    /** True while a preview renderer is live. */
    isActive: () => active !== null,
    /** The current renderer instance (or null) — for resize plumbing. */
    current: () => active,
    /** Dispose any existing renderer, then construct a fresh one. Returns it. */
    rebuild(...args) {
      this.teardown();
      active = construct(...args);
      return active;
    },
    /** Dispose the live renderer (if any) and clear the slot. Idempotent. */
    teardown() {
      if (active === null) return;
      const r = active;
      active = null; // clear FIRST so a throwing dispose can't strand the slot
      try { dispose(r); } catch { /* ignore teardown errors */ }
    },
  };
}
