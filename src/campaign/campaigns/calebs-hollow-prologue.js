// ═══════════════════════════════════════════════════════════════════════════
// Campaign: The Caleb's Hollow Prologue
// A 7-mission introductory arc set in cursed colonial Caleb's Hollow.
//
// The 7 mission definitions and their hand-rolled maps are now data-driven:
// they live as JSON under src/campaign/missions/*.json and are registered into
// this campaign by campaign-registry.js at module init (via
// registerJSONMissions). The maps were snapshotted losslessly from the original
// imperative buildXMap() functions by scripts/migrate-missions.js (handmade
// tile snapshots, with derived roadDirs persisted). The one inline story-trigger
// predicate (`notHoldingAllNodes`) moved to src/campaign/condition-registry.js
// and is referenced from the JSON by name.
//
// This file is now just the campaign shell — missions[]/mapBuilders are
// populated at registration time. To tweak a mission, edit its JSON (or use the
// mission editor).
// ═══════════════════════════════════════════════════════════════════════════

export default {
  id:          'calebs_hollow_prologue',
  title:       'Chapter 1 - Welcome to Caleb\'s Hollow',
  description: 'A cursed village, the walking dead, and a witch pulling the strings. Seven missions stand between Caleb\'s Hollow and oblivion.',
  missions:    [],
  mapBuilders: {},
  firstMission: 'prologue',
  prerequisiteCampaign: null,
};
