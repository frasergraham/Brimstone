// ═══════════════════════════════════════════════════════════════════════════
// Campaign: Prologue — The Road to Caleb's Hollow
// A single guided tutorial mission framed as the story prologue.
// Uses MissionConductor for step-by-step instruction overlay.
// ═══════════════════════════════════════════════════════════════════════════

import {
  buildTutorialMap, TUTORIAL_STEPS, TUTORIAL_CONDUCTOR_CONFIG, TUTORIAL_WAVES,
} from '../../tutorial/tutorial-config.js';

// ── Mission definition ────────────────────────────────────────────────────

const MISSIONS = [
  {
    id:       'tutorial',
    title:    'The Road to Caleb\'s Hollow',
    chapter:  0,
    briefing: `On the road to Caleb's Hollow, the forest grows darker with every step. Shadows twist between the trees, and the air carries the faint stench of decay. Something is very wrong ahead.`,
    victoryText: `The road is clear. Through the trees you can see the rooftops of Caleb's Hollow — battered, but still standing. Whatever waits inside, you're as ready as you'll ever be.`,
    defeatText: null, // tutorial cannot be lost

    mapBuilder:      'prologue_tutorial',
    mapSize:         'tutorial',

    hasWitch:        false,
    noWitch:         true,
    disableScoring:  true,
    isTutorial:      true,

    // MissionConductor integration
    conductorSteps:  TUTORIAL_STEPS,
    conductorConfig: TUTORIAL_CONDUCTOR_CONFIG,

    // Wave spawning (minion appears after round 1)
    waves:           TUTORIAL_WAVES,

    enemyUnits:      [],
    aiPersonality:   'balanced',
    aiBudgetBonus:   0,

    maxSurvivorsFromRoster:    0,
    missionSurvivors:          0,
    maxDiscoverableSurvivors:  1,

    objectives: {
      win:  { type: 'conductor_complete', reason: 'You have learned the fundamentals of survival.' },
      lose: null,
    },

    startingResources: {},
    rewards:           {},
    healBonus:         0,

    requires: null,
  },
];

// ── Map builders ──────────────────────────────────────────────────────────

const MAP_BUILDERS = {
  prologue_tutorial: buildTutorialMap,
};

// ── Campaign definition ───────────────────────────────────────────────────

export default {
  id:          'prologue',
  title:       'Prologue (Tutorial)',
  description: 'A hero on the road to Caleb\'s Hollow encounters darkness for the first time. Learn the fundamentals of survival.',
  missions:    MISSIONS,
  mapBuilders: MAP_BUILDERS,
  firstMission: 'tutorial',
  prerequisiteCampaign: null,
};
