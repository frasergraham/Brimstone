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

/**
 * Bundled missions in canonical campaign order (drives the campaign mission
 * list and `firstMission === missions[0].id`).
 *
 * @type {ReadonlyArray<{ id: string, campaignId: string, title: string }>}
 */
export const MIGRATED_MISSIONS = Object.freeze([
  { id: 'tutorial',            campaignId: 'prologue',                 title: "The Road to Caleb's Hollow" },
  { id: 'prologue',            campaignId: 'calebs_hollow_prologue',   title: 'The Awakening' },
  { id: 'gathering_survivors', campaignId: 'calebs_hollow_prologue',   title: 'Gathering Survivors' },
  { id: 'first_night',         campaignId: 'calebs_hollow_prologue',   title: 'The First Night' },
  { id: 'river_crossing',      campaignId: 'calebs_hollow_prologue',   title: 'The River Crossing' },
  { id: 'dark_ritual',         campaignId: 'calebs_hollow_prologue',   title: 'Dark Ritual' },
  { id: 'long_watch',          campaignId: 'calebs_hollow_prologue',   title: 'The Long Watch' },
  { id: 'witchs_trail',        campaignId: 'calebs_hollow_prologue',   title: "The Witch's Trail" },
]);

/**
 * Resolve the same-origin URL of a bundled mission JSON. Built relative to this
 * module's own location so it resolves identically to campaign-registry.js's
 * loader (both live in src/campaign/, alongside ./missions/).
 *
 * @param {string} id — mission id (must match a file in ./missions/).
 * @returns {string} absolute URL to ./missions/<id>.json
 */
export function missionJSONUrl(id) {
  return new URL(`./missions/${id}.json`, import.meta.url).href;
}
