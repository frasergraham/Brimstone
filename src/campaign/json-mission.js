// ═══════════════════════════════════════════════════════════════════════════
// JSON mission loader + validator
// ─────────────────────────────────────────────────────────────────────────────
// `loadMissionJSON(parsed)` is the SHARED validator/loader for the data-driven
// JSON mission format (schema:1). It takes an already-PARSED object (so both the
// browser `fetch` path and the node `fs` path share one code path), VALIDATES
// it, then returns a runtime mission def with the EXACT shape the hand-written
// JS missions produce — so `_initCampaignMission` and the campaign registry
// consume a JSON mission indistinguishably from a JS one.
//
// The JSON schema (v1) mirrors the runtime shape verbatim for everything except
// three fields that can't live in plain data:
//   • `map`               → a `mapBuilderFn` closure over `buildMissionMap` is
//                            attached (and the raw `map` sub-object is kept —
//                            main.js distinguishes JSON missions by its presence).
//   • `storyTriggers[].condition` (string) → resolved to a predicate fn via the
//                            condition registry.
//   • `conductor.scriptKey` (string)        → resolved to `{ steps, config }` via
//                            the conductor-script registry, surfaced on the def
//                            as `conductorSteps` / `conductorConfig`.
// Every other field (enemyUnits, waves, survivorStartPositions, objectives, and
// all scalars) is passed through untouched.
//
// This module is also the mission editor's last line of defense before a bad
// mission is downloaded: the editor assembles a mission JSON and runs it through
// `validateMissionJSON` (catching the thrown error) before allowing the download.
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
//
// See docs/design/campaign-mission-editor.md → "Mission JSON schema (v1)".
// ═══════════════════════════════════════════════════════════════════════════

import { buildMissionMap } from './mission-map.js';
import { validateGraph, GraphValidationError } from '../mission-logic/graph.js';
import { validateUnlock } from './unlock.js';
import { resolveCondition, CONDITIONS } from './condition-registry.js';
import { resolveConductorScript, CONDUCTOR_SCRIPTS } from './conductor-scripts.js';
import { validateConversationDef } from './conversation-registry.js';
import { ObjectiveType } from './missions.js';
import { MAP_SIZES } from '../map.js';

// All objective `type` values the victory delegate accepts. `ObjectiveType`
// (missions.js) is the public *subset*; the full set the runtime actually
// handles lives in the `switch` inside `buildVictoryDelegate()`
// (src/campaign/campaign.js). THAT SWITCH IS THE SOURCE OF TRUTH — keep this set
// in sync with it. Validating against the narrow enum alone would wrongly reject
// shipped missions (e.g. `gather_and_survive`, `survive_with_party`). The
// objective-type guard test asserts this set stays equal to that switch.
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
export function _mapExtent(map) {
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

export function _validateObjectiveSide(side, label) {
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
  if (!m || typeof m !== 'object' || Array.isArray(m)) _fail('expected a parsed mission object');
  if (m.schema !== 1) _fail(`unsupported schema version "${m.schema}" (expected 1)`);
  if (typeof m.id !== 'string' || !m.id.trim()) _fail('required field "id" must be a non-empty string');

  const map = m.map;
  if (!map || typeof map !== 'object') _fail('required field "map" is missing');
  if (map.mode !== 'handmade' && map.mode !== 'procedural') {
    _fail(`invalid map.mode "${map.mode}" (expected "handmade" or "procedural")`);
  }
  if (map.mode === 'handmade') {
    if (!_isInt(map.cols) || map.cols <= 0) _fail('handmade map requires a positive integer "cols"');
    if (!_isInt(map.rows) || map.rows <= 0) _fail('handmade map requires a positive integer "rows"');
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
    if (u.level != null && !(_isInt(u.level) && u.level >= 1)) {
      _fail(`enemyUnit at (${u.col},${u.row}) has invalid "level" — must be an integer ≥ 1`);
    }
  }
  // Optional per-unit level on wave specs (scales HP/ATK/DEF — see applyLevel).
  for (const w of m.waves ?? []) {
    for (const u of w.units ?? []) {
      if (u.level != null && !(_isInt(u.level) && u.level >= 1)) {
        _fail(`wave "${w.id ?? '?'}" unit has invalid "level" — must be an integer ≥ 1`);
      }
    }
  }
  for (const s of m.survivorStartPositions ?? []) {
    if (!_inBounds(s, ext)) {
      _fail(`survivorStartPosition (${s.col},${s.row}) is outside the map extent`);
    }
  }

  // Hardening #2 — objective types must be ones the victory delegate handles.
  // A fully logic-graph-driven mission (docs/09) may omit `objectives` entirely —
  // the graph's Win/Lose nodes own victory — but if present it must be well-formed.
  if (m.objectives == null) {
    if (!m.logic) _fail('mission.objectives is required (unless the mission is logic-graph driven via "logic")');
  } else {
    if (typeof m.objectives !== 'object') _fail('mission.objectives must be an object');
    _validateObjectiveSide(m.objectives.win, 'win');
    if (m.objectives.lose != null) _validateObjectiveSide(m.objectives.lose, 'lose');
  }

  // Scripted NPCs must have unique ids and sit on the map.
  const npcIds = new Set();
  for (const npc of m.npcs ?? []) {
    if (typeof npc.id !== 'string' || !npc.id.trim()) _fail('npcs[] entry needs a string id');
    if (npcIds.has(npc.id)) _fail(`duplicate npc id "${npc.id}"`);
    npcIds.add(npc.id);
    if (!_inBounds(npc, ext)) {
      _fail(`npc "${npc.id}" at (${npc.col},${npc.row}) is outside the ${ext.cols}×${ext.rows} map extent`);
    }
    if (npc.survivorName != null && typeof npc.survivorName !== 'string') {
      _fail(`npc "${npc.id}": survivorName must be a string`);
    }
  }

  // Conversations: shape + binding/onComplete refs (the markdown file itself is
  // a runtime concern — see conversation-registry.js).
  const convIds = new Set();
  for (const c of m.conversations ?? []) {
    try {
      validateConversationDef(c, { ext, npcIds });
    } catch (err) {
      _fail(err.message);
    }
    if (convIds.has(c.id)) _fail(`duplicate conversation id "${c.id}"`);
    convIds.add(c.id);
  }

  // Story-trigger conditions are STRING keys into the condition registry.
  for (const tr of m.storyTriggers ?? []) {
    if (tr.conversation != null) {
      if (!convIds.has(tr.conversation)) {
        _fail(`storyTrigger references unknown conversation "${tr.conversation}"`);
      }
    } else if (tr.title == null && tr.text == null) {
      _fail('storyTrigger needs either a "conversation" id or title/text');
    }
    if (tr.condition == null) continue;
    if (typeof tr.condition !== 'string') _fail('storyTrigger.condition must be a string key');
    if (resolveCondition(tr.condition) == null) {
      _fail(`unknown story-trigger condition "${tr.condition}" (known: ${Object.keys(CONDITIONS).join(', ') || 'none'})`);
    }
  }

  // conductor.scriptKey must resolve — an unknown key would surface as an
  // undefined conductor script at runtime and silently disable the conductor.
  if (m.conductor != null) {
    const key = m.conductor.scriptKey;
    if (resolveConductorScript(key) == null) {
      _fail(`unknown conductor.scriptKey "${key}" (known: ${Object.keys(CONDUCTOR_SCRIPTS).join(', ') || 'none'})`);
    }
  }

  // hints.scriptKey — micro-lesson hints riding along a normal AI-driven
  // mission (MissionConductor in 'hints' mode). Resolved through the same
  // registry as conductor scripts; an unknown key fails for the same reason.
  if (m.hints != null) {
    const key = m.hints.scriptKey;
    if (resolveConductorScript(key) == null) {
      _fail(`unknown hints.scriptKey "${key}" (known: ${Object.keys(CONDUCTOR_SCRIPTS).join(', ') || 'none'})`);
    }
  }

  // logic — the mission's event→action graph (docs/09). Additive: missions
  // without it use the legacy storyTriggers/waves/objectives. Structural errors
  // (unknown node type, dangling pin) surface as a mission validation failure.
  if (m.logic != null) {
    try {
      validateGraph(m.logic);
    } catch (err) {
      if (err instanceof GraphValidationError) _fail(`logic graph: ${err.message}`);
      throw err;
    }
  }

  // unlock — rich campaign unlock criteria (docs/09 §5.5). Additive: missions
  // keep using the legacy `requires` list, which is AND-ed with this.
  if (m.unlock != null) {
    try { validateUnlock(m.unlock); }
    catch (err) { _fail(err.message); }
  }

  return m;
}

/**
 * Validate the building-footprint pairing of a parsed mission (P6, item 5):
 * every tile carrying a `building` MUST have a non-empty `footprintHexes`, and
 * each footprint key MUST point to a tile whose `buildingFootprintOf` back-points
 * to the entrance. Throws {@link MissionValidationError} on the first break;
 * returns the (unmodified) input on success.
 *
 * Kept SEPARATE from {@link validateMissionJSON} (and so out of the runtime
 * `loadMissionJSON` path) deliberately: the shipped JSON missions predate the
 * footprint model and have buildings without footprints, so the runtime loader
 * must stay backward-compatible. The mission EDITOR runs this extra check before
 * download/save so newly-authored / re-saved missions are always well-formed.
 * Once the legacy missions are migrated (P5) this can fold into validateMissionJSON.
 */
export function validateBuildingFootprints(m) {
  const map = m && m.map;
  if (!map || typeof map !== 'object') return m; // validateMissionJSON owns this error
  const tileList = map.mode === 'handmade' ? (map.tiles ?? []) : (map.overlay?.tiles ?? []);
  const byKey = new Map();
  for (const t of tileList) byKey.set(`${t.col},${t.row}`, t);
  for (const t of tileList) {
    if (t.building == null) continue;
    const entranceKey = `${t.col},${t.row}`;
    const fps = t.footprintHexes;
    if (!Array.isArray(fps) || fps.length === 0) {
      _fail(`building at (${t.col},${t.row}) has no footprintHexes — every building needs a footprint`);
    }
    for (const fk of fps) {
      const ft = byKey.get(fk);
      if (!ft) _fail(`building at (${t.col},${t.row}) footprint "${fk}" points at no tile`);
      if (ft.buildingFootprintOf !== entranceKey) {
        _fail(`building at (${t.col},${t.row}) footprint "${fk}" does not back-point to its entrance (broken pair)`);
      }
    }
  }
  return m;
}

/**
 * Validate and resolve a parsed JSON mission into a runtime mission def.
 *
 * Validates first (throws {@link MissionValidationError} on any failure), then
 * transforms the three non-data fields into the JS-mission runtime shape:
 *   • a `mapBuilderFn` closure over `buildMissionMap` is attached and the raw
 *     `map` sub-object is preserved (main.js detects JSON missions by it);
 *   • `storyTriggers[].condition` string keys are resolved to predicate fns;
 *   • `conductor.scriptKey` is surfaced as `conductorSteps` / `conductorConfig`,
 *     and the `schema` / `conductor` fields are stripped from the runtime def.
 *
 * @param {object} parsed - already-parsed mission JSON (schema v1).
 * @returns {object} runtime mission def.
 */
export function loadMissionJSON(parsed) {
  validateMissionJSON(parsed);

  // Thin pass-through: copy everything, then transform the three non-data fields.
  const def = { ...parsed };
  delete def.schema;
  delete def.conductor;
  delete def.hints;

  // map → keep the mapDef (main.js distinguishes JSON missions by its presence)
  // and resolve a builder fn so the def is invoked uniformly with JS missions
  // (whose mapBuilder is a registry-resolved fn). The closure is lazy so the map
  // is only built when the mission actually starts.
  const mapDef = parsed.map;
  def.mapBuilderFn = () => buildMissionMap(mapDef);

  // storyTriggers condition strings → predicate fns. processStoryTriggers gates
  // on `typeof trigger.condition === 'function'`, so an unresolved string would
  // silently disable the gate. Triggers without a condition pass through.
  if (parsed.storyTriggers != null) {
    def.storyTriggers = parsed.storyTriggers.map((tr) =>
      tr && typeof tr.condition === 'string'
        ? { ...tr, condition: resolveCondition(tr.condition) }
        : tr);
  }

  // conductor.scriptKey → conductorSteps / conductorConfig
  if (parsed.conductor != null) {
    const script = resolveConductorScript(parsed.conductor.scriptKey);
    def.conductorSteps = script.steps;
    def.conductorConfig = script.config;
  }

  // hints.scriptKey → hintSteps / hintConfig (MissionConductor 'hints' mode —
  // the mission stays fully AI-driven; see main.js _initCampaignMission)
  if (parsed.hints != null) {
    const script = resolveConductorScript(parsed.hints.scriptKey);
    def.hintSteps = script.steps;
    def.hintConfig = script.config;
  }

  return def;
}

/**
 * Browser-only sugar: fetch a mission JSON by URL (same-origin) and load it.
 * Node tests / the migration script read via `fs` and call `loadMissionJSON`
 * directly, so this is just a fetch+parse wrapper over the shared loader.
 *
 * @param {string} url — same-origin URL of a mission JSON file.
 * @returns {Promise<object>} the runtime mission def.
 */
export async function fetchMissionJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchMissionJSON: ${url} → HTTP ${res.status}`);
  const parsed = await res.json();
  return loadMissionJSON(parsed);
}

/**
 * Load a parsed mission JSON and append it to a campaign definition object,
 * resolving everything at registration so the mission is indistinguishable from
 * a JS one downstream. Mutates and returns `campaignDef`.
 *
 * @param {object} campaignDef — a campaign def ({ missions[], mapBuilders, … }).
 * @param {object} parsed — parsed mission JSON (schema v1).
 * @returns {object} the resolved runtime mission def that was appended.
 */
export function registerMissionJSON(campaignDef, parsed) {
  if (!campaignDef || !Array.isArray(campaignDef.missions)) {
    throw new Error('registerMissionJSON: campaignDef with a missions[] array is required');
  }
  const def = loadMissionJSON(parsed);
  // Keep the map builder reachable via the legacy mapBuilders registry too, so a
  // JSON mission resolves identically whether downstream code uses mapBuilderFn
  // or getMapBuilder(mission.mapBuilder).
  if (campaignDef.mapBuilders && typeof campaignDef.mapBuilders === 'object') {
    const key = def.mapBuilder ?? def.id;
    def.mapBuilder = key;
    campaignDef.mapBuilders[key] = def.mapBuilderFn;
  }
  campaignDef.missions.push(def);
  return def;
}
