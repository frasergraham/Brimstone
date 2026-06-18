// Catalog of the bundled (migrated) campaign missions.
//
// Single source of truth for the in-repo mission set, shared by:
//   • campaign-registry.js — imports MIGRATED_MISSIONS to auto-register each
//     mission JSON at module init.
//   • the Mission Editor's "Load existing mission…" picker (src/tools/) — lists
//     these so an author can load a bundled mission, tweak it, and re-download.
//
// Kept dependency-free on purpose: the editor can import it without pulling in
// the full campaign runtime (campaigns/*, condition-registry, etc.) or the
// registry's top-level fetch loop.
//
// `title` mirrors each mission JSON's top-level `title` for display. The
// mission-catalog test asserts these stay in sync with the actual JSON files,
// so drift is caught rather than silently shipped.
//
// `file` is the on-disk basename (no extension) under ./missions/. It follows
// the ChXMY chapter/mission convention and is deliberately decoupled from the
// mission `id`: ids are persisted in campaign saves and stats rows, so they
// must stay stable even as files get renamed.

/**
 * Bundled missions in canonical campaign order (drives the campaign mission
 * list and `firstMission === missions[0].id`).
 *
 * @type {ReadonlyArray<{ id: string, campaignId: string, title: string, file: string }>}
 */
export const MIGRATED_MISSIONS = Object.freeze([
  { id: 'tutorial',            campaignId: 'calebs_hollow_prologue',   title: "The Road to Caleb's Hollow", file: 'tutorial' },
  { id: 'prologue',            campaignId: 'calebs_hollow_prologue',   title: 'The Awakening',              file: 'Ch1M1' },
  { id: 'gathering_survivors', campaignId: 'calebs_hollow_prologue',   title: 'Gathering Survivors',        file: 'Ch1M2' },
  { id: 'first_night',         campaignId: 'calebs_hollow_prologue',   title: 'The First Night',            file: 'Ch1M3' },
  { id: 'river_crossing',      campaignId: 'calebs_hollow_prologue',   title: 'The River Crossing',         file: 'Ch1M4' },
  { id: 'dark_ritual',         campaignId: 'calebs_hollow_prologue',   title: 'Dark Ritual',                file: 'Ch1M5' },
  { id: 'village_marsh_end',     campaignId: 'calebs_hollow_prologue', title: "Marsh's End",                file: 'Ch1V1' },
  { id: 'village_thornwick',     campaignId: 'calebs_hollow_prologue', title: 'Thornwick',                  file: 'Ch1V2' },
  { id: 'village_gallows_ferry', campaignId: 'calebs_hollow_prologue', title: 'Gallows Ferry',              file: 'Ch1V3' },
  { id: 'village_ashford_mill',  campaignId: 'calebs_hollow_prologue', title: 'Ashford Mill',               file: 'Ch1V4' },
  { id: 'village_blackfen',      campaignId: 'calebs_hollow_prologue', title: 'Blackfen',                   file: 'Ch1V5' },
  { id: 'long_watch',          campaignId: 'calebs_hollow_prologue',   title: 'The Long Watch',             file: 'Ch1M6' },
  { id: 'witchs_trail',        campaignId: 'calebs_hollow_prologue',   title: "The Witch's Trail",          file: 'Ch1M7' },
]);

/**
 * Resolve a mission id to its on-disk JSON filename. Falls back to `<id>.json`
 * for missions not in the bundled catalog (e.g. a brand-new mission being
 * exported from the editor for the first time).
 *
 * @param {string} id — mission id.
 * @returns {string} basename with extension, e.g. "Ch1M3.json"
 */
export function missionFileName(id) {
  const entry = MIGRATED_MISSIONS.find((m) => m.id === id);
  return `${entry?.file ?? id}.json`;
}

/**
 * Resolve the same-origin URL of a bundled mission JSON. Built relative to this
 * module's own location so it resolves identically to campaign-registry.js's
 * loader (both live in src/campaign/, alongside ./missions/).
 *
 * @param {string} id — mission id (must resolve to a file in ./missions/).
 * @returns {string} absolute URL to ./missions/<file>.json
 */
export function missionJSONUrl(id) {
  return new URL(`./missions/${missionFileName(id)}`, import.meta.url).href;
}
