// ═══════════════════════════════════════════════════════════════════════════
// Campaign: The Caleb's Hollow Prologue
// An introductory arc set in cursed colonial Caleb's Hollow.
//
// The mission definitions and their hand-rolled maps are now data-driven: they
// live as JSON under src/campaign/missions/*.json and are registered into this
// campaign by campaign-registry.js at module init (via registerJSONMissions).
// The guided tutorial (`tutorial`) is the first mission of this chapter — it was
// folded in from the old standalone `prologue` campaign so Chapter 1 opens with
// the same hands-on teaching beat, after which "The Awakening" (`prologue`)
// requires it. The maps were snapshotted losslessly from the original imperative
// buildXMap() functions by scripts/migrate-missions.js (handmade tile snapshots,
// with derived roadDirs persisted). The one inline story-trigger predicate
// (`notHoldingAllNodes`) moved to src/campaign/condition-registry.js and is
// referenced from the JSON by name.
//
// This file is now just the campaign shell — missions[]/mapBuilders are
// populated at registration time. To tweak a mission, edit its JSON (or use the
// mission editor).
// ═══════════════════════════════════════════════════════════════════════════

export default {
  id:          'calebs_hollow_prologue',
  title:       'Chapter 1 - Welcome to Caleb\'s Hollow',
  description: 'A cursed village, the walking dead, and a witch pulling the strings. Stand between Caleb\'s Hollow and oblivion.',
  missions:    [],
  mapBuilders: {},
  firstMission: 'tutorial',
  prerequisiteCampaign: null,
};
