// ═══════════════════════════════════════════════════════════════════════════
// Runtime JSON-mission loader
// ─────────────────────────────────────────────────────────────────────────────
// `loadMissionJSON(parsed)` turns an already-PARSED mission JSON object into a
// runtime mission def with the EXACT shape the hand-written JS missions produce
// — so `_initCampaignMission` and the campaign registry consume a JSON mission
// indistinguishably from a JS one.
//
// The JSON schema (v1) mirrors the runtime shape verbatim for everything except
// three fields that can't live in plain data:
//   • `map`               → resolved to a builder fn via `buildMissionMap`.
//   • `storyTriggers[].condition` (string) → resolved to a predicate fn via the
//                            condition registry.
//   • `conductor.scriptKey` (string)        → resolved to `{ steps, config }` via
//                            the conductor-script registry, surfaced on the def
//                            as `conductorSteps` / `conductorConfig`.
// Every other field (enemyUnits, waves, survivorStartPositions, objectives, and
// all scalars) is passed through untouched.
//
// The loader takes a parsed object rather than a string/URL so node tests (which
// read via `fs`) and the browser (which `fetch`es) share one code path. A thin
// `fetchMissionJSON(url)` browser sugar wraps it.
//
// See docs/design/campaign-mission-editor.md → "Mission JSON schema (v1)".
// ═══════════════════════════════════════════════════════════════════════════

import { buildMissionMap } from './mission-map.js';
import { resolveCondition, CONDITIONS } from './condition-registry.js';
import { resolveConductorScript, CONDUCTOR_SCRIPTS } from './conductor-scripts.js';

const SCHEMA_VERSION = 1;
const VALID_MAP_MODES = new Set(['handmade', 'procedural']);

// ── Validation ───────────────────────────────────────────────────────────────

// Throw a clear, prefixed error so callers (and the editor's pre-download
// validation) get an actionable message rather than a downstream NPE.
function _fail(msg) {
  throw new Error(`loadMissionJSON: ${msg}`);
}

function _validate(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    _fail('expected a parsed mission object');
  }
  if (parsed.schema !== SCHEMA_VERSION) {
    _fail(`unsupported schema version ${JSON.stringify(parsed.schema)} (expected ${SCHEMA_VERSION})`);
  }
  if (typeof parsed.id !== 'string' || parsed.id === '') {
    _fail('missing required field "id"');
  }

  // ── map ──
  const map = parsed.map;
  if (!map || typeof map !== 'object') _fail('missing required field "map"');
  if (!VALID_MAP_MODES.has(map.mode)) {
    _fail(`invalid map.mode ${JSON.stringify(map.mode)} (expected "handmade" or "procedural")`);
  }
  if (map.mode === 'handmade') {
    if (!Number.isInteger(map.cols) || map.cols <= 0) _fail('handmade map requires a positive integer "cols"');
    if (!Number.isInteger(map.rows) || map.rows <= 0) _fail('handmade map requires a positive integer "rows"');
  }

  // ── referenced condition keys ──
  if (parsed.storyTriggers != null) {
    if (!Array.isArray(parsed.storyTriggers)) _fail('"storyTriggers" must be an array');
    for (const t of parsed.storyTriggers) {
      if (t && typeof t.condition === 'string' && resolveCondition(t.condition) == null) {
        _fail(`unknown story-trigger condition "${t.condition}" (known: ${Object.keys(CONDITIONS).join(', ') || 'none'})`);
      }
    }
  }

  // ── referenced conductor key ──
  if (parsed.conductor != null) {
    const key = parsed.conductor.scriptKey;
    if (resolveConductorScript(key) == null) {
      _fail(`unknown conductor.scriptKey "${key}" (known: ${Object.keys(CONDUCTOR_SCRIPTS).join(', ') || 'none'})`);
    }
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────────

// Replace each story trigger's `condition` STRING with the resolved predicate
// fn. processStoryTriggers gates on `typeof trigger.condition === 'function'`, so
// an unresolved string would silently disable the gate — hence we resolve (and
// _validate already rejected unknown keys). Triggers without a condition pass
// through unchanged.
function _resolveStoryTriggers(triggers) {
  if (!Array.isArray(triggers)) return triggers;
  return triggers.map((t) => {
    if (t && typeof t.condition === 'string') {
      return { ...t, condition: resolveCondition(t.condition) };
    }
    return t;
  });
}

/**
 * Load a parsed mission JSON object into a runtime mission def.
 *
 * @param {object} parsed — an already-parsed mission JSON object (schema v1).
 * @returns {object} a runtime mission def matching the JS-mission shape:
 *   all scalar/array fields pass through; `map` is preserved as the mapDef and a
 *   `mapBuilderFn` closure over `buildMissionMap` is attached; `storyTriggers`
 *   conditions are resolved to fns; and `conductor.scriptKey` is surfaced as
 *   `conductorSteps` / `conductorConfig`.
 * @throws {Error} with a `loadMissionJSON:` prefix on any validation failure.
 */
export function loadMissionJSON(parsed) {
  _validate(parsed);

  // Thin pass-through: copy everything, then transform the three non-data fields.
  const def = { ...parsed };
  delete def.schema;
  delete def.conductor;

  // map → keep the mapDef (main.js distinguishes JSON missions by its presence)
  // and resolve a builder fn so the def is invoked uniformly with JS missions
  // (whose mapBuilder is a registry-resolved fn). The closure is lazy so the map
  // is only built when the mission actually starts.
  const mapDef = parsed.map;
  def.mapBuilderFn = () => buildMissionMap(mapDef);

  // storyTriggers condition strings → predicate fns
  if (parsed.storyTriggers != null) {
    def.storyTriggers = _resolveStoryTriggers(parsed.storyTriggers);
  }

  // conductor.scriptKey → conductorSteps / conductorConfig
  if (parsed.conductor != null) {
    const script = resolveConductorScript(parsed.conductor.scriptKey);
    def.conductorSteps = script.steps;
    def.conductorConfig = script.config;
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
