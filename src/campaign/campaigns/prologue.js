// ═══════════════════════════════════════════════════════════════════════════
// Campaign: Prologue — The Road to Caleb's Hollow  [RETIRED — not registered]
//
// ⚠ This standalone tutorial campaign is no longer registered (it was dropped
// from campaign-registry.js). The tutorial mission is now the FIRST mission of
// the `calebs_hollow_prologue` (Chapter 1) campaign. This file is kept ONLY
// because scripts/migrate-missions.js still imports it as the snapshot source
// for tutorial.json; nothing in the app/test runtime references it.
//
// A single guided tutorial mission framed as the story prologue.
//
// The tutorial mission definition is now data-driven: it lives as JSON at
// src/campaign/missions/tutorial.json and is registered into this campaign by
// campaign-registry.js at module init (via registerJSONMissions). Its scripted
// MissionConductor steps / witchPlanProvider / forced dice are NOT serializable
// and remain in src/tutorial/tutorial-config.js, referenced from the JSON via
// `conductor.scriptKey: "tutorial"` (resolved through the conductor-script
// registry). This file is just the campaign shell — missions[]/mapBuilders are
// populated at registration time.
// ═══════════════════════════════════════════════════════════════════════════

export default {
  id:          'prologue',
  title:       'Prologue (Tutorial)',
  description: 'A hero on the road to Caleb\'s Hollow encounters darkness for the first time. Learn the fundamentals of survival.',
  missions:    [],
  mapBuilders: {},
  firstMission: 'tutorial',
  prerequisiteCampaign: null,
};
