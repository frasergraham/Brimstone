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

import { TileType, BuildingType, ResourceType } from '../tiles.js';
import { hexKey } from '../hex.js';
import { rng } from '../map.js';
import { buildMissionMap, rederiveRoads } from '../campaign/mission-map.js';

/** Active-tool ids the click loop dispatches on. */
export const EditorTool = Object.freeze({
  PAINT_TILE: 'paint-tile',
  SET_BUILDING: 'set-building',
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

// A blank, COMPLETE tile def (rule #1) — all fields explicit.
function _blankTileDef(col, row) {
  return {
    col, row,
    type: _enumKey(TileType, TileType.GRASS),
    building: null,
    resource: null,
    fortifyLevel: 0,
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

/** Paint a terrain tile. Painting a non-building type clears any building. */
export function paintTile(mapDef, { col, row }, tileTypeKey) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  def.type = tileTypeKey;
  if (tileTypeKey !== 'BUILDING') def.building = null;
  return mapDef;
}

/** Set (or clear) a building. A building forces type=BUILDING; clearing it
 *  reverts a building tile back to grass so the def stays coherent. */
export function setBuilding(mapDef, { col, row }, buildingKey) {
  const def = _getOrCreateTileDef(mapDef, col, row);
  if (buildingKey) {
    def.building = buildingKey;
    def.type = 'BUILDING';
  } else {
    def.building = null;
    if (def.type === 'BUILDING') def.type = _enumKey(TileType, TileType.GRASS);
  }
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

// Serialise a built Tile Map back to COMPLETE tile defs in uppercase KEY form,
// dropping plain-grass tiles (buildMissionMap re-fills those). Lossless for
// everything non-trivial: terrain, buildings, resources, fortify, hidden
// survivors, and derived roadDirs.
export function snapshotTiles(tilesMap) {
  const out = [];
  for (const t of tilesMap.values()) {
    const typeKey = _enumKey(TileType, t.type);
    const roadDirs = t.roadDirs ? [...t.roadDirs] : [];
    const trivial = typeKey === 'GRASS' && !t.building && !t.resource &&
      !t.fortifyLevel && !t.hiddenSurvivor && roadDirs.length === 0;
    if (trivial) continue;
    out.push({
      col: t.col, row: t.row,
      type: typeKey,
      building: _enumKey(BuildingType, t.building),
      resource: _enumKey(ResourceType, t.resource),
      fortifyLevel: t.fortifyLevel || 0,
      hiddenSurvivor: !!t.hiddenSurvivor,
      roadDirs,
    });
  }
  return out;
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
    if (t.type === TileType.BUILDING || t.type === TileType.BRIDGE) {
      nodeKeys.add(hexKey(t.col, t.row));
    }
  }

  rederiveRoads(built.tiles, nodeKeys, rng(mapDef.roadSeed ?? HANDMADE_ROAD_SEED));
  mapDef.tiles = snapshotTiles(built.tiles);
  return mapDef;
}

// ── Mode toggle ──────────────────────────────────────────────────────────────

/** A fresh handmade default map: a small grass grid with sensible starts. */
export function createDefaultMapDef() {
  return {
    mode: 'handmade',
    cols: 9,
    rows: 9,
    heroStart: { col: 2, row: 6 },
    witchStart: { col: 6, row: 2 },
    witchObjectives: [],
    roadNodes: [],
    tiles: [],
  };
}

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
  [EditorTool.PAINT_TILE]: (m, hex, pv) => paintTile(m.mapDef, hex, pv.tile),
  [EditorTool.SET_BUILDING]: (m, hex, pv) => setBuilding(m.mapDef, hex, pv.building),
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
  let activeTool = EditorTool.PAINT_TILE;
  const paintValues = {
    tile: _enumKey(TileType, TileType.GRASS),
    building: _enumKey(BuildingType, BuildingType.HOUSE),
    resource: _enumKey(ResourceType, ResourceType.HERBS),
    enemyType: ENEMY_UNIT_TYPES[0],
  };
  const undoStack = [];

  const emit = () => { if (render) render(); };
  const model = () => ({ mapDef, enemyUnits });

  // Snapshot the full serialisable model before each edit (undo).
  function snapshot() {
    undoStack.push(JSON.stringify({ mapDef, enemyUnits, meta }));
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

    // ── Undo ─────────────────────────────────────────────────────────────
    canUndo: () => undoStack.length > 0,
    undo() {
      if (undoStack.length === 0) return false;
      const prev = JSON.parse(undoStack.pop());
      mapDef = prev.mapDef;
      enemyUnits = prev.enemyUnits;
      if (prev.meta) meta = prev.meta;
      emit();
      return true;
    },
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
