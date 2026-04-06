// Campaign registry — import all campaign definition files and export them
// as a discoverable list. To add a new campaign, import it and add to the array.

import calebsHollowPrologue from './campaigns/calebs-hollow-prologue.js';

/**
 * All available campaigns. Each entry is a campaign definition object with:
 *   id, title, description, missions[], mapBuilders, firstMission
 */
export const CAMPAIGNS = [
  calebsHollowPrologue,
];

/** Look up a campaign definition by ID. */
export function getCampaignById(id) {
  return CAMPAIGNS.find(c => c.id === id) ?? null;
}
