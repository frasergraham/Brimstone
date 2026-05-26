// ═══════════════════════════════════════════════════════════════════════════
// JSON mission loader + validator
// ─────────────────────────────────────────────────────────────────────────────
// `loadMissionJSON(parsed)` is the SHARED validator/loader for the data-driven
// JSON mission format (schema:1). It takes an already-parsed object (so both the
// browser `fetch` path and the node `fs` path share it), VALIDATES it, and
// returns a runtime mission def with `storyTrigger.condition` string keys
// resolved to predicate functions. The raw `map` sub-object is left intact — the
// runtime (`_initCampaignMission`) calls `buildMissionMap(map)` itself.
//
// This module is also the mission editor's last line of defense before a bad
// mission is downloaded: the editor assembles a mission JSON and runs it through
// `loadMissionJSON` (catching the thrown error) before allowing the download.
//
// VALIDATION HARDENING (the four holes flagged in the P2/P5 reviews):
//   1. A tile placed beyond the map extent (handmade cols/rows, or the
//      procedural mapSize extent) fails — it would otherwise NPE / vanish.
//   2. An unknown `objectives.win.type` / `objectives.lose.type` fails — it
//      would otherwise silently never win/lose in-game.
//   3. A handmade map without a `heroStart` (or `witchStart` when `hasWitch`)
//      fails — the GameState constructor NPEs on a null start otherwise.
//   4. (round-trip, not a reject) `map.roadSeed` is carried verbatim — handmade
//      road regen determinism depends on it, so it must survive save→load. This
//      is preserved by passing `map` through whole; there is nothing to validate.
// ═══════════════════════════════════════════════════════════════════════════

import { resolveCondition } from './condition-registry.js';
import { ObjectiveType } from './missions.js';
import { MAP_SIZES } from '../map.js';

// All objective `type` values the victory delegate accepts. `ObjectiveType`
// (missions.js) is the public *subset*; the full set the runtime actually
// handles lives in the `switch` inside `buildVictoryDelegate()`
// (src/campaign/campaign.js). THAT SWITCH IS THE SOURCE OF TRUTH — keep this set
// in sync with it. Validating against the narrow enum alone would wrongly reject
// shipped missions (e.g. `gather_and_survive`, `survive_with_party`).
export const KNOWN_OBJECTIVE_TYPES = Object.freeze(new Set([
  ...Object.values(ObjectiveType),
  'phase_without_survivors',
  'survivors_below',
  'witch_holds_node',
  'witch_score_threshold',
  'gather_and_survive',
  'survive_with_party',
  'all_party_at_hexes',
  'witch_denied_nodes',
  'hero_holds_all_nodes',
  'conductor_complete',
]));

/** Validation failure. Carries a human-readable message for the editor to show. */
export class MissionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissionValidationError';
  }
}

const _fail = (msg) => { throw new MissionValidationError(msg); };

const _isInt = (n) => Number.isInteger(n);
const _isHex = (h) => h && typeof h === 'object' && _isInt(h.col) && _isInt(h.row);

// The map's authoring extent: explicit cols/rows for handmade, the seeded
// mapSize's grid for procedural (overlay edits cannot grow the grid).
function _mapExtent(map) {
  if (map.mode === 'handmade') return { cols: map.cols, rows: map.rows };
  const cfg = MAP_SIZES[map.mapSize] ?? MAP_SIZES.standard;
  return { cols: cfg.cols, rows: cfg.rows };
}

const _inBounds = (h, ext) =>
  _isHex(h) && h.col >= 0 && h.row >= 0 && h.col < ext.cols && h.row < ext.rows;

// `lose` may be a single objective or an array of them; `win` is normally a
// single objective. Normalise both to an array for validation.
function _objectiveList(side) {
  if (Array.isArray(side)) return side;
  return side ? [side] : [];
}

function _validateObjectiveSide(side, label) {
  const objs = _objectiveList(side);
  if (label === 'win' && objs.length === 0) _fail('objectives.win is required');
  for (const o of objs) {
    if (!o || typeof o.type !== 'string') {
      _fail(`objectives.${label} entry must have a string "type"`);
    }
    if (!KNOWN_OBJECTIVE_TYPES.has(o.type)) {
      _fail(`unknown objective type "${o.type}" in objectives.${label}`);
    }
  }
}

/**
 * Validate a parsed mission object against the schema:1 contract. Throws a
 * {@link MissionValidationError} with a clear message on the first problem;
 * returns the (unmodified) input on success.
 */
export function validateMissionJSON(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) _fail('mission must be an object');
  if (m.schema !== 1) _fail(`unsupported schema "${m.schema}" (expected 1)`);
  if (typeof m.id !== 'string' || !m.id.trim()) _fail('mission.id must be a non-empty string');

  const map = m.map;
  if (!map || typeof map !== 'object') _fail('mission.map is required');
  if (map.mode !== 'handmade' && map.mode !== 'procedural') {
    _fail(`unknown map mode "${map.mode}" (expected "handmade" or "procedural")`);
  }

  const ext = _mapExtent(map);
  if (!_isInt(ext.cols) || !_isInt(ext.rows) || ext.cols <= 0 || ext.rows <= 0) {
    _fail('map extent (cols/rows) is missing or invalid');
  }

  // Hardening #1 — every authored tile must sit inside the map extent.
  const tileList = map.mode === 'handmade' ? (map.tiles ?? []) : (map.overlay?.tiles ?? []);
  for (const t of tileList) {
    if (!_inBounds(t, ext)) {
      _fail(`tile (${t.col},${t.row}) is outside the ${ext.cols}×${ext.rows} map extent`);
    }
  }

  // Hardening #3 — handmade maps must define their starts (the procedural base
  // always produces starts, so only handmade can be missing them).
  if (map.mode === 'handmade') {
    if (!_isHex(map.heroStart)) _fail('handmade map must define a heroStart {col,row}');
    if (!_inBounds(map.heroStart, ext)) _fail('heroStart is outside the map extent');
    if (m.hasWitch) {
      if (!_isHex(map.witchStart)) _fail('hasWitch mission must define a witchStart {col,row}');
      if (!_inBounds(map.witchStart, ext)) _fail('witchStart is outside the map extent');
    }
  }

  // Placed entities must also sit on the map.
  for (const u of m.enemyUnits ?? []) {
    if (!_inBounds(u, ext)) {
      _fail(`enemyUnit at (${u.col},${u.row}) is outside the ${ext.cols}×${ext.rows} map extent`);
    }
  }
  for (const s of m.survivorStartPositions ?? []) {
    if (!_inBounds(s, ext)) {
      _fail(`survivorStartPosition (${s.col},${s.row}) is outside the map extent`);
    }
  }

  // Hardening #2 — objective types must be ones the victory delegate handles.
  if (!m.objectives || typeof m.objectives !== 'object') _fail('mission.objectives is required');
  _validateObjectiveSide(m.objectives.win, 'win');
  if (m.objectives.lose != null) _validateObjectiveSide(m.objectives.lose, 'lose');

  // Story-trigger conditions are STRING keys into the condition registry.
  for (const tr of m.storyTriggers ?? []) {
    if (tr.condition == null) continue;
    if (typeof tr.condition !== 'string') _fail('storyTrigger.condition must be a string key');
    if (!resolveCondition(tr.condition)) _fail(`unknown story condition "${tr.condition}"`);
  }

  return m;
}

/**
 * Validate and resolve a parsed JSON mission into a runtime mission def.
 *
 * On success returns a shallow copy with `storyTrigger.condition` string keys
 * resolved to predicate functions; the raw `map` sub-object is preserved so the
 * runtime can call `buildMissionMap(def.map)`. Throws {@link MissionValidationError}
 * on any validation failure.
 *
 * @param {object} parsed - already-parsed mission JSON.
 * @returns {object} runtime mission def.
 */
export function loadMissionJSON(parsed) {
  validateMissionJSON(parsed);
  const storyTriggers = (parsed.storyTriggers ?? []).map(tr =>
    tr.condition ? { ...tr, condition: resolveCondition(tr.condition) } : { ...tr });
  return { ...parsed, storyTriggers };
}
