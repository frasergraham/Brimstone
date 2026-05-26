// Campaign registry — import all campaign definition files and export them
// as a discoverable list. To add a new campaign, import it and add to the array.
//
// The Caleb's Hollow prologue (7 missions) and the tutorial (1 mission) are
// data-driven: their definitions live as JSON under ./missions/ and are loaded
// + registered at module init (P3 migration). The campaign files here are thin
// shells (id/title/description/firstMission); their missions[] and mapBuilders
// are populated by `registerJSONMissions` below. Loading is environment-aware:
//   • browser  — same-origin `fetch` of each ./missions/*.json
//   • node     — synchronous `fs` read (tests, headless-campaign runner)
// Both paths feed the same already-parsed object to `loadMissionJSON`, so the
// loader is identical. The module uses top-level `await`, so any importer (the
// app, headless scripts, tests) transparently waits for registration.

import prologue from './campaigns/prologue.js';
import calebsHollowPrologue from './campaigns/calebs-hollow-prologue.js';
import { registerMissionJSON } from './json-mission.js';
import { MIGRATED_MISSIONS } from './mission-catalog.js';

/**
 * All available campaigns. Each entry is a campaign definition object with:
 *   id, title, description, missions[], mapBuilders, firstMission
 *   Optional: disabled (boolean), prerequisiteCampaign (string)
 */
export const CAMPAIGNS = [
  prologue,
  calebsHollowPrologue,
  {
    id:          'chapter_2',
    title:       'Chapter 2 - Darkness Falls',
    description: 'The dead grow bolder as night descends on Caleb\'s Hollow.',
    missions:    [],
    mapBuilders: {},
    firstMission: null,
    prerequisiteCampaign: 'calebs_hollow_prologue',
    disabled:    true,
  },
  {
    id:          'chapter_3',
    title:       'Chapter 3 - The Necromancer Rises',
    description: 'A dark power awakens in the forest beyond the village.',
    missions:    [],
    mapBuilders: {},
    firstMission: null,
    prerequisiteCampaign: 'chapter_2',
    disabled:    true,
  },
  {
    id:          'chapter_4',
    title:       'Chapter 4 - A New Evil',
    description: 'The final confrontation looms over Caleb\'s Hollow.',
    missions:    [],
    mapBuilders: {},
    firstMission: null,
    prerequisiteCampaign: 'chapter_3',
    disabled:    true,
  },
];

/** Look up a campaign definition by ID. */
export function getCampaignById(id) {
  return CAMPAIGNS.find(c => c.id === id) ?? null;
}

// Some built maps carry passthrough fields that `buildMissionMap` doesn't
// reconstruct but the runtime reads off the map data (currently just
// `targetHex`, the reach_hex marker). Re-attach them by wrapping the resolved
// mapBuilderFn so both the mapBuilderFn path (main.js) and the legacy
// getMapBuilder path (headless) see them.
function _attachMapPassthrough(campaignDef, def, parsed) {
  const tgt = parsed?.map?.targetHex;
  if (!tgt) return;
  const inner = def.mapBuilderFn;
  const wrapped = () => {
    const m = inner();
    m.targetHex = { col: tgt.col, row: tgt.row };
    return m;
  };
  def.mapBuilderFn = wrapped;
  if (campaignDef.mapBuilders && def.mapBuilder) {
    campaignDef.mapBuilders[def.mapBuilder] = wrapped;
  }
}

/**
 * Load one or more parsed JSON missions into a registered campaign, resolving
 * map/condition/conductor references at registration so each JSON mission is
 * indistinguishable from a hand-written JS mission downstream. The parsed
 * objects come from the browser via `fetch` or from node via `fs` — both
 * already-parsed, so registration is synchronous.
 *
 * @param {string} campaignId — id of an existing campaign in CAMPAIGNS.
 * @param {object|object[]} parsedMissions — one or more parsed mission JSON objects.
 * @returns {object[]} the resolved runtime mission defs that were appended.
 */
export function registerJSONMissions(campaignId, parsedMissions) {
  const campaignDef = getCampaignById(campaignId);
  if (!campaignDef) throw new Error(`registerJSONMissions: unknown campaign "${campaignId}"`);
  const list = Array.isArray(parsedMissions) ? parsedMissions : [parsedMissions];
  return list.map((parsed) => {
    const def = registerMissionJSON(campaignDef, parsed);
    _attachMapPassthrough(campaignDef, def, parsed);
    return def;
  });
}

// ── Migrated-mission auto-registration ────────────────────────────────────────

// Canonical migrated-mission list (id/campaignId/title, in campaign order) lives
// in ./mission-catalog.js so the Mission Editor's "Load existing mission" picker
// can share it without importing this registry's full runtime + fetch loop.

// No DOM ⇒ node (tests, headless scripts). Any webview (browser, Electron
// renderer, Capacitor) has `window` and uses fetch.
const _isNode = typeof window === 'undefined';

async function _readMissionJSON(id) {
  const url = new URL(`./missions/${id}.json`, import.meta.url);
  if (_isNode) {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(url, 'utf8'));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`campaign-registry: ${url} → HTTP ${res.status}`);
  return res.json();
}

// Register all migrated missions. Awaited at module top-level so importers see a
// fully populated registry.
for (const { id, campaignId } of MIGRATED_MISSIONS) {
  registerJSONMissions(campaignId, await _readMissionJSON(id));
}
