// Campaign mission definitions — story content, objectives, enemy configuration.

export const MissionId = Object.freeze({
  PROLOGUE:     'prologue',
  FIRST_NIGHT:  'first_night',
  WITCHS_TRAIL: 'witchs_trail',
});

/**
 * Objective type constants for win/lose conditions.
 */
export const ObjectiveType = Object.freeze({
  ELIMINATE_ALL:   'eliminate_all',
  HERO_KILLED:     'hero_killed',
  SURVIVE_ROUNDS:  'survive_rounds',
  REACH_HEX:       'reach_hex',
  SLAY_WITCH:      'slay_witch',
  CONTROL_NODES:   'control_nodes',
  ROUNDS_EXCEEDED: 'rounds_exceeded',
});

/**
 * Ordered list of campaign missions.
 * Each mission defines map, enemies, objectives, narrative, and rewards.
 */
export const MISSIONS = [
  // ── Mission 1: The Awakening ─────────────────────────────────────────────
  {
    id:       MissionId.PROLOGUE,
    title:    'The Awakening',
    chapter:  1,
    briefing: `You awaken at the Salem Inn to the sound of screaming. The dead walk the streets — shambling corpses driven by an unseen malice. Grab what you can and clear the village before more arrive.`,
    victoryText: `The last corpse crumbles to dust. Silence returns to Salem's streets, but you sense this is only the beginning. A survivor stumbles from the wreckage — together, you may stand a chance against what's coming.`,
    defeatText:  `The dead overwhelm you. Salem falls before the fight even begins.`,

    mapBuilder:    'prologue',
    mapSize:       'skirmish',

    hasWitch:      false,
    enemyUnits: [
      { type: 'zombie', col: 3, row: 2 },
      { type: 'zombie', col: 6, row: 5 },
      { type: 'zombie', col: 5, row: 7 },
    ],
    waves:         null,
    aiPersonality: 'balanced',

    maxSurvivorsFromRoster: 0,
    missionSurvivors:       1,

    objectives: {
      win:  { type: ObjectiveType.ELIMINATE_ALL, reason: 'The streets of Salem are clear.' },
      lose: { type: ObjectiveType.HERO_KILLED },
    },

    startingResources: { food: 1, herbs: 1 },
    rewards:           { herbs: 2, food: 1 },

    requires: null,
  },

  // ── Mission 2: The First Night ───────────────────────────────────────────
  {
    id:       MissionId.FIRST_NIGHT,
    title:    'The First Night',
    chapter:  1,
    briefing: `Dusk falls and the dead grow bolder. Waves of corpses claw their way from the old graveyard. Barricade the village and survive until dawn — 8 rounds of relentless assault.`,
    victoryText: `Dawn breaks. The wave subsides, leaving the village battered but standing. Among the rubble, a new ally emerges — another survivor drawn to your fight.`,
    defeatText:  `The dead breach your defenses. Salem is overrun.`,

    mapBuilder:    'first_night',
    mapSize:       'standard',

    hasWitch:      false,
    enemyUnits: [
      { type: 'zombie', col: 10, row: 2 },
      { type: 'zombie', col: 11, row: 4 },
    ],
    waves: [
      { round: 3,  units: [{ type: 'zombie', spawnAt: 'graveyard' }, { type: 'zombie', spawnAt: 'graveyard' }] },
      { round: 5,  units: [{ type: 'zombie', spawnAt: 'graveyard' }, { type: 'minion', spawnAt: 'map_edge' }] },
      { round: 7,  units: [{ type: 'zombie', spawnAt: 'graveyard' }, { type: 'zombie', spawnAt: 'graveyard' }, { type: 'minion', spawnAt: 'map_edge' }] },
    ],
    aiPersonality: 'berserker',

    maxSurvivorsFromRoster: 2,
    missionSurvivors:       1,

    objectives: {
      win:  { type: ObjectiveType.SURVIVE_ROUNDS, rounds: 8, reason: 'You survived the night. Dawn brings hope.' },
      lose: { type: ObjectiveType.HERO_KILLED },
    },

    startingResources: { wood: 2 },
    rewards:           { wood: 2, metal: 1, food: 2 },

    requires: [MissionId.PROLOGUE],
  },

  // ── Mission 3: The Witch's Trail ─────────────────────────────────────────
  {
    id:       MissionId.WITCHS_TRAIL,
    title:    'The Witch\'s Trail',
    chapter:  1,
    briefing: `The attacks aren't random — they're directed. A trail of dark magic leads deep into the forest to a clearing dominated by two Power Nodes. The witch must be stopped before her ritual is complete.`,
    victoryText: `The witch screams and dissolves into shadow. The Power Nodes dim. But you know she'll return — this was only the beginning of her plan.`,
    defeatText:  `The witch's ritual is complete. Darkness engulfs Salem.`,

    mapBuilder:    'witchs_trail',
    mapSize:       'standard',

    hasWitch:      true,
    enemyUnits: [
      { type: 'minion', col: 10, row: 3 },
      { type: 'minion', col: 11, row: 6 },
    ],
    waves: [
      { round: 4,  units: [{ type: 'minion', spawnAt: 'graveyard' }] },
      { round: 8,  units: [{ type: 'wood_golem', spawnAt: 'graveyard' }] },
    ],
    aiPersonality: 'hoarder',

    maxSurvivorsFromRoster: 3,
    missionSurvivors:       1,

    objectives: {
      win:  { type: ObjectiveType.SLAY_WITCH, reason: 'The witch is defeated — for now.' },
      lose: { type: ObjectiveType.HERO_KILLED },
    },

    startingResources: {},
    rewards:           { metal: 2, silver: 1, scripture: 1 },

    requires: [MissionId.FIRST_NIGHT],
  },
];
