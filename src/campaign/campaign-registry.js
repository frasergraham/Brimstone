// Campaign registry — import all campaign definition files and export them
// as a discoverable list. To add a new campaign, import it and add to the array.

import prologue from './campaigns/prologue.js';
import calebsHollowPrologue from './campaigns/calebs-hollow-prologue.js';
import { registerMissionJSON } from './json-mission.js';

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

/**
 * Load one or more parsed JSON missions into a registered campaign, resolving
 * map/condition/conductor references at registration so each JSON mission is
 * indistinguishable from a hand-written JS mission downstream. This is the
 * registry-side bridge for the data-driven mission format (the migrated missions
 * land here in P3). The parsed objects come from the browser via `fetch` or from
 * node via `fs` — both already-parsed, so registration is synchronous.
 *
 * @param {string} campaignId — id of an existing campaign in CAMPAIGNS.
 * @param {object|object[]} parsedMissions — one or more parsed mission JSON objects.
 * @returns {object[]} the resolved runtime mission defs that were appended.
 */
export function registerJSONMissions(campaignId, parsedMissions) {
  const campaignDef = getCampaignById(campaignId);
  if (!campaignDef) throw new Error(`registerJSONMissions: unknown campaign "${campaignId}"`);
  const list = Array.isArray(parsedMissions) ? parsedMissions : [parsedMissions];
  return list.map((parsed) => registerMissionJSON(campaignDef, parsed));
}
