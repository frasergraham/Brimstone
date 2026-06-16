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
import { hexKey, getNeighbors } from '../hex.js';
import { rng, generateMap, MAP_SIZES, NODE_COLORS } from '../map.js';
import { buildMissionMap, rederiveRoads } from '../campaign/mission-map.js';
import { eligibleFootprintNeighbors, pickFootprintNeighbor } from '../building-footprint.js';
import { SURVIVOR_ROSTER } from '../content/survivors.js';
import { ITEMS } from '../items.js';

/** Active-tool ids the click loop dispatches on. */
export const EditorTool = Object.freeze({
  // Three independent layer-paint tools (P6 tile-model refactor). Each touches
  // exactly ONE of the (base, structure, path) layers — a road can sit over a
  // forest base, a building on dirt, etc.
  PAINT_BASE: 'paint-base',           // base material: grass | forest | dirt
  PAINT_STRUCTURE: 'paint-structure', // building (BuildingType) or clear
  // Path painting is split into two single-kind tools (item 2): Road paints
  // path=ROAD + wires roadDirs; River paints path=RIVER under the tree-topology
  // rule (item 4). The old combined PAINT_PATH (with a Road/River value selector)
  // is gone — each tool paints exactly its kind.
  PAINT_ROAD: 'paint-road',           // path overlay: ROAD (wires roadDirs)
  PAINT_RIVER: 'paint-river',         // path overlay: RIVER (tree topology only)
  HIDDEN_SURVIVOR: 'hidden-survivor',
  // Exploration override (M4): pin a FIXED loot result on a tile so searching it
  // yields that result instead of the random loot roll. Authoring only — the
  // runtime executeExplore does not yet read the override (see report).
  EXPLORE_OVERRIDE: 'explore-override',
  ENEMY_UNIT: 'enemy-unit',
  HERO_START: 'hero-start',
  WITCH_START: 'witch-start',
  ROAD_NODE: 'road-node',
  POWER_NODE: 'power-node',
  DELETE: 'delete',                   // clear a tile back to blank/base (item 5)
  // Click a placed unit → adds an Actor node (OnSpawn/OnDeath) to the logic graph;
  // click an empty hex → adds a Location node (a hex you can wire into Spawn, etc).
  // Handled in the UI layer (mission-editor-ui onPaint), not _TOOL_DISPATCH.
  ADD_TO_GRAPH: 'add-to-graph',
});

/** Enemy unit types the placement tool can stamp (runtime lowercase values). */
export const ENEMY_UNIT_TYPES = Object.freeze([
  'zombie', 'minion', 'wood_golem', 'iron_golem',
]);

// The path kinds the editor can paint (item 2) — uppercase enum KEYs. Split
// across the Road / River tools (one kind each). BRIDGE is intentionally
// EXCLUDED: bridges are IMPLIED wherever a road crosses a river (the
// builder/renderer converts road-over-river to a bridge), so the user never
// paints one.
export const PATH_TOOL_OPTIONS = Object.freeze(['ROAD', 'RIVER']);

// ── Tool → VALUE-panel mapping (item 7) ──────────────────────────────────────
// The side-panel VALUE section is context-sensitive: each tool exposes exactly
// one kind of value selector (or none). The UI reads `valuePanelKind(tool)` to
// decide what to render; kept here (DOM-free) so the mapping is unit-testable.
export const ToolValueKind = Object.freeze({
  BASE: 'base',         // base-material swatches (grass/forest/dirt)
  STRUCTURE: 'structure', // building swatches + None/clear
  ENEMY: 'enemy',       // enemy unit-type picker
  SURVIVOR: 'survivor', // hidden-survivor roster picker (Any / a specific char)
  EXPLORE_OVERRIDE: 'explore-override', // fixed loot-result picker (M4)
  NONE: 'none',         // no value — show a hint
});

// ── Hidden-survivor picker options ───────────────────────────────────────────
// The Hidden Survivor tool can place a SPECIFIC survivor from the roster, or an
// unspecified one ("Any" → null id, the runtime's existing random-pick). The id
// is the roster `name` (unique + stable + human-readable). Exported so the UI's
// value-panel dropdown stays in lockstep with the roster without importing it.
export const HIDDEN_SURVIVOR_ANY = null;

/** Picker options for the Hidden Survivor tool: [{ id, label }]. */
export function survivorPickerOptions() {
  return [
    { id: HIDDEN_SURVIVOR_ANY, label: 'Any (random)' },
    ...SURVIVOR_ROSTER.map(c => ({ id: c.name, label: `${c.name} — ${c.title}` })),
  ];
}

/** Human label for a stored hidden-survivor id (null → "Any"). */
export function survivorLabelForId(id) {
  if (id == null) return 'Any';
  const c = SURVIVOR_ROSTER.find(s => s.name === id);
  return c ? c.name : id;
}

// ── Exploration-override picker (M4) ─────────────────────────────────────────
// An exploration override pins a FIXED loot result on a tile so searching it
// yields exactly that result instead of the random roll. The stored value
// mirrors how the loot system already represents a result — a single loot
// `type` string (resource / weapon / 'horse' / 'nothing'). The tile def carries:
//
//   exploreOverride: null | { kind, id, amount? }
//     kind   ∈ 'resource' | 'weapon' | 'horse' | 'nothing'   (a coarse discriminator)
//     id     the loot type string ('wood', 'sword', 'horse'); null for 'nothing'
//     amount optional integer ≥1 (resources only; default 1 → omitted from JSON)
//
// So the runtime could consume it by treating `id` as a fixed `lootType` and
// calling _applyLoot `amount` times (see report — not yet wired). Resource &
// weapon vocabularies are pulled from the same registries the loot tables draw
// on (ResourceType, ITEMS kind:'weapon') so the picker can't drift out of sync.

/** Loot kinds the override picker can pin. */
export const ExploreOverrideKind = Object.freeze({
  RESOURCE: 'resource',
  WEAPON: 'weapon',
  HORSE: 'horse',
  NOTHING: 'nothing',
});

// Weapon ids the picker offers (every ITEMS entry tagged kind:'weapon').
const _WEAPON_IDS = Object.values(ITEMS)
  .filter(it => it && it.kind === 'weapon')
  .map(it => it.id);

const _RESOURCE_ICON = { wood: '🪵', metal: '⚙', food: '🍞', silver: '🥈', scripture: '📜', herbs: '🌿' };

/**
 * Picker options for the Exploration Override tool: `[{ value, label }]`. `value`
 * is the encoded key (see {@link exploreOverrideKeyFor}) the value-panel dropdown
 * stores; decode it with {@link parseExploreOverrideKey} when placing.
 */
export function exploreOverridePickerOptions() {
  const opts = [{ value: 'nothing', label: 'Nothing (empty search)' }];
  for (const r of Object.values(ResourceType)) {
    const icon = _RESOURCE_ICON[r] || '';
    opts.push({ value: `resource:${r}`, label: `${icon} ${_capitalize(r)}`.trim() });
  }
  for (const w of _WEAPON_IDS) {
    opts.push({ value: `weapon:${w}`, label: `⚔ ${_capitalize(w)}` });
  }
  opts.push({ value: 'horse', label: '🐴 Horse' });
  return opts;
}

function _capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Encode an override object into the dropdown key (null → 'nothing'). */
export function exploreOverrideKeyFor(ov) {
  if (!ov || ov.kind === ExploreOverrideKind.NOTHING) return 'nothing';
  if (ov.kind === ExploreOverrideKind.HORSE) return 'horse';
  if (ov.kind === ExploreOverrideKind.RESOURCE) return `resource:${ov.id}`;
  if (ov.kind === ExploreOverrideKind.WEAPON) return `weapon:${ov.id}`;
  return 'nothing';
}

/**
 * Decode a dropdown key into a complete override object `{ kind, id }` (amount is
 * added by {@link setExploreOverride} only when >1). Unknown keys → null.
 */
export function parseExploreOverrideKey(key) {
  if (key == null || key === 'nothing') {
    return { kind: ExploreOverrideKind.NOTHING, id: null };
  }
  if (key === 'horse') return { kind: ExploreOverrideKind.HORSE, id: 'horse' };
  const i = key.indexOf(':');
  if (i < 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind === ExploreOverrideKind.RESOURCE || kind === ExploreOverrideKind.WEAPON) {
    return { kind, id };
  }
  return null;
}

/** Human label for a stored exploration override (null → "None"). */
export function exploreOverrideLabel(ov) {
  if (!ov) return 'None';
  const found = exploreOverridePickerOptions().find(o => o.value === exploreOverrideKeyFor(ov));
  const base = found ? found.label : (ov.id || ov.kind);
  return (ov.amount && ov.amount > 1) ? `${base} ×${ov.amount}` : base;
}

// Road / River paint exactly one kind each (item 2), so neither exposes a value
// selector — both map to NONE (the combined Road/River path selector is gone).
const _TOOL_VALUE_KIND = Object.freeze({
  [EditorTool.PAINT_BASE]: ToolValueKind.BASE,
  [EditorTool.PAINT_STRUCTURE]: ToolValueKind.STRUCTURE,
  [EditorTool.PAINT_ROAD]: ToolValueKind.NONE,
  [EditorTool.PAINT_RIVER]: ToolValueKind.NONE,
  [EditorTool.ENEMY_UNIT]: ToolValueKind.ENEMY,
  [EditorTool.HIDDEN_SURVIVOR]: ToolValueKind.SURVIVOR,
  [EditorTool.EXPLORE_OVERRIDE]: ToolValueKind.EXPLORE_OVERRIDE,
  [EditorTool.HERO_START]: ToolValueKind.NONE,
  [EditorTool.WITCH_START]: ToolValueKind.NONE,
  [EditorTool.ROAD_NODE]: ToolValueKind.NONE,
  [EditorTool.POWER_NODE]: ToolValueKind.NONE,
  [EditorTool.DELETE]: ToolValueKind.NONE,
  [EditorTool.ADD_TO_GRAPH]: ToolValueKind.NONE,
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

/** A fresh layer-visibility state — everything but the marker overlays on. */
export function createLayerVisibility() {
  return {
    roadsBuildings: true,   // draw the structure + path layers
    powerNodes: true,       // draw the Power-Node objectives
    playerStarts: true,     // draw the hero / witch start markers
    roadNodeMarkers: false, // draw the road-network node overlay
    areaTriggers: false,    // draw the area-event trigger overlay (item 5)
    darkenGenerated: false, // (overlay only) dim hexes that came from the
                            // generated base, leaving explicit edits bright
  };
}

/** True when the structure + path layers should be drawn for the given state. */
export function showStructures(layers) {
  return !!layers && !!layers.roadsBuildings;
}

/** Whether the area-event trigger overlay (item 5) should be drawn. */
export function areaTriggerLayerVisible(layers) {
  return !!layers && !!layers.areaTriggers;
}

/**
 * The set of hex keys covered by AREA story triggers (item 5) — every trigger
 * carrying a `hexes` array contributes its hexes. Pure; exported so the
 * area-event layer's "which hexes light up" mapping is unit-testable. Round- (or
 * other non-area) triggers have no `hexes` array and contribute nothing.
 */
export function areaTriggerHexKeys(meta) {
  const keys = new Set();
  if (!meta || !Array.isArray(meta.storyTriggers)) return keys;
  for (const tr of meta.storyTriggers) {
    if (!tr || !Array.isArray(tr.hexes)) continue;
    for (const h of tr.hexes) {
      if (h && Number.isFinite(h.col) && Number.isFinite(h.row)) keys.add(hexKey(h.col, h.row));
    }
  }
  return keys;
}

/**
 * Whether the road-network node markers should be drawn. They AUTO-SHOW whenever
 * the Road Node tool is active (so authoring waypoints is always visible), and
 * are otherwise gated on the explicit `roadNodeMarkers` toggle.
 */
export function roadNodeMarkersVisible(layers, activeTool) {
  return (!!layers && !!layers.roadNodeMarkers) || activeTool === EditorTool.ROAD_NODE;
}

/**
 * Whether the "darken auto-generated" overlay (item 9) should be drawn. This is
 * an OVERLAY-mode-only affordance — handmade maps have no generated base to
 * distinguish from edits — so it's gated on BOTH the toggle and the mode.
 */
export function overlayDarkenVisible(layers, mapDef) {
  return !!layers && !!layers.darkenGenerated && !!mapDef && mapDef.mode === 'procedural';
}

/**
 * The set of hex keys carrying an EXPLICIT overlay edit (procedural maps). These
 * are the author's preserved tiles — everything else on the rendered map came
 * from the regenerable generated base. Pure; exported so the darken overlay's
 * "generated vs edited" partition is unit-testable. Returns an empty Set for
 * handmade maps (every tile is authored there — nothing is "generated").
 */
export function overlayEditedKeys(mapDef) {
  const keys = new Set();
  if (!mapDef || mapDef.mode !== 'procedural') return keys;
  for (const t of mapDef.overlay?.tiles ?? []) keys.add(hexKey(t.col, t.row));
  return keys;
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
    hiddenSurvivorId: null,
    exploreOverride: null,
    roadDirs: [],
    // Building-footprint pair (P0+P1 data model): an ENTRANCE carries the keys
    // of its impassable footprint hex(es); a FOOTPRINT hex carries the "col,row"
    // key of its entrance. Both default empty/null on a blank tile.
    footprintHexes: [],
    buildingFootprintOf: null,
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
const _ROAD_KEY = _enumKey(PathType, PathType.ROAD);   // 'ROAD'
const _RIVER_KEY = _enumKey(PathType, PathType.RIVER); // 'RIVER'

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
    // Clearing a building also dissolves its footprint relationship (item 4):
    // the entrance's footprint hex(es) lose their impassable back-pointer.
    clearFootprintPair(mapDef, col, row);
  }
  return mapDef;
}

// ── Building footprints (P6) ─────────────────────────────────────────────────
// A footprinted building is a compound object: a passable ENTRANCE tile (carries
// `building` + a `footprintHexes` list) plus one impassable FOOTPRINT hex
// adjacent to it (carries `buildingFootprintOf` pointing back at the entrance).
// The shared eligibility rules live in src/building-footprint.js — these editor
// ops drive it against the current (built) map so a hand-placed footprint obeys
// the SAME constraints as procedural generation.

// Copy each def's footprint fields onto the matching built Tile. buildMissionMap
// (P5/Vega) does not yet carry these fields through `_applyTileDef`, so without
// this patch the eligibility check + road-regen snapshot would see a footprint-
// free map and (a) treat already-claimed hexes as eligible and (b) drop the
// footprint markers. Localised here so mission-map.js stays untouched.
function _patchFootprintFields(mapDef, tilesMap) {
  for (const def of _tileList(mapDef)) {
    const t = tilesMap.get(hexKey(def.col, def.row));
    if (!t) continue;
    if (Array.isArray(def.footprintHexes)) t.footprintHexes = [...def.footprintHexes];
    if ('buildingFootprintOf' in def) t.buildingFootprintOf = def.buildingFootprintOf ?? null;
  }
}

// Build the `{ tiles, witchObjectives }` context the footprint helper consumes:
// the fully-built map (so the generated base + every layer is known) with the
// def-list footprint claims patched in. Returns an empty context if the map
// can't build (malformed in-progress edit) so callers degrade to "no candidate".
function _footprintContext(mapDef) {
  let tiles;
  let witchObjectives;
  try {
    const built = buildMissionMap(mapDef);
    tiles = built.tiles;
    witchObjectives = built.witchObjectives ?? [];
  } catch {
    return { tiles: new Map(), witchObjectives: [] };
  }
  _patchFootprintFields(mapDef, tiles);
  return { tiles, witchObjectives };
}

/**
 * The hex that WOULD become a building's footprint if one were placed on
 * `(col,row)` right now — the first eligible neighbour in odd-r direction order
 * 0..5 (deterministic; no `rand`). Returns `{ col, row }` or null when no
 * adjacent hex is eligible. Pure read — used by both placement and the editor's
 * hover ghost overlay.
 */
export function footprintCandidate(mapDef, { col, row }) {
  return pickFootprintNeighbor(_footprintContext(mapDef), col, row);
}

/**
 * PLACE a building WITH a footprint (P6, item 1). Stamps the building on the
 * entrance (reusing {@link paintStructure}) AND claims the first eligible
 * adjacent hex as its impassable footprint — `entrance.footprintHexes=[fpKey]`
 * and `footprint.buildingFootprintOf=entranceKey`, mutually back-pointing.
 *
 * Returns `{ ok, warning }`:
 *   • no eligible neighbour → `{ ok:false }` and the model is left UNTOUCHED
 *     (the caller treats it as a no-op — no building placed).
 *   • re-painting onto an existing entrance only swaps the building TYPE, keeping
 *     the already-claimed footprint (so the type picker doesn't strand hexes).
 */
export function placeBuildingFootprint(mapDef, { col, row }, buildingKey) {
  if (!buildingKey) return paintStructure(mapDef, { col, row }, null);
  const existing = _tileList(mapDef).find(t => t.col === col && t.row === row);
  if (existing && Array.isArray(existing.footprintHexes) && existing.footprintHexes.length > 0) {
    // Already a footprinted entrance — just change the building type.
    paintStructure(mapDef, { col, row }, buildingKey);
    return { ok: true, warning: '' };
  }
  const fp = footprintCandidate(mapDef, { col, row });
  if (!fp) {
    return { ok: false, warning: 'No eligible adjacent hex for building footprint.' };
  }
  paintStructure(mapDef, { col, row }, buildingKey);
  const entranceKey = hexKey(col, row);
  const fpKey = hexKey(fp.col, fp.row);
  _getOrCreateTileDef(mapDef, col, row).footprintHexes = [fpKey];
  _getOrCreateTileDef(mapDef, fp.col, fp.row).buildingFootprintOf = entranceKey;
  return { ok: true, warning: '' };
}

// The direction-ordered (0..5) ring of footprint hexes a placed building may
// occupy: every currently-eligible neighbour PLUS its current footprint hex
// (which eligibility excludes because it's already claimed). Keys are "col,row".
function _footprintRing(mapDef, col, row, curKey) {
  const ctx = _footprintContext(mapDef);
  const eligible = new Set(
    eligibleFootprintNeighbors(ctx, col, row).map(h => hexKey(h.col, h.row)));
  if (curKey) eligible.add(curKey); // the current hex is a valid target to cycle through
  return getNeighbors(col, row)
    .map(n => hexKey(n.col, n.row))
    .filter(k => eligible.has(k));
}

/**
 * ROTATE a building's footprint to the NEXT eligible adjacent hex (P6, item 2),
 * cycling the 6 odd-r directions 0..5 and skipping ineligible hexes. Clears the
 * old footprint hex's back-pointer and sets the new one's. Returns `{ ok, warning }`:
 *   • not a building / no entrance → `{ ok:false }`, model untouched.
 *   • 0 or 1 eligible hex → `{ ok:false }` no-op (nothing to rotate to).
 */
export function rotateFootprint(mapDef, { col, row }) {
  const entrance = _tileList(mapDef).find(t => t.col === col && t.row === row);
  if (!entrance || !entrance.building) {
    return { ok: false, warning: 'Select a building to rotate its footprint.' };
  }
  const curKey = (Array.isArray(entrance.footprintHexes) && entrance.footprintHexes[0]) || null;
  const ring = _footprintRing(mapDef, col, row, curKey);
  if (ring.length <= 1) {
    return { ok: false, warning: 'No other eligible hex to rotate the footprint to.' };
  }
  const curIdx = curKey ? ring.indexOf(curKey) : -1;
  const nextKey = ring[(curIdx + 1) % ring.length];
  if (nextKey === curKey) {
    return { ok: false, warning: 'No other eligible hex to rotate the footprint to.' };
  }
  // Release the old footprint hex, claim the new one (mutually back-pointing).
  if (curKey) {
    const oldDef = _tileList(mapDef).find(t => hexKey(t.col, t.row) === curKey);
    if (oldDef) oldDef.buildingFootprintOf = null;
  }
  entrance.footprintHexes = [nextKey];
  const [nc, nr] = String(nextKey).split(',').map(Number);
  _getOrCreateTileDef(mapDef, nc, nr).buildingFootprintOf = hexKey(col, row);
  return { ok: true, warning: '' };
}

/**
 * Dissolve the footprint relationship anchored at `(col,row)`, whether it's an
 * ENTRANCE (clear each footprint hex's back-pointer + empty its own list) or a
 * FOOTPRINT hex (drop itself from its entrance's list + clear its own pointer).
 * Mutates the def list in place; safe no-op on a tile with no footprint role.
 */
export function clearFootprintPair(mapDef, col, row) {
  const list = _tileList(mapDef);
  const self = list.find(t => t.col === col && t.row === row);
  if (!self) return mapDef;
  if (Array.isArray(self.footprintHexes) && self.footprintHexes.length) {
    for (const fk of self.footprintHexes) {
      const fd = list.find(t => hexKey(t.col, t.row) === fk);
      if (fd) fd.buildingFootprintOf = null;
    }
    self.footprintHexes = [];
  }
  if (self.buildingFootprintOf != null) {
    const selfKey = hexKey(col, row);
    const ed = list.find(t => hexKey(t.col, t.row) === self.buildingFootprintOf);
    if (ed && Array.isArray(ed.footprintHexes)) {
      ed.footprintHexes = ed.footprintHexes.filter(k => k !== selfKey);
    }
    self.buildingFootprintOf = null;
  }
  return mapDef;
}

/**
 * PAINT_PATH — set the path overlay ∈ {none(null), ROAD, RIVER} (BRIDGE is no
 * longer an authored option — item 7: bridges are IMPLIED wherever a road
 * crosses a river, never hand-painted). Touches ONLY the path layer; base &
 * structure untouched (a road can sit over forest).
 *
 * An explicitly-painted ROAD now also WIRES UP `roadDirs` to its painted-road
 * neighbours (bidirectionally) so the road renders immediately — the renderer
 * draws road segments from each tile's roadDirs, so a road with no connectivity
 * was invisible (the old no-op feel). Clearing a road (or switching it to river)
 * unwires it from its neighbours so no dangling segment points at a non-road.
 */
export function paintPath(mapDef, { col, row }, pathKey) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  def.path = pathKey || null;
  if (def.path === _ROAD_KEY) _wireRoadConnections(mapDef, col, row);
  else _unwireRoadConnections(mapDef, col, row);
  return mapDef;
}

/**
 * ROAD tool (item 2) — paint path=ROAD and wire up roadDirs to painted-road
 * neighbours (the road-wiring half of the old combined Paint Path). Roads keep
 * their any-junction / MST behaviour: no topology constraint. Thin wrapper over
 * {@link paintPath} so the road-wiring stays in one place.
 */
export function paintRoad(mapDef, hex) {
  paintPath(mapDef, hex, _ROAD_KEY);
  return mapDef;
}

/**
 * RIVER tool (item 2) — paint path=RIVER unconditionally. River placement has no
 * topology constraint: a river tile can sit on any hex regardless of connectivity
 * or forking, so disjoint pieces can be freely connected by hand. Returns
 * `{ ok:true, warning:'' }` to match the dispatch/applyAt contract.
 */
export function paintRiver(mapDef, { col, row }) {
  paintPath(mapDef, { col, row }, _RIVER_KEY);
  return { ok: true, warning: '' };
}

// True when the tile def at (col,row) is an explicitly-painted ROAD.
function _isPaintedRoad(list, col, row) {
  const d = list.find(t => t.col === col && t.row === row);
  return !!d && d.path === _ROAD_KEY;
}

// Connect a painted-road tile to each painted-road neighbour, both directions,
// so the renderer draws the joining segments. roadDirs are hexKey strings.
function _wireRoadConnections(mapDef, col, row) {
  const list = _tileList(mapDef);
  const self = list.find(t => t.col === col && t.row === row);
  if (!self) return;
  if (!Array.isArray(self.roadDirs)) self.roadDirs = [];
  const selfKey = hexKey(col, row);
  for (const nb of getNeighbors(col, row)) {
    if (!_isPaintedRoad(list, nb.col, nb.row)) continue;
    const nbKey = hexKey(nb.col, nb.row);
    const nbDef = list.find(t => t.col === nb.col && t.row === nb.row);
    if (!self.roadDirs.includes(nbKey)) self.roadDirs.push(nbKey);
    if (!Array.isArray(nbDef.roadDirs)) nbDef.roadDirs = [];
    if (!nbDef.roadDirs.includes(selfKey)) nbDef.roadDirs.push(selfKey);
  }
}

// Drop a tile's own roadDirs and remove it from every neighbour's roadDirs.
function _unwireRoadConnections(mapDef, col, row) {
  const list = _tileList(mapDef);
  const selfKey = hexKey(col, row);
  const self = list.find(t => t.col === col && t.row === row);
  if (self) self.roadDirs = [];
  for (const nb of getNeighbors(col, row)) {
    const nbDef = list.find(t => t.col === nb.col && t.row === nb.row);
    if (nbDef && Array.isArray(nbDef.roadDirs)) {
      nbDef.roadDirs = nbDef.roadDirs.filter(k => k !== selfKey);
    }
  }
}

/**
 * DELETE (item 5) — clear a tile, with mode-aware semantics:
 *
 *   • OVERLAY (procedural): REVERT the hex to its GENERATED version by REMOVING
 *     any explicit overlay edit for it from `overlay.tiles`. buildMissionMap then
 *     falls back to the generated base tile. Deleting a hex with no overlay edit
 *     is a no-op (nothing to remove → still no overlay entry). This is the fix for
 *     the old behaviour, which wrote a blank def into overlay.tiles and so
 *     OVERRODE the generated tile with empty grass instead of reverting to it.
 *
 *   • HANDMADE (blank/baked): there's no generated base to revert to, so clear the
 *     tile back to a blank/base def: base→GRASS, structure/path/building/resource
 *     → none, hiddenSurvivor→false, fortifyLevel→0, roadDirs cleared.
 *
 * Either way, unwire the tile from any painted-road neighbours first (while the
 * def still exists) so no segment dangles into the cleared/reverted hex.
 */
export function deleteTile(mapDef, { col, row }) {
  // Dissolve any building footprint relationship FIRST (item 4) so the partner
  // hex's back-pointer is cleared atomically with the deletion, while both defs
  // still exist in the list.
  clearFootprintPair(mapDef, col, row);
  if (mapDef.mode === 'procedural') {
    // Unwire BEFORE dropping the def so neighbours lose their reference to it.
    _unwireRoadConnections(mapDef, col, row);
    const list = _tileList(mapDef);
    const i = list.findIndex(t => t.col === col && t.row === row);
    if (i >= 0) list.splice(i, 1); // revert to the generated base; no-op if absent
    return mapDef;
  }
  const def = _getOrCreateTileDef(mapDef, col, row);
  Object.assign(def, _blankTileDef(col, row));
  _unwireRoadConnections(mapDef, col, row);
  return mapDef;
}

/**
 * Place (or remove) a hidden survivor on a tile, optionally pinning a SPECIFIC
 * roster character via `survivorId` (the roster `name`; null/empty ⇒ "Any" =
 * the runtime's existing random pick). Click semantics mirror the other
 * placement tools:
 *   • empty hex          → place (hiddenSurvivor=true, id=survivorId)
 *   • same survivor again → remove (toggle off)
 *   • different survivor  → re-pin to the newly-selected id (overwrite)
 * so the picker can re-paint a hex without first clearing it.
 */
export function setHiddenSurvivor(mapDef, { col, row }, survivorId = null) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  const id = survivorId || null;
  if (def.hiddenSurvivor && (def.hiddenSurvivorId ?? null) === id) {
    def.hiddenSurvivor = false;
    def.hiddenSurvivorId = null;
  } else {
    def.hiddenSurvivor = true;
    def.hiddenSurvivorId = id;
  }
  return mapDef;
}

/** Toggle the hidden-survivor flag on a tile (legacy "Any" toggle). */
export function toggleHiddenSurvivor(mapDef, hex) {
  return setHiddenSurvivor(mapDef, hex, HIDDEN_SURVIVOR_ANY);
}

/**
 * List the authored hidden-survivor placements as `[{ col, row, id }]` (id null
 * ⇒ "Any"/random). Reads the active tile list (handmade `tiles` or procedural
 * `overlay.tiles`). DOM-free so the canvas-marker layer is unit-testable.
 */
export function hiddenSurvivorPlacements(mapDef) {
  const list = mapDef.mode === 'procedural'
    ? (mapDef.overlay?.tiles ?? [])
    : (mapDef.tiles ?? []);
  const out = [];
  for (const t of list) {
    if (t && t.hiddenSurvivor) out.push({ col: t.col, row: t.row, id: t.hiddenSurvivorId ?? null });
  }
  return out;
}

/**
 * Pin (or remove) a FIXED exploration-override result on a tile (M4). `key` is a
 * picker key (see {@link exploreOverridePickerOptions}); decoded into the stored
 * `{ kind, id, amount? }` shape. Click semantics mirror the other placement
 * tools:
 *   • empty hex          → pin the override
 *   • same override again → remove (toggle off)
 *   • different override → re-pin to the newly-selected result (overwrite)
 * `amount` (default 1) is only written when >1, keeping single-result JSON clean.
 */
export function setExploreOverride(mapDef, { col, row }, key, amount = 1) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  const next = parseExploreOverrideKey(key);
  if (next == null) return mapDef; // unknown key — leave untouched
  if (amount > 1) next.amount = amount;
  const curKey = def.exploreOverride ? exploreOverrideKeyFor(def.exploreOverride) : null;
  const curAmt = def.exploreOverride?.amount ?? 1;
  if (curKey === key && curAmt === amount) {
    def.exploreOverride = null; // toggle off when re-clicked with the same result
  } else {
    def.exploreOverride = next;
  }
  return mapDef;
}

/**
 * List the authored exploration overrides as `[{ col, row, override }]`. Reads the
 * active tile list (handmade `tiles` or procedural `overlay.tiles`). DOM-free so
 * the canvas-marker layer is unit-testable.
 */
export function exploreOverridePlacements(mapDef) {
  const list = mapDef.mode === 'procedural'
    ? (mapDef.overlay?.tiles ?? [])
    : (mapDef.tiles ?? []);
  const out = [];
  for (const t of list) {
    if (t && t.exploreOverride) out.push({ col: t.col, row: t.row, override: t.exploreOverride });
  }
  return out;
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

// ── Power-Node clustering (item 6) ───────────────────────────────────────────
// Power-node hexes that are CONTIGUOUS (hex-adjacent) collapse into ONE objective
// (one Power Node). Each cluster is capped at MAX_NODE_CLUSTER hexes; adding a
// hex that would grow OR merge a cluster past the cap is blocked. Every cluster
// carries an auto-assigned name (`label`) + `color` from NODE_COLORS (the same
// per-node palette the 3D renderer + 2D HUD score dots use); both survive an
// add/remove because metadata is inherited from the prior objective that shares
// the most hexes. The objective shape mirrors the runtime witchObjectives:
//   { col, row (anchor = cluster's first hex), hexes:[{col,row}…], label, color }

/** Max hexes allowed in a single Power-Node cluster. */
export const MAX_NODE_CLUSTER = 5;

// Flood-fill a flat hex list into contiguous clusters via hex adjacency.
// `hexes` is [{col,row}…]; returns an array of clusters (each a [{col,row}…]).
function _clusterHexes(hexes) {
  const remaining = new Map();
  for (const h of hexes) remaining.set(hexKey(h.col, h.row), { col: h.col, row: h.row });
  const clusters = [];
  while (remaining.size) {
    const [startKey, start] = remaining.entries().next().value;
    remaining.delete(startKey);
    const cluster = [start];
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of getNeighbors(cur.col, cur.row)) {
        const k = hexKey(nb.col, nb.row);
        if (remaining.has(k)) {
          const h = remaining.get(k);
          remaining.delete(k);
          cluster.push(h);
          stack.push(h);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// Pick the next palette colour not already taken this round; cycles when the
// palette is exhausted (so a 8th cluster reuses the 1st colour).
function _nextNodeColor(usedColors) {
  for (const c of NODE_COLORS) if (!usedColors.has(c)) return c;
  return NODE_COLORS[usedColors.size % NODE_COLORS.length];
}

// Pick the next free "Power Node N" name not already taken this round.
function _nextNodeLabel(usedLabels) {
  let n = 1;
  while (usedLabels.has(`Power Node ${n}`)) n++;
  return `Power Node ${n}`;
}

// Re-derive the objectives list from a flat power-node hex set, inheriting each
// cluster's name + colour from the prior objective it shares the most hexes with
// (so existing nodes keep their identity across an add/remove). Brand-new
// clusters get a fresh palette colour + auto name.
function _deriveObjectives(hexSet, prior) {
  const clusters = _clusterHexes(hexSet);
  // First pass: match each cluster to its best-overlapping prior objective.
  const matches = clusters.map(cluster => {
    const keys = new Set(cluster.map(h => hexKey(h.col, h.row)));
    let best = null;
    let bestShared = 0;
    for (const o of prior) {
      const shared = (o.hexes ?? []).reduce(
        (n, h) => n + (keys.has(hexKey(h.col, h.row)) ? 1 : 0), 0);
      if (shared > bestShared) { bestShared = shared; best = o; }
    }
    return { cluster, prior: bestShared > 0 ? best : null };
  });
  // A prior objective may only be inherited by ONE cluster (whichever shares
  // more of its hexes) — otherwise splitting a node would duplicate its name.
  const claimedPrior = new Set();
  for (const m of matches) {
    if (m.prior && !claimedPrior.has(m.prior)) claimedPrior.add(m.prior);
    else m.prior = null;
  }
  const usedColors = new Set();
  const usedLabels = new Set();
  for (const m of matches) {
    if (m.prior) {
      if (m.prior.color) usedColors.add(m.prior.color);
      if (m.prior.label) usedLabels.add(m.prior.label);
    }
  }
  return matches.map(({ cluster, prior: p }) => {
    const anchor = cluster[0];
    const label = p?.label ?? (() => { const l = _nextNodeLabel(usedLabels); usedLabels.add(l); return l; })();
    const color = p?.color ?? (() => { const c = _nextNodeColor(usedColors); usedColors.add(c); return c; })();
    return {
      col: anchor.col, row: anchor.row,
      hexes: cluster.map(h => ({ col: h.col, row: h.row })),
      label,
      color,
    };
  });
}

// Flatten the current objectives into a single power-node hex list.
function _objectiveHexSet(objs) {
  const out = [];
  for (const o of objs) for (const h of (o.hexes ?? [])) out.push({ col: h.col, row: h.row });
  return out;
}

function _replaceObjectives(mapDef, derived) {
  const objs = _witchObjectives(mapDef);
  objs.length = 0;
  for (const o of derived) objs.push(o);
}

/**
 * Toggle a Power-Node hex (item 6). Adding a hex contiguous to an existing
 * cluster GROWS that cluster (one objective); a non-contiguous hex starts a new
 * cluster. Removing recomputes clusters (which may split one node into two).
 * Blocked (returns `{ ok:false, warning }`, model untouched) when adding would
 * push a cluster past MAX_NODE_CLUSTER hexes. Returns `{ ok:true, warning:'' }`
 * on success.
 */
export function togglePowerNode(mapDef, { col, row }) {
  const objs = _witchObjectives(mapDef);
  const key = hexKey(col, row);
  const hexSet = _objectiveHexSet(objs);
  const present = hexSet.some(h => hexKey(h.col, h.row) === key);

  if (present) {
    const next = hexSet.filter(h => hexKey(h.col, h.row) !== key);
    _replaceObjectives(mapDef, _deriveObjectives(next, objs));
    return { ok: true, warning: '' };
  }

  // Adding: enforce the per-cluster cap on the tentative set.
  const tentative = [...hexSet, { col, row }];
  const newCluster = _clusterHexes(tentative).find(c => c.some(h => hexKey(h.col, h.row) === key));
  if (newCluster && newCluster.length > MAX_NODE_CLUSTER) {
    return { ok: false, warning: `Power Node clusters are capped at ${MAX_NODE_CLUSTER} hexes.` };
  }
  _replaceObjectives(mapDef, _deriveObjectives(tentative, objs));
  return { ok: true, warning: '' };
}

/** Rename a Power-Node cluster by index (item 6 rename field). No-op out of range. */
export function renamePowerNode(mapDef, index, name) {
  const objs = _witchObjectives(mapDef);
  if (index < 0 || index >= objs.length) return mapDef;
  objs[index].label = name;
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
    const footprintHexes = t.footprintHexes ? [...t.footprintHexes] : [];
    // A footprint hex keeps its open base terrain (it's just impassable via the
    // back-pointer), so include both footprint fields in the trivial guard or a
    // footprint-only hex would be dropped and the pair would break on reload.
    const trivial = baseKey === 'GRASS' && !structKey && !pathKey && !t.building &&
      !t.resource && !t.fortifyLevel && !t.hiddenSurvivor && !t.exploreOverride &&
      roadDirs.length === 0 && footprintHexes.length === 0 && !t.buildingFootprintOf;
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
      // Built runtime Tiles don't (yet) carry a specific-survivor id or explore
      // override, but pass them through defensively so a future runtime extension
      // round-trips here.
      hiddenSurvivorId: t.hiddenSurvivorId ?? null,
      exploreOverride: t.exploreOverride ?? null,
      roadDirs,
      footprintHexes,
      buildingFootprintOf: t.buildingFootprintOf ?? null,
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
  // buildMissionMap doesn't carry footprint fields (P5/Vega); re-apply them from
  // the def list so the regen→snapshot round-trip preserves placed footprints.
  _patchFootprintFields(mapDef, built.tiles);

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

/**
 * Resolve a standard map-size preset name (a MAP_SIZES key — skirmish / standard
 * / regional / campaign) to its `{ cols, rows }` dimensions. Returns null for an
 * unknown name (the New-map dialog treats that as "Custom"). Pure; exported so
 * the size-preset → X/Y prefill in the creation dialog is unit-testable without
 * the DOM (item 12).
 */
export function mapSizePreset(name) {
  const cfg = MAP_SIZES[name];
  if (!cfg) return null;
  return { cols: cfg.cols, rows: cfg.rows };
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
      // Building footprint links are "col,row" string keys too — shift them in
      // lockstep with the tile coords, or the entrance/footprint pair points at
      // stale cells and the save-time validator rejects it (item 9).
      ...(t.footprintHexes ? { footprintHexes: t.footprintHexes.map(k => _shiftKey(k, dCol, dRow)) } : {}),
      ...(t.buildingFootprintOf != null ? { buildingFootprintOf: _shiftKey(t.buildingFootprintOf, dCol, dRow) } : {}),
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

// ── npcs / conversations list ops (campaign conversation system) ─────────────
// Scripted NPCs and conversations ride in `meta` (populateFromMission keeps
// every non-map field there), so these are plain list ops like the
// storyTrigger ones above. The conversation markdown files themselves are
// hand-authored under src/campaign/conversations/ — the editor only
// references them by file id.

/** Append a scripted NPC def. `entry` overrides fields. */
export function addNpc(meta, entry = {}) {
  if (!Array.isArray(meta.npcs)) meta.npcs = [];
  meta.npcs.push({ id: `npc_${meta.npcs.length + 1}`, survivorName: null, col: 0, row: 0, ...entry });
  return meta;
}

export function removeNpc(meta, idx) {
  if (Array.isArray(meta.npcs) && idx >= 0 && idx < meta.npcs.length) {
    meta.npcs.splice(idx, 1);
  }
  return meta;
}

/** Append a conversation def. `entry` overrides fields. */
export function addConversation(meta, entry = {}) {
  if (!Array.isArray(meta.conversations)) meta.conversations = [];
  meta.conversations.push({
    id: `conversation_${meta.conversations.length + 1}`,
    file: '',
    bindings: {},
    onComplete: [],
    ...entry,
  });
  return meta;
}

export function removeConversation(meta, idx) {
  if (Array.isArray(meta.conversations) && idx >= 0 && idx < meta.conversations.length) {
    meta.conversations.splice(idx, 1);
  }
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

// ── Phase-cycle ops (item 9) ────────────────────────────────────────────────
// The phaseCycle shape is `{ phases: string[], loop: boolean }`. `phases` is an
// ordered sequence of phase keys drawn from PHASE_KINDS; EC's timeline tab reads
// this same array to lay out its day/night track, so these ops keep the shape
// clean (no nulls, no unknown phase keys leaking in). All mutate `meta` in place.

/** The four canonical phase keys, in natural cycle order, for the chip palette. */
export const PHASE_KINDS = Object.freeze(['dawn', 'day', 'dusk', 'night']);

function _phaseCycle(meta) {
  if (!meta.phaseCycle || typeof meta.phaseCycle !== 'object') {
    meta.phaseCycle = { phases: [], loop: true };
  }
  if (!Array.isArray(meta.phaseCycle.phases)) meta.phaseCycle.phases = [];
  return meta.phaseCycle;
}

/** Append a phase chip to the cycle. Ignores keys outside PHASE_KINDS. */
export function addPhase(meta, phase) {
  if (!PHASE_KINDS.includes(phase)) return meta;
  _phaseCycle(meta).phases.push(phase);
  return meta;
}

/** Remove the phase chip at `idx`. No-op out of range. */
export function removePhaseAt(meta, idx) {
  const pc = _phaseCycle(meta);
  if (idx >= 0 && idx < pc.phases.length) pc.phases.splice(idx, 1);
  return meta;
}

/** Reorder a phase chip by `dir` (−1 left, +1 right). No-op at the edges. */
export function movePhase(meta, idx, dir) {
  const pc = _phaseCycle(meta);
  const j = idx + dir;
  if (idx < 0 || idx >= pc.phases.length || j < 0 || j >= pc.phases.length) return meta;
  [pc.phases[idx], pc.phases[j]] = [pc.phases[j], pc.phases[idx]];
  return meta;
}

/** Set the loop flag (whether the cycle repeats after its last phase). */
export function setPhaseLoop(meta, loop) {
  _phaseCycle(meta).loop = !!loop;
  return meta;
}

// ── Timeline model (EC) ─────────────────────────────────────────────────────
// Pure data layer for the timeline tab. The timeline lays out rounds 1..span as
// a day/night track (each round's phase walked from phaseCycle) with round-based
// events (round storyTriggers + round waves) placed on their rounds. Area
// triggers and non-round waves are surfaced SEPARATELY — they're position- /
// condition-based, not round-based, so they're never forced onto a round.

/**
 * The phase key for a 1-based `round`, walking `phaseCycle.phases` in order.
 * Mirrors game.js `phaseForRound`: a looping cycle wraps with modulo; a
 * non-looping cycle CLAMPS to the last phase for rounds past the array's end.
 * Returns null for an empty/absent cycle or a non-positive round.
 *
 * @param {{phases?: string[], loop?: boolean}} phaseCycle
 * @param {number} round  1-based round number
 */
export function timelinePhaseForRound(phaseCycle, round) {
  const phases = phaseCycle?.phases;
  if (!Array.isArray(phases) || phases.length === 0) return null;
  const idx = round - 1;
  if (idx < 0) return null;
  if (phaseCycle.loop) return phases[idx % phases.length];
  return phases[Math.min(idx, phases.length - 1)];
}

/**
 * How many rounds the timeline shows: at least `minRounds`, extended to cover
 * the phase-cycle length AND the highest round any round-based event references
 * (so an event at round 20 is always visible). Non-round events don't extend it.
 *
 * @param {object} meta
 * @param {number} [minRounds=8]  floor (≈ one standard day/night cycle)
 */
export function timelineRoundSpan(meta, minRounds = 8) {
  let span = Math.max(minRounds, meta?.phaseCycle?.phases?.length ?? 0);
  for (const tr of meta?.storyTriggers ?? []) {
    if (tr?.type === 'round' && Number.isFinite(tr.round)) span = Math.max(span, tr.round);
  }
  for (const w of meta?.waves ?? []) {
    if (w?.trigger === 'round' && Number.isFinite(w.round)) span = Math.max(span, w.round);
  }
  return span;
}

/**
 * Build the timeline model from `meta`:
 *   • `rounds` — one descriptor per round 1..span: `{ round, phase, story[], waves[] }`
 *     where `story`/`waves` carry `{ index, trigger|wave }` (the source-array index,
 *     so edit/remove route back to meta.storyTriggers / meta.waves precisely).
 *   • `areaTriggers` — `{ index, trigger }` for type:'area' storyTriggers (they
 *     fire on-enter, no round — shown in their own lane).
 *   • `offRoundWaves` — `{ index, wave }` for waves whose trigger isn't 'round'
 *     (hero_kills / area) — also non-round, kept off the round lanes.
 *
 * @param {object} meta
 * @param {number} [minRounds=8]
 */
export function buildTimelineModel(meta, minRounds = 8) {
  const span = timelineRoundSpan(meta, minRounds);
  const phaseCycle = meta?.phaseCycle ?? { phases: [], loop: true };
  const rounds = [];
  for (let r = 1; r <= span; r++) {
    rounds.push({ round: r, phase: timelinePhaseForRound(phaseCycle, r), story: [], waves: [] });
  }
  (meta?.storyTriggers ?? []).forEach((tr, index) => {
    if (tr?.type !== 'round') return;
    const r = tr.round ?? 1;
    if (r >= 1 && r <= span) rounds[r - 1].story.push({ index, trigger: tr });
  });
  (meta?.waves ?? []).forEach((w, index) => {
    if (w?.trigger !== 'round') return;
    const r = w.round ?? 1;
    if (r >= 1 && r <= span) rounds[r - 1].waves.push({ index, wave: w });
  });
  const areaTriggers = (meta?.storyTriggers ?? [])
    .map((trigger, index) => ({ index, trigger }))
    .filter(({ trigger }) => trigger?.type === 'area');
  const offRoundWaves = (meta?.waves ?? [])
    .map((wave, index) => ({ index, wave }))
    .filter(({ wave }) => wave?.trigger && wave.trigger !== 'round');
  return { span, rounds, areaTriggers, offRoundWaves };
}

// ── Resources / rewards picker transforms (item 8) ──────────────────────────
// startingResources + rewards are `{ [ResourceType]: amount }` maps. The picker
// edits them as ordered rows of `{ type, amount }`; these are the lossless
// inverse pair the picker round-trips through (and what the tests pin).

/** A resource map → ordered picker rows. */
export function resourceMapToRows(obj) {
  return Object.entries(obj ?? {}).map(([type, amount]) => ({ type, amount }));
}

/** Picker rows → a resource map. Skips blank/typeless rows; later rows win on
 *  duplicate type (last write). Amounts coerce to numbers. */
export function rowsToResourceMap(rows) {
  const out = {};
  for (const r of rows ?? []) {
    if (!r || !r.type) continue;
    out[r.type] = Number(r.amount) || 0;
  }
  return out;
}

// ── lootOverrides picker transforms (item 8) ────────────────────────────────
// lootOverrides is `{ add?: string[], remove?: string[], ...rest }` where `rest`
// may carry richer keys (e.g. per-building weighted tables) the picker leaves
// untouched. The picker edits the add/remove id lists; `rest` rides along so the
// round-trip is lossless even for fields the picker doesn't surface.

/** lootOverrides object → picker model `{ add, remove, rest }`. */
export function lootOverridesToPicker(lo) {
  const { add = [], remove = [], ...rest } = lo ?? {};
  return { add: [...add], remove: [...remove], rest };
}

/** Picker model → lootOverrides object (or null when fully empty). Only emits
 *  add/remove keys when non-empty so a `{remove:[…]}`-shaped input round-trips
 *  without gaining an empty `add`. */
export function pickerToLootOverrides({ add = [], remove = [], rest = {} } = {}) {
  const out = { ...rest };
  if (add.length) out.add = [...add];
  if (remove.length) out.remove = [...remove];
  return Object.keys(out).length ? out : null;
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

// ── WIP autosave store (localStorage-backed) ─────────────────────────────────
// As the author edits, the editor periodically serialises the working mission
// (the SAME assembled schema:1 JSON that download/validate use) into browser
// localStorage so an accidental reload/close doesn't lose work. Entries are
// namespaced and keyed by mission id — one slot per named mission, so re-saving
// the same mission overwrites in place rather than growing unbounded. A global
// cap evicts the oldest drafts beyond `WIP_MAX_SLOTS`.
//
// All helpers take an injected `storage` (a localStorage-like object exposing
// getItem / setItem / removeItem / key / length) so they're unit-testable with a
// plain stub and never touch a real DOM. Every read is guarded: a corrupt or
// schema-incompatible entry is skipped (and purged) rather than crashing the
// editor.

export const WIP_KEY_PREFIX = 'brimstone:mission-editor:wip:';
/** The mission-JSON schema this editor reads/writes. WIP entries with a
 *  different `mission.schema` are treated as incompatible and discarded. */
export const WIP_SCHEMA = 1;
/** Maximum distinct WIP drafts retained; the oldest beyond this are evicted. */
export const WIP_MAX_SLOTS = 12;

/** localStorage key for a WIP draft of mission `id`. */
export function wipStorageKey(id) {
  return WIP_KEY_PREFIX + String(id ?? 'mission');
}

/**
 * Wrap an assembled mission in the stored envelope: `{ id, name, savedAt,
 * mission }`. `id`/`name` are derived from the mission so the launch picker can
 * label drafts without re-parsing the whole map.
 */
export function makeWipEntry(mission, { name, savedAt } = {}) {
  const id = (mission && mission.id != null) ? String(mission.id) : 'mission';
  return {
    id,
    name: name || (mission && mission.title) || id,
    savedAt: typeof savedAt === 'number' ? savedAt : Date.now(),
    mission,
  };
}

// Collect the localStorage keys belonging to WIP drafts. Snapshotted up front so
// callers can removeItem() during iteration without index-shift surprises.
function _wipKeys(storage) {
  const keys = [];
  const n = storage.length ?? 0;
  for (let i = 0; i < n; i++) {
    const k = storage.key(i);
    if (typeof k === 'string' && k.startsWith(WIP_KEY_PREFIX)) keys.push(k);
  }
  return keys;
}

// Parse one stored entry; returns a normalised envelope or null when the slot is
// missing, unparseable, or schema-incompatible (so corrupt data never crashes).
function _readWipAt(storage, key) {
  let raw;
  try { raw = storage.getItem(key); } catch { return null; }
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed.mission;
  if (!m || typeof m !== 'object') return null;
  // Incompatible schema → discard rather than feed bad data into the model.
  if (m.schema != null && m.schema !== WIP_SCHEMA) return null;
  return {
    id: parsed.id != null ? String(parsed.id) : (m.id != null ? String(m.id) : 'mission'),
    name: parsed.name || m.title || (parsed.id != null ? String(parsed.id) : 'mission'),
    savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    mission: m,
  };
}

/**
 * Persist `mission` (an assembled schema:1 JSON object) as a WIP draft, then
 * evict the oldest drafts beyond `cap`. No-op (returns null) when there's no
 * storage or the write fails (e.g. quota exceeded). Returns the stored envelope.
 */
export function saveWip(storage, mission, opts = {}) {
  if (!storage || !mission) return null;
  const entry = makeWipEntry(mission, opts);
  try {
    storage.setItem(wipStorageKey(entry.id), JSON.stringify(entry));
  } catch {
    return null; // quota / serialisation failure — keep editing, just don't persist
  }
  evictWip(storage, opts.cap ?? WIP_MAX_SLOTS);
  return entry;
}

/** All valid WIP drafts, newest first. Corrupt/incompatible entries are skipped. */
export function listWip(storage) {
  if (!storage) return [];
  const out = [];
  for (const k of _wipKeys(storage)) {
    const e = _readWipAt(storage, k);
    if (e) out.push(e);
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

/** Load a single WIP draft by id, or null if missing/corrupt/incompatible. */
export function loadWip(storage, id) {
  if (!storage) return null;
  return _readWipAt(storage, wipStorageKey(id));
}

/** Delete a WIP draft by id. Silent on any storage error. */
export function removeWip(storage, id) {
  if (!storage) return;
  try { storage.removeItem(wipStorageKey(id)); } catch { /* ignore */ }
}

/**
 * Trim the WIP store to at most `cap` drafts, evicting the oldest by `savedAt`.
 * Corrupt/incompatible entries are purged in the same pass (they can't be
 * resumed anyway and would otherwise occupy a slot forever).
 */
export function evictWip(storage, cap = WIP_MAX_SLOTS) {
  if (!storage) return;
  const live = [];
  for (const k of _wipKeys(storage)) {
    const e = _readWipAt(storage, k);
    if (!e) { try { storage.removeItem(k); } catch { /* ignore */ } continue; }
    live.push({ key: k, savedAt: e.savedAt });
  }
  if (live.length <= cap) return;
  live.sort((a, b) => a.savedAt - b.savedAt); // oldest first
  for (let i = 0; i < live.length - cap; i++) {
    try { storage.removeItem(live[i].key); } catch { /* ignore */ }
  }
}

// ── Controller ───────────────────────────────────────────────────────────────

const _TOOL_DISPATCH = {
  [EditorTool.PAINT_BASE]: (m, hex, pv) => paintBase(m.mapDef, hex, pv.base),
  // Placing a building auto-claims a footprint (item 1) — returns { ok, warning }
  // so applyAt surfaces (and no-ops) the "no eligible adjacent hex" case. The
  // "None" value (null) clears the building (+ dissolves its footprint pair).
  [EditorTool.PAINT_STRUCTURE]: (m, hex, pv) => placeBuildingFootprint(m.mapDef, hex, pv.structure),
  // Road: any-junction wiring. River: unconditional paint (no topology gate) —
  // returns { ok:true, warning:'' } for the applyAt contract.
  [EditorTool.PAINT_ROAD]: (m, hex) => paintRoad(m.mapDef, hex),
  [EditorTool.PAINT_RIVER]: (m, hex) => paintRiver(m.mapDef, hex),
  [EditorTool.HIDDEN_SURVIVOR]: (m, hex, pv) => setHiddenSurvivor(m.mapDef, hex, pv.survivor),
  [EditorTool.EXPLORE_OVERRIDE]: (m, hex, pv) => setExploreOverride(m.mapDef, hex, pv.exploreOverride),
  [EditorTool.ENEMY_UNIT]: (m, hex, pv) => placeEnemyUnit(m.enemyUnits, hex, pv.enemyType),
  [EditorTool.HERO_START]: (m, hex) => setHeroStart(m.mapDef, hex),
  [EditorTool.WITCH_START]: (m, hex) => setWitchStart(m.mapDef, hex),
  // Toggling a road node AUTO-regenerates the handmade road network (item 8) —
  // no manual "Regenerate Roads" click needed. No-op regen on overlay maps
  // (those regen at build time anyway).
  [EditorTool.ROAD_NODE]: (m, hex) => { toggleRoadNode(m.mapDef, hex); regenerateHandmadeRoads(m.mapDef); },
  // POWER_NODE returns { ok, warning } — applyAt surfaces a blocked cluster cap.
  [EditorTool.POWER_NODE]: (m, hex) => togglePowerNode(m.mapDef, hex),
  [EditorTool.DELETE]: (m, hex) => deleteTile(m.mapDef, hex),
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
    enemyType: ENEMY_UNIT_TYPES[0],
    // Hidden-survivor picker selection (roster `name`; null ⇒ "Any"/random).
    survivor: HIDDEN_SURVIVOR_ANY,
    // Exploration-override picker selection (encoded key; default: pin Wood).
    exploreOverride: 'resource:wood',
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
    /** Mutate the enemyUnits array in place as ONE undo step (edit/delete a
     *  placed unit's type/level, or splice it out — item 8 edit mode). */
    editEnemyUnits(mutator) { snapshot(); mutator(enemyUnits); emit(); },
    /** The placed enemy unit at a hex, or undefined. */
    enemyUnitAt({ col, row }) { return enemyUnits.find(u => u.col === col && u.row === row); },
    getMeta: () => meta,
    setMeta(m) { snapshot(); meta = m; emit(); },
    /**
     * Run `mutator(meta)` as ONE undo step (snapshot → mutate-in-place → emit).
     * The EC timeline routes its storyTrigger/wave authoring through this so each
     * add/edit/remove is a discrete, undoable change to meta.storyTriggers /
     * meta.waves — reusing the same list ops the sidebar forms call.
     */
    editMeta(mutator) { snapshot(); mutator(meta); emit(); },

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
    /**
     * Apply the active tool to a hex. No-op outside bounds. Returns
     * `{ ok, warning }` so callers can surface a blocked edit (e.g. the
     * Power-Node 5-hex cap). A blocked edit leaves the model AND the
     * undo/redo history untouched.
     */
    applyAt(hex) {
      if (!hex || !_inBounds(hex)) return { ok: true, warning: '' };
      const fn = _TOOL_DISPATCH[activeTool];
      if (!fn) return { ok: true, warning: '' };
      const redoBackup = redoStack.slice();
      snapshot();
      const res = fn(model(), { col: hex.col, row: hex.row }, paintValues);
      if (res && res.ok === false) {
        // Blocked: discard the snapshot + restore the redo stack (no mutation).
        undoStack.pop();
        redoStack.length = 0;
        for (const s of redoBackup) redoStack.push(s);
        return res;
      }
      emit();
      return (res && typeof res === 'object' && 'ok' in res) ? res : { ok: true, warning: '' };
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

    // ── Power Nodes (item 6) ─────────────────────────────────────────────
    /** The current Power-Node clusters (witchObjectives) — read-only view. */
    getPowerNodes: () => _witchObjectives(mapDef),
    /** Rename a Power-Node cluster by index. One undo step. */
    renamePowerNode(index, name) {
      snapshot();
      renamePowerNode(mapDef, index, name);
      emit();
    },

    // ── Building footprints (P6) ─────────────────────────────────────────
    /**
     * The hex that WOULD become the footprint if a building were placed on `hex`
     * right now (first eligible neighbour, dir 0..5), or null. Read-only — drives
     * the hover ghost overlay.
     */
    footprintCandidateAt(hex) {
      if (!hex) return null;
      return footprintCandidate(mapDef, { col: hex.col, row: hex.row });
    },
    /**
     * Rotate the footprint of the building at `hex` to the next eligible adjacent
     * hex (one undo step). Mirrors applyAt's blocked-edit contract: a no-op (no
     * other eligible hex / not a building) leaves the model AND history untouched.
     * Returns `{ ok, warning }`.
     */
    rotateFootprintAt(hex) {
      if (!hex || !_inBounds(hex)) return { ok: false, warning: '' };
      const redoBackup = redoStack.slice();
      snapshot();
      const res = rotateFootprint(mapDef, { col: hex.col, row: hex.row });
      if (res && res.ok === false) {
        undoStack.pop();
        redoStack.length = 0;
        for (const s of redoBackup) redoStack.push(s);
        return res;
      }
      emit();
      return res ?? { ok: true, warning: '' };
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
    // Form fields edit getMeta()'s object in place (bypassing emit), so the UI
    // marks the model dirty explicitly on those change events — this is what the
    // WIP autosave gates on. Pure flag flip; no render.
    markDirty() { dirty = true; },
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
