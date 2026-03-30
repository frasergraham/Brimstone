// ═══════════════════════════════════════════════════════════════════════════
// Campaign: The Salem Prologue
// A 3-mission introductory arc set in cursed colonial Salem.
// ═══════════════════════════════════════════════════════════════════════════

import { Tile, TileType, BuildingType, ResourceType } from '../../tiles.js';
import { hexKey, setMapDimensions } from '../../hex.js';
import { NODE_COLORS } from '../../map.js';

// ── Map helpers ────────────────────────────────────────────────────────────

function makeTiles(cols, rows) {
  const tiles = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.set(hexKey(col, row), new Tile(col, row, TileType.GRASS));
    }
  }
  return tiles;
}

function setBuilding(tiles, col, row, building, fortLevel = 0) {
  const t = tiles.get(hexKey(col, row));
  if (t) { t.type = TileType.BUILDING; t.building = building; t.fortifyLevel = fortLevel; }
}

function setForest(tiles, hexes) {
  for (const { col, row } of hexes) {
    const t = tiles.get(hexKey(col, row));
    if (t && t.type === TileType.GRASS) t.type = TileType.FOREST;
  }
}

function addRoad(tiles, from, to) {
  const a = tiles.get(hexKey(from.col, from.row));
  const b = tiles.get(hexKey(to.col, to.row));
  if (a) a.roadDirs.add(hexKey(to.col, to.row));
  if (b) b.roadDirs.add(hexKey(from.col, from.row));
}

function setResource(tiles, col, row, resource) {
  const t = tiles.get(hexKey(col, row));
  if (t) t.resource = resource;
}

function setHiddenSurvivor(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  if (t) t.hiddenSurvivor = true;
}

// ── Map builders ───────────────────────────────────────────────────────────

function buildPrologueMap() {
  const COLS = 9, ROWS = 9;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  setBuilding(tiles, 2, 7, BuildingType.INN, 1);
  setBuilding(tiles, 4, 5, BuildingType.CHURCH, 0);
  setBuilding(tiles, 3, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 6, 4, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 7, 6, BuildingType.BARN, 0);

  setForest(tiles, [
    { col: 0, row: 2 }, { col: 1, row: 2 }, { col: 0, row: 3 },
    { col: 7, row: 1 }, { col: 8, row: 1 }, { col: 8, row: 2 },
  ]);

  addRoad(tiles, { col: 2, row: 7 }, { col: 3, row: 6 });
  addRoad(tiles, { col: 3, row: 6 }, { col: 4, row: 5 });
  addRoad(tiles, { col: 4, row: 5 }, { col: 3, row: 4 });
  addRoad(tiles, { col: 3, row: 4 }, { col: 3, row: 3 });
  addRoad(tiles, { col: 4, row: 5 }, { col: 5, row: 4 });
  addRoad(tiles, { col: 5, row: 4 }, { col: 6, row: 4 });

  for (const rc of [{ col: 3, row: 6 }, { col: 3, row: 4 }, { col: 5, row: 4 }]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && t.type === TileType.GRASS) t.type = TileType.ROAD;
  }

  setResource(tiles, 1, 5, ResourceType.HERBS);
  setResource(tiles, 5, 3, ResourceType.WOOD);
  setHiddenSurvivor(tiles, 4, 5);

  return {
    tiles,
    witchObjectives: [],
    heroStart:      { col: 2, row: 7 },
    witchStart:     { col: 7, row: 1 },
    mapSize:        'skirmish',
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

function buildFirstNightMap() {
  const COLS = 13, ROWS = 13;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  setBuilding(tiles, 2, 8, BuildingType.INN, 1);
  setBuilding(tiles, 3, 6, BuildingType.CHURCH, 1);
  setBuilding(tiles, 1, 6, BuildingType.HOUSE, 0);
  setBuilding(tiles, 4, 7, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 2, 5, BuildingType.APOTHECARY, 0);
  setBuilding(tiles, 5, 9, BuildingType.BARN, 0);
  setBuilding(tiles, 10, 3, BuildingType.GRAVEYARD, 0);
  setBuilding(tiles, 6, 6, BuildingType.WATCHTOWER, 0);

  setForest(tiles, [
    { col: 7, row: 4 }, { col: 8, row: 4 }, { col: 7, row: 5 }, { col: 8, row: 5 },
    { col: 9, row: 5 }, { col: 9, row: 6 },
    { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 },
    { col: 11, row: 10 }, { col: 12, row: 10 }, { col: 12, row: 11 },
  ]);

  addRoad(tiles, { col: 2, row: 8 }, { col: 3, row: 7 });
  addRoad(tiles, { col: 3, row: 7 }, { col: 3, row: 6 });
  addRoad(tiles, { col: 3, row: 7 }, { col: 4, row: 7 });
  addRoad(tiles, { col: 3, row: 6 }, { col: 4, row: 6 });
  addRoad(tiles, { col: 4, row: 6 }, { col: 5, row: 6 });
  addRoad(tiles, { col: 5, row: 6 }, { col: 6, row: 6 });
  for (const rc of [{ col: 3, row: 7 }, { col: 4, row: 6 }, { col: 5, row: 6 }]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && t.type === TileType.GRASS) t.type = TileType.ROAD;
  }

  setResource(tiles, 5, 8, ResourceType.WOOD);
  setResource(tiles, 1, 7, ResourceType.HERBS);
  setResource(tiles, 8, 7, ResourceType.FOOD);
  setHiddenSurvivor(tiles, 6, 6);

  const witchObjectives = [
    {
      col: 4, row: 7,
      label: 'Village Square',
      hexes: [{ col: 4, row: 7 }, { col: 3, row: 7 }, { col: 5, row: 7 }],
      color: NODE_COLORS[0],
      seenByHero: true,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 2, row: 8 },
    witchStart:     { col: 10, row: 3 },
    mapSize:        'standard',
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

function buildWitchsTrailMap() {
  const COLS = 13, ROWS = 13;
  setMapDimensions(COLS, ROWS);
  const tiles = makeTiles(COLS, ROWS);

  setBuilding(tiles, 1, 10, BuildingType.INN, 1);
  setBuilding(tiles, 2, 9, BuildingType.HOUSE, 0);
  setBuilding(tiles, 3, 10, BuildingType.STABLE, 0);
  setBuilding(tiles, 10, 2, BuildingType.GRAVEYARD, 1);
  setBuilding(tiles, 11, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 6, 6, BuildingType.CHURCH, 0);
  setBuilding(tiles, 5, 4, BuildingType.WATCHTOWER, 0);
  setBuilding(tiles, 8, 8, BuildingType.BLACKSMITH, 0);

  setForest(tiles, [
    { col: 3, row: 7 }, { col: 4, row: 7 }, { col: 4, row: 6 },
    { col: 5, row: 6 }, { col: 5, row: 5 },
    { col: 7, row: 4 }, { col: 8, row: 4 }, { col: 8, row: 3 }, { col: 9, row: 3 },
    { col: 3, row: 8 }, { col: 2, row: 7 },
    { col: 9, row: 7 }, { col: 10, row: 7 }, { col: 10, row: 6 },
    { col: 7, row: 9 }, { col: 8, row: 9 },
  ]);

  addRoad(tiles, { col: 1, row: 10 }, { col: 2, row: 9 });
  addRoad(tiles, { col: 2, row: 9 }, { col: 3, row: 9 });
  addRoad(tiles, { col: 3, row: 9 }, { col: 4, row: 8 });
  addRoad(tiles, { col: 4, row: 8 }, { col: 5, row: 7 });
  addRoad(tiles, { col: 5, row: 7 }, { col: 6, row: 6 });
  for (const rc of [{ col: 3, row: 9 }, { col: 4, row: 8 }, { col: 5, row: 7 }]) {
    const t = tiles.get(hexKey(rc.col, rc.row));
    if (t && t.type === TileType.GRASS) t.type = TileType.ROAD;
  }

  setResource(tiles, 2, 8, ResourceType.WOOD);
  setResource(tiles, 7, 5, ResourceType.METAL);
  setResource(tiles, 9, 9, ResourceType.HERBS);
  setResource(tiles, 4, 3, ResourceType.SILVER);
  setHiddenSurvivor(tiles, 6, 6);

  const witchObjectives = [
    {
      col: 5, row: 5,
      label: 'Forest Shrine',
      hexes: [{ col: 5, row: 5 }, { col: 6, row: 5 }, { col: 5, row: 4 }],
      color: NODE_COLORS[0],
      seenByHero: false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
    {
      col: 9, row: 6,
      label: 'Dark Hollow',
      hexes: [{ col: 9, row: 6 }, { col: 8, row: 6 }, { col: 9, row: 5 }],
      color: NODE_COLORS[1],
      seenByHero: false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 1, row: 10 },
    witchStart:     { col: 10, row: 2 },
    mapSize:        'standard',
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

// ── Mission definitions ────────────────────────────────────────────────────

const MAP_BUILDERS = {
  prologue:     buildPrologueMap,
  first_night:  buildFirstNightMap,
  witchs_trail: buildWitchsTrailMap,
};

const MISSIONS = [
  {
    id:       'prologue',
    title:    'The Awakening',
    chapter:  1,
    briefing: `You awaken at the Salem Inn to the sound of screaming. The dead walk the streets — shambling corpses driven by an unseen malice. Grab what you can and clear the village before more arrive.`,
    victoryText: `The last corpse crumbles to dust. Silence returns to Salem's streets, but you sense this is only the beginning. A survivor stumbles from the wreckage — together, you may stand a chance against what's coming.`,
    defeatText:  `The dead overwhelm you. Salem falls before the fight even begins.`,

    mapBuilder:      'prologue',
    mapSize:         'skirmish',

    hasWitch:        false,
    disableScoring:  true,
    enemyUnits: [
      { type: 'zombie', col: 3, row: 2 },
      { type: 'zombie', col: 6, row: 5 },
      { type: 'zombie', col: 5, row: 7 },
    ],
    waves:         null,
    aiPersonality: 'balanced',

    maxSurvivorsFromRoster:    0,
    missionSurvivors:          1,
    maxDiscoverableSurvivors:  2,

    objectives: {
      win:  { type: 'eliminate_all', reason: 'The streets of Salem are clear.' },
      lose: { type: 'hero_killed' },
    },

    startingResources: { food: 1, herbs: 1, wood: 1 },
    rewards:           { herbs: 2, food: 1, wood: 1 },

    requires: null,
  },

  {
    id:       'first_night',
    title:    'The First Night',
    chapter:  1,
    briefing: `Dusk falls and the dead grow bolder. Waves of corpses claw their way from the old graveyard. Barricade the village and survive until dawn — 8 rounds of relentless assault.`,
    victoryText: `Dawn breaks. The wave subsides, leaving the village battered but standing. Among the rubble, a new ally emerges — another survivor drawn to your fight.`,
    defeatText:  `The dead breach your defenses. Salem is overrun.`,

    mapBuilder:      'first_night',
    mapSize:         'standard',

    hasWitch:        false,
    disableScoring:  true,
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

    maxSurvivorsFromRoster:    2,
    missionSurvivors:          1,
    maxDiscoverableSurvivors:  2,

    objectives: {
      win:  { type: 'survive_rounds', rounds: 8, reason: 'You survived the night. Dawn brings hope.' },
      lose: { type: 'hero_killed' },
    },

    startingResources: { wood: 3, metal: 1 },
    rewards:           { wood: 2, metal: 1, food: 2 },

    requires: ['prologue'],
  },

  {
    id:       'witchs_trail',
    title:    'The Witch\'s Trail',
    chapter:  1,
    briefing: `The attacks aren't random — they're directed. A trail of dark magic leads deep into the forest to a clearing dominated by two Power Nodes. The witch must be stopped before her ritual is complete.`,
    victoryText: `The witch screams and dissolves into shadow. The Power Nodes dim. But you know she'll return — this was only the beginning of her plan.`,
    defeatText:  `The witch's ritual is complete. Darkness engulfs Salem.`,

    mapBuilder:      'witchs_trail',
    mapSize:         'standard',

    hasWitch:        true,
    disableScoring:  true,
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
    minSurvivors:           1,
    maxSurvivors:           3,

    objectives: {
      win:  { type: 'slay_witch', reason: 'The witch is defeated — for now.' },
      lose: { type: 'hero_killed' },
    },

    startingResources: {},
    rewards:           { metal: 2, silver: 1, scripture: 1 },

    requires: ['first_night'],
  },
];

// ── Campaign definition ────────────────────────────────────────────────────

export default {
  id:          'salem_prologue',
  title:       'Chapter 1 - Prologue',
  description: 'A cursed village, the walking dead, and a witch pulling the strings. Three missions stand between Salem and oblivion.',
  missions:    MISSIONS,
  mapBuilders: MAP_BUILDERS,
  firstMission: 'prologue',
  prerequisiteCampaign: null,
};
