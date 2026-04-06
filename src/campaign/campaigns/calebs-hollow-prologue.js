// ═══════════════════════════════════════════════════════════════════════════
// Campaign: The Caleb's Hollow Prologue
// A 6-mission introductory arc set in cursed colonial Caleb's Hollow.
// ═══════════════════════════════════════════════════════════════════════════

import { Tile, TileType, BuildingType, ResourceType } from '../../tiles.js';
import { hexKey, setMapDimensions, getNeighbors, hexDistance } from '../../hex.js';
import {
  NODE_COLORS, rng, bfsPath, shuffle, generateRiverNS, generateRiverEW,
  buildRiverMap, riverSide,
} from '../../map.js';

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

function setResource(tiles, col, row, resource) {
  const t = tiles.get(hexKey(col, row));
  if (t) t.resource = resource;
}

function setHiddenSurvivor(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  if (t) t.hiddenSurvivor = true;
}

/**
 * Carve a river onto the tile map from a river path array.
 */
function carveRiver(tiles, riverPath) {
  for (const { col, row } of riverPath) {
    const t = tiles.get(hexKey(col, row));
    if (t && t.type !== TileType.BUILDING) t.type = TileType.RIVER;
  }
}

/**
 * Grow forest clusters from seed positions.
 */
function growForests(tiles, seeds, rand, density = 0.70, spread = 0.40) {
  for (const seed of seeds) {
    const candidates = [seed, ...getNeighbors(seed.col, seed.row)];
    for (const { col, row } of candidates) {
      const t = tiles.get(hexKey(col, row));
      if (t && t.type === TileType.GRASS && rand() < density) {
        t.type = TileType.FOREST;
        for (const n of getNeighbors(col, row)) {
          const t2 = tiles.get(hexKey(n.col, n.row));
          if (t2 && t2.type === TileType.GRASS && rand() < spread) {
            t2.type = TileType.FOREST;
          }
        }
      }
    }
  }
}

/**
 * Scatter dirt patches for visual texture.
 */
function scatterDirt(tiles, count, rand, cols) {
  for (let i = 0; i < count; i++) {
    const grassTiles = [];
    for (const [, t] of tiles) {
      if (t.type === TileType.GRASS && t.col >= 1 && t.col <= cols - 2) grassTiles.push(t);
    }
    shuffle(grassTiles, rand);
    if (!grassTiles.length) break;
    grassTiles[0].type = TileType.DIRT;
    for (const n of getNeighbors(grassTiles[0].col, grassTiles[0].row)) {
      const t = tiles.get(hexKey(n.col, n.row));
      if (t && t.type === TileType.GRASS && rand() < 0.35) t.type = TileType.DIRT;
    }
  }
}

/**
 * Build MST road network between a set of key building positions.
 * Returns number of bridges placed.
 */
function buildRoadNetwork(tiles, buildings, rand, maxBridges = 2) {
  if (buildings.length < 2) return 0;

  // Kruskal's MST
  const n = buildings.length;
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      edges.push({ i, j, d: hexDistance(buildings[i].col, buildings[i].row, buildings[j].col, buildings[j].row) });
    }
  }
  edges.sort((a, b) => a.d - b.d);

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

  const mstEdges = [];
  for (const { i, j } of edges) {
    if (find(i) !== find(j)) {
      parent[find(i)] = find(j);
      mstEdges.push({ from: buildings[i], to: buildings[j] });
      if (mstEdges.length === n - 1) break;
    }
  }

  // Place roads via BFS pathfinding
  let bridgesPlaced = 0;
  const roadTiles = new Set();

  for (const { from, to } of mstEdges) {
    const path = bfsPath(tiles, from.col, from.row, to.col, to.row, rand, roadTiles);
    for (let k = 0; k < path.length; k++) {
      const { col, row } = path[k];
      const t = tiles.get(hexKey(col, row));
      if (!t) continue;
      if (t.type === TileType.GRASS || t.type === TileType.DIRT || t.type === TileType.FOREST) {
        t.type = TileType.ROAD;
        roadTiles.add(hexKey(col, row));
      } else if (t.type === TileType.RIVER && bridgesPlaced < maxBridges) {
        t.type = TileType.BRIDGE;
        bridgesPlaced++;
        roadTiles.add(hexKey(col, row));
      }
      if (k > 0) {
        const prev = path[k - 1];
        const prevTile = tiles.get(hexKey(prev.col, prev.row));
        if (prevTile) {
          t.roadDirs.add(hexKey(prev.col, prev.row));
          prevTile.roadDirs.add(hexKey(col, row));
        }
      }
    }
  }

  return bridgesPlaced;
}

// ── Map builders ───────────────────────────────────────────────────────────

function buildPrologueMap() {
  const COLS = 9, ROWS = 9;
  setMapDimensions(COLS, ROWS);
  const rand = rng(42);
  const tiles = makeTiles(COLS, ROWS);

  // River (N-S)
  const riverPath = generateRiverNS(rand);
  carveRiver(tiles, riverPath);

  // Buildings
  setBuilding(tiles, 2, 7, BuildingType.INN, 1);
  setBuilding(tiles, 4, 5, BuildingType.CHURCH, 0);
  setBuilding(tiles, 3, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 6, 4, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 7, 6, BuildingType.BARN, 0);

  // MST road network
  const bldgs = [
    { col: 2, row: 7 }, { col: 4, row: 5 }, { col: 3, row: 3 },
    { col: 6, row: 4 }, { col: 7, row: 6 },
  ];
  buildRoadNetwork(tiles, bldgs, rand, 1);

  // Forest clusters
  growForests(tiles, [
    { col: 0, row: 2 }, { col: 8, row: 1 },
    { col: 1, row: 0 }, { col: 7, row: 8 },
  ], rand);

  // Dirt patches
  scatterDirt(tiles, 3, rand, COLS);

  // Resources
  setResource(tiles, 1, 5, ResourceType.HERBS);
  setResource(tiles, 5, 3, ResourceType.WOOD);

  return {
    tiles,
    witchObjectives: [],
    heroStart:      { col: 2, row: 7 },
    witchStart:     { col: 7, row: 1 },
    mapSize:        'skirmish',
    survivorCounts: { buildings: 0, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

function buildGatheringSurvivorsMap() {
  const COLS = 11, ROWS = 11;
  setMapDimensions(COLS, ROWS);
  const rand = rng(137);
  const tiles = makeTiles(COLS, ROWS);

  // River (N-S)
  const riverPath = generateRiverNS(rand);
  carveRiver(tiles, riverPath);

  // Buildings
  setBuilding(tiles, 1, 9, BuildingType.INN, 1);
  setBuilding(tiles, 5, 5, BuildingType.CHURCH, 0);
  setBuilding(tiles, 3, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 7, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 8, 7, BuildingType.BARN, 0);
  setBuilding(tiles, 4, 7, BuildingType.APOTHECARY, 0);
  setBuilding(tiles, 9, 2, BuildingType.STABLE, 0);

  // MST roads
  const bldgs = [
    { col: 1, row: 9 }, { col: 5, row: 5 }, { col: 3, row: 3 },
    { col: 7, row: 3 }, { col: 8, row: 7 }, { col: 4, row: 7 },
    { col: 9, row: 2 },
  ];
  buildRoadNetwork(tiles, bldgs, rand, 2);

  // Forest clusters
  growForests(tiles, [
    { col: 0, row: 1 }, { col: 10, row: 1 },
    { col: 0, row: 6 }, { col: 10, row: 9 },
    { col: 6, row: 8 },
  ], rand);

  // Dirt patches
  scatterDirt(tiles, 4, rand, COLS);

  // Resources + survivors
  setResource(tiles, 2, 7, ResourceType.FOOD);
  setResource(tiles, 6, 4, ResourceType.HERBS);
  setResource(tiles, 8, 5, ResourceType.WOOD);
  setHiddenSurvivor(tiles, 5, 5);   // church
  setHiddenSurvivor(tiles, 8, 7);   // barn
  setHiddenSurvivor(tiles, 3, 3);   // house

  return {
    tiles,
    witchObjectives: [],
    heroStart:      { col: 1, row: 9 },
    witchStart:     { col: 9, row: 1 },
    mapSize:        'skirmish',
    survivorCounts: { buildings: 2, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

function buildFirstNightMap() {
  const COLS = 13, ROWS = 13;
  setMapDimensions(COLS, ROWS);
  const rand = rng(256);
  const tiles = makeTiles(COLS, ROWS);

  // River (E-W)
  const riverPath = generateRiverEW(rand);
  carveRiver(tiles, riverPath);

  // Buildings
  setBuilding(tiles, 2, 8, BuildingType.INN, 1);
  setBuilding(tiles, 3, 6, BuildingType.CHURCH, 1);
  setBuilding(tiles, 1, 6, BuildingType.HOUSE, 0);
  setBuilding(tiles, 4, 7, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 2, 5, BuildingType.APOTHECARY, 0);
  setBuilding(tiles, 5, 9, BuildingType.BARN, 0);
  setBuilding(tiles, 10, 3, BuildingType.GRAVEYARD, 0);
  setBuilding(tiles, 6, 6, BuildingType.WATCHTOWER, 0);

  // MST roads
  const bldgs = [
    { col: 2, row: 8 }, { col: 3, row: 6 }, { col: 1, row: 6 },
    { col: 4, row: 7 }, { col: 2, row: 5 }, { col: 5, row: 9 },
    { col: 10, row: 3 }, { col: 6, row: 6 },
  ];
  buildRoadNetwork(tiles, bldgs, rand, 2);

  // Forest clusters
  growForests(tiles, [
    { col: 7, row: 4 }, { col: 9, row: 5 },
    { col: 0, row: 0 }, { col: 12, row: 10 },
    { col: 8, row: 9 }, { col: 1, row: 2 },
  ], rand);

  // Dirt patches
  scatterDirt(tiles, 5, rand, COLS);

  // Resources + survivor
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

function buildRiverCrossingMap() {
  const COLS = 17, ROWS = 9;
  setMapDimensions(COLS, ROWS);
  const rand = rng(314);
  const tiles = makeTiles(COLS, ROWS);

  // N-S river cutting across near the east end (col ~12)
  // Hand-placed for the narrow corridor shape
  const riverCol = 12;
  const riverPath = [];
  for (let row = 0; row < ROWS; row++) {
    const drift = Math.floor(rand() * 3) - 1;
    const col = Math.max(10, Math.min(14, riverCol + drift));
    riverPath.push({ col, row });
  }
  carveRiver(tiles, riverPath);
  const riverMap = buildRiverMap(riverPath, false);

  // Buildings
  setBuilding(tiles, 1, 4, BuildingType.INN, 1);          // west start
  setBuilding(tiles, 5, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 8, 5, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 14, 2, BuildingType.GRAVEYARD, 0);    // far side
  setBuilding(tiles, 15, 6, BuildingType.WATCHTOWER, 0);   // far side

  // MST roads
  const bldgs = [
    { col: 1, row: 4 }, { col: 5, row: 3 }, { col: 8, row: 5 },
    { col: 14, row: 2 }, { col: 15, row: 6 },
  ];
  buildRoadNetwork(tiles, bldgs, rand, 2);

  // Dense forest flanking the road
  growForests(tiles, [
    { col: 3, row: 1 }, { col: 6, row: 7 },
    { col: 4, row: 6 }, { col: 9, row: 1 },
    { col: 7, row: 7 }, { col: 2, row: 0 },
    { col: 10, row: 7 }, { col: 15, row: 1 },
  ], rand, 0.65, 0.35);

  // Dirt
  scatterDirt(tiles, 3, rand, COLS);

  // Resources
  setResource(tiles, 3, 5, ResourceType.FOOD);
  setResource(tiles, 7, 2, ResourceType.WOOD);
  setHiddenSurvivor(tiles, 8, 5);

  return {
    tiles,
    witchObjectives: [],
    heroStart:      { col: 1, row: 4 },
    witchStart:     { col: 15, row: 2 },
    mapSize:        'standard',   // action budget
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
    // reach_hex objective uses this
    targetHex: { col: 16, row: 4 },
  };
}

function buildDarkRitualMap() {
  const COLS = 13, ROWS = 13;
  setMapDimensions(COLS, ROWS);
  const rand = rng(666);
  const tiles = makeTiles(COLS, ROWS);

  // River (N-S)
  const riverPath = generateRiverNS(rand);
  carveRiver(tiles, riverPath);

  // Buildings
  setBuilding(tiles, 2, 10, BuildingType.INN, 1);
  setBuilding(tiles, 4, 8, BuildingType.CHURCH, 0);
  setBuilding(tiles, 10, 2, BuildingType.GRAVEYARD, 0);
  setBuilding(tiles, 7, 5, BuildingType.WATCHTOWER, 0);
  setBuilding(tiles, 3, 5, BuildingType.HOUSE, 0);
  setBuilding(tiles, 9, 8, BuildingType.BLACKSMITH, 0);

  // MST roads
  const bldgs = [
    { col: 2, row: 10 }, { col: 4, row: 8 }, { col: 10, row: 2 },
    { col: 7, row: 5 }, { col: 3, row: 5 }, { col: 9, row: 8 },
  ];
  buildRoadNetwork(tiles, bldgs, rand, 2);

  // Dense forests (ritual theme)
  growForests(tiles, [
    { col: 5, row: 3 }, { col: 8, row: 3 },
    { col: 1, row: 3 }, { col: 11, row: 7 },
    { col: 6, row: 9 }, { col: 0, row: 7 },
    { col: 11, row: 11 }, { col: 3, row: 1 },
  ], rand, 0.75, 0.45);

  // Dirt
  scatterDirt(tiles, 4, rand, COLS);

  // Resources
  setResource(tiles, 3, 9, ResourceType.METAL);
  setResource(tiles, 8, 4, ResourceType.HERBS);
  setResource(tiles, 6, 7, ResourceType.WOOD);
  setHiddenSurvivor(tiles, 7, 5);

  // Two power nodes
  const witchObjectives = [
    {
      col: 5, row: 4,
      label: 'Ritual Circle',
      hexes: [{ col: 5, row: 4 }, { col: 4, row: 4 }, { col: 5, row: 3 }],
      color: NODE_COLORS[0],
      seenByHero: false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
    {
      col: 9, row: 6,
      label: 'Dark Altar',
      hexes: [{ col: 9, row: 6 }, { col: 10, row: 6 }, { col: 9, row: 5 }],
      color: NODE_COLORS[1],
      seenByHero: false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 2, row: 10 },
    witchStart:     { col: 10, row: 2 },
    mapSize:        'standard',
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

function buildWitchsTrailMap() {
  const COLS = 13, ROWS = 13;
  setMapDimensions(COLS, ROWS);
  const rand = rng(999);
  const tiles = makeTiles(COLS, ROWS);

  // River (N-S) dividing the map
  const riverPath = generateRiverNS(rand);
  carveRiver(tiles, riverPath);

  // Buildings
  setBuilding(tiles, 1, 10, BuildingType.INN, 1);
  setBuilding(tiles, 2, 9, BuildingType.HOUSE, 0);
  setBuilding(tiles, 3, 10, BuildingType.STABLE, 0);
  setBuilding(tiles, 10, 2, BuildingType.GRAVEYARD, 1);
  setBuilding(tiles, 11, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 6, 6, BuildingType.CHURCH, 0);
  setBuilding(tiles, 5, 4, BuildingType.WATCHTOWER, 0);
  setBuilding(tiles, 8, 8, BuildingType.BLACKSMITH, 0);

  // MST roads with bridges as chokepoints
  const bldgs = [
    { col: 1, row: 10 }, { col: 2, row: 9 }, { col: 3, row: 10 },
    { col: 10, row: 2 }, { col: 11, row: 3 }, { col: 6, row: 6 },
    { col: 5, row: 4 }, { col: 8, row: 8 },
  ];
  buildRoadNetwork(tiles, bldgs, rand, 2);

  // Dense forest clusters (deep forest theme)
  growForests(tiles, [
    { col: 3, row: 7 }, { col: 4, row: 6 },
    { col: 5, row: 5 }, { col: 7, row: 4 },
    { col: 8, row: 3 }, { col: 9, row: 7 },
    { col: 3, row: 8 }, { col: 7, row: 9 },
    { col: 1, row: 1 }, { col: 11, row: 11 },
  ], rand, 0.75, 0.45);

  // Dirt
  scatterDirt(tiles, 4, rand, COLS);

  // Resources + survivor
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
  prologue:             buildPrologueMap,
  gathering_survivors:  buildGatheringSurvivorsMap,
  first_night:          buildFirstNightMap,
  river_crossing:       buildRiverCrossingMap,
  dark_ritual:          buildDarkRitualMap,
  witchs_trail:         buildWitchsTrailMap,
};

const MISSIONS = [
  // ── Mission 1: The Awakening ──────────────────────────────────────────
  {
    id:       'prologue',
    title:    'The Awakening',
    chapter:  1,
    briefing: `You awaken at the Caleb's Hollow Inn to the sound of screaming. The dead walk the streets — shambling corpses driven by an unseen malice. Grab what you can and clear the village before more arrive.`,
    victoryText: `The last corpse crumbles to dust. Silence returns to Caleb's Hollow's streets, but you sense this is only the beginning. A survivor stumbles from the wreckage — together, you may stand a chance against what's coming.`,
    defeatText:  `The dead overwhelm you. Caleb's Hollow falls before the fight even begins.`,

    mapBuilder:      'prologue',
    mapSize:         'skirmish',

    hasWitch:        false,
    disableScoring:  true,
    enemyUnits: [
      { type: 'zombie', col: 3, row: 2 },
      { type: 'zombie', col: 6, row: 5 },
      { type: 'zombie', col: 5, row: 7 },
    ],
    waves: [
      { round: 3, units: [{ type: 'zombie', spawnAt: 'map_edge' }] },
      { round: 5, units: [{ type: 'zombie', spawnAt: 'map_edge' }, { type: 'zombie', spawnAt: 'map_edge' }] },
    ],
    aiPersonality: 'balanced',

    maxSurvivorsFromRoster:    0,
    missionSurvivors:          1,
    maxDiscoverableSurvivors:  0,

    objectives: {
      win:  { type: 'eliminate_all', reason: 'The streets of Caleb\'s Hollow are clear.' },
      lose: { type: 'hero_killed' },
    },

    startingResources: { food: 1, herbs: 1, wood: 1 },
    rewards:           { herbs: 2, food: 1, wood: 1 },
    healBonus:         2,

    lootOverrides: { remove: ['horse'] },

    storyTriggers: [
      { type: 'round', round: 1, title: 'A Grim Dawn',
        text: 'The streets of Caleb\'s Hollow are eerily silent. Through the morning mist, you can make out shambling figures — the dead have risen. The Caleb\'s Hollow Inn stands behind you, its doors battered but holding. You must clear the village before nightfall.',
        flag: 'prologue_intro' },
    ],

    requires: null,
  },

  // ── Mission 2: Gathering Survivors ────────────────────────────────────
  {
    id:       'gathering_survivors',
    title:    'Gathering Survivors',
    chapter:  1,
    briefing: `The village is clear, but others may have survived. Smoke rises from distant buildings — signs of life, or something worse. Search Caleb's Hollow's outskirts and bring any survivors back before the dead return.`,
    victoryText: `The last zombie falls. You've gathered a small band of survivors — frightened but determined. Together you fortify what remains of Caleb's Hollow, knowing the true horror still lurks beyond the tree line.`,
    defeatText:  `You searched too far and too recklessly. The dead found you before you found help.`,

    mapBuilder:      'gathering_survivors',
    mapSize:         'skirmish',

    hasWitch:        false,
    disableScoring:  true,
    enemyUnits: [
      { type: 'zombie', col: 6, row: 3 },
      { type: 'zombie', col: 9, row: 6 },
    ],
    waves: [
      { round: 3, units: [{ type: 'zombie', spawnAt: 'map_edge' }] },
      { round: 6, units: [{ type: 'zombie', spawnAt: 'map_edge' }, { type: 'zombie', spawnAt: 'map_edge' }] },
    ],
    aiPersonality: 'balanced',

    maxSurvivorsFromRoster:    0,
    missionSurvivors:          2,
    maxDiscoverableSurvivors:  3,

    objectives: {
      win:  { type: 'eliminate_all', reason: 'The area is secure. Your band of survivors grows.' },
      lose: { type: 'hero_killed' },
    },

    startingResources: { food: 1, herbs: 1 },
    rewards:           { food: 2, herbs: 1, wood: 2 },
    healBonus:         2,

    storyTriggers: [
      { type: 'round', round: 1, title: 'Voices in the Fog',
        text: 'Through the morning haze you hear voices — desperate, frightened. Others survived the night. You must reach them before the dead do.',
        flag: 'gathering_intro' },
      { type: 'area', hexes: [{ col: 5, row: 5 }], title: 'Sanctuary',
        text: 'The church doors are barricaded from the inside. You call out and hear weeping — then the scrape of wood as the barricade is removed. A survivor emerges, pale but alive.',
        flag: 'found_church' },
    ],

    requires: ['prologue'],
  },

  // ── Mission 3: The First Night ────────────────────────────────────────
  {
    id:       'first_night',
    title:    'The First Night',
    chapter:  1,
    briefing: `Dusk falls and the dead grow bolder. Waves of corpses claw their way from the old graveyard. Barricade the village and survive until dawn — 10 rounds of relentless assault.`,
    victoryText: `Dawn breaks. The wave subsides, leaving the village battered but standing. Among the rubble, a new ally emerges — another survivor drawn to your fight.`,
    defeatText:  `The dead breach your defenses. Caleb's Hollow is overrun.`,

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
      { round: 9,  units: [{ type: 'zombie', spawnAt: 'graveyard' }, { type: 'minion', spawnAt: 'map_edge' }, { type: 'zombie', spawnAt: 'map_edge' }] },
    ],
    aiPersonality: 'aggressive',

    maxSurvivorsFromRoster:    2,
    missionSurvivors:          1,
    maxDiscoverableSurvivors:  2,

    objectives: {
      win:  { type: 'survive_rounds', rounds: 10, reason: 'You survived the night. Dawn brings hope.' },
      lose: { type: 'hero_killed' },
    },

    startingResources: { wood: 3, metal: 1 },
    rewards:           { wood: 2, metal: 1, food: 2 },
    healBonus:         3,

    lootOverrides: {
      remove: ['horse'],
      buildings: { barn: [{ type: 'wood', weight: 60 }, { type: 'food', weight: 35 }, { type: 'nothing', weight: 5 }] },
    },

    storyTriggers: [
      { type: 'round', round: 1, title: 'Darkness Falls',
        text: 'The sun dips below the treeline and the temperature drops. From the direction of the old graveyard, you hear the scraping of earth and the crack of coffin wood. They are coming.',
        flag: 'first_night_start' },
      { type: 'round', round: 5, title: 'The Witching Hour',
        text: 'Midnight. The attacks intensify. Something more than zombies stirs in the darkness — you catch a glimpse of unnatural movement at the tree line. Whatever drives these dead, it is close.',
        flag: 'witching_hour' },
    ],

    requires: ['gathering_survivors'],
  },

  // ── Mission 4: The River Crossing ─────────────────────────────────────
  {
    id:       'river_crossing',
    title:    'The River Crossing',
    chapter:  1,
    briefing: `Intelligence points to a witch encampment beyond the river. The only way across is a pair of narrow bridges, and the dead patrol the road. Fight through the forest gauntlet and cross before reinforcements arrive.`,
    victoryText: `You made it across. The far bank is quiet — for now. But the trail of dark magic grows stronger. The witch's lair cannot be far.`,
    defeatText:  `The dead hold the crossing. You retreat, bloodied and beaten.`,

    mapBuilder:      'river_crossing',
    mapSize:         'standard',

    hasWitch:        false,
    disableScoring:  true,
    enemyUnits: [
      { type: 'zombie', col: 6, row: 3 },
      { type: 'zombie', col: 9, row: 5 },
      { type: 'zombie', col: 11, row: 4 },
      { type: 'minion', col: 13, row: 4 },
    ],
    waves: [
      { round: 4,  units: [{ type: 'zombie', spawnAt: 'map_edge' }] },
      { round: 7,  units: [{ type: 'minion', spawnAt: 'map_edge' }, { type: 'zombie', spawnAt: 'map_edge' }] },
      { round: 10, units: [{ type: 'wood_golem', spawnAt: 'map_edge' }] },
    ],
    aiPersonality: 'aggressive',

    maxSurvivorsFromRoster:    2,
    missionSurvivors:          1,
    maxDiscoverableSurvivors:  1,

    objectives: {
      win:  { type: 'reach_hex', col: 16, row: 4, reason: 'You crossed the river. The witch\'s trail leads deeper into the wilderness.' },
      lose: [
        { type: 'hero_killed' },
        { type: 'rounds_exceeded', rounds: 15, reason: 'Reinforcements arrived. The crossing is lost.' },
      ],
    },

    startingResources: { food: 2, wood: 1 },
    rewards:           { metal: 2, wood: 1, herbs: 1 },
    healBonus:         3,

    storyTriggers: [
      { type: 'round', round: 1, title: 'The Long Road',
        text: 'A narrow trail leads east through dense forest. The river glints in the distance — your only way forward. But the dead have been here. Fresh tracks in the mud, broken branches, the stench of decay.',
        flag: 'river_start' },
      { type: 'area', hexes: [{ col: 12, row: 3 }, { col: 12, row: 4 }, { col: 12, row: 5 }, { col: 11, row: 4 }], title: 'The Crossing',
        text: 'The bridge is ancient, its timbers groaning under your weight. On the far bank, shadows move between the trees. You grip your weapon tighter and step forward.',
        flag: 'at_bridge' },
    ],

    requires: ['first_night'],
  },

  // ── Mission 5: Dark Ritual ────────────────────────────────────────────
  {
    id:       'dark_ritual',
    title:    'Dark Ritual',
    chapter:  1,
    briefing: `Deep in the forest, two Power Nodes pulse with dark energy. Minions and golems guard them as part of an ongoing ritual. Capture the nodes before the ritual is complete — this is your first encounter with the witch's true power.`,
    victoryText: `The nodes dim as you wrest control. The ritual is broken — but the energy has already been channeled somewhere. The witch is preparing something far worse.`,
    defeatText:  `The ritual is complete. Dark energy surges through the ley lines. Caleb's Hollow's fate is sealed.`,

    mapBuilder:      'dark_ritual',
    mapSize:         'standard',

    hasWitch:        false,
    disableScoring:  false,   // standard node scoring
    enemyUnits: [
      { type: 'minion', col: 5, row: 3 },
      { type: 'minion', col: 10, row: 5 },
      { type: 'minion', col: 8, row: 7 },
      { type: 'wood_golem', col: 9, row: 3 },
    ],
    waves: [
      { round: 3,  units: [{ type: 'minion', spawnAt: 'map_edge' }] },
      { round: 6,  units: [{ type: 'minion', spawnAt: 'map_edge' }, { type: 'minion', spawnAt: 'map_edge' }] },
      { round: 9,  units: [{ type: 'wood_golem', spawnAt: 'map_edge' }] },
      { round: 12, units: [{ type: 'iron_golem', spawnAt: 'map_edge' }] },
    ],
    aiPersonality: 'hoarder',

    maxSurvivorsFromRoster:    3,
    missionSurvivors:          1,
    minSurvivors:              1,
    maxDiscoverableSurvivors:  1,

    objectives: {
      win:  { type: 'control_nodes', reason: 'The ritual is disrupted. The Power Nodes answer to you now.' },
      lose: [
        { type: 'hero_killed' },
        { type: 'rounds_exceeded', rounds: 20, reason: 'The ritual is complete. Darkness surges forth.' },
      ],
    },

    startingResources: { metal: 1, food: 1 },
    rewards:           { silver: 1, scripture: 1, metal: 1 },
    healBonus:         4,

    lootOverrides: { remove: ['horse'] },

    storyTriggers: [
      { type: 'round', round: 1, title: 'Dark Energy',
        text: 'The air hums with unnatural power. Ahead, two clearings glow with a sickly purple light — Power Nodes, conduits for the witch\'s dark magic. Golems and minions patrol the perimeter. You must seize control before the ritual reaches its crescendo.',
        flag: 'dark_ritual_start' },
      { type: 'round', round: 4, title: 'The Ritual Grows',
        text: 'The ground trembles. Dark tendrils of energy arc between the nodes, growing brighter with each passing moment. Time is running out.',
        flag: 'ritual_grows' },
    ],

    requires: ['river_crossing'],
  },

  // ── Mission 6: The Witch's Trail ──────────────────────────────────────
  {
    id:       'witchs_trail',
    title:    'The Witch\'s Trail',
    chapter:  1,
    briefing: `The attacks aren't random — they're directed. A trail of dark magic leads deep into the forest to a clearing dominated by two Power Nodes. The witch must be stopped before her ritual is complete.`,
    victoryText: `The witch screams and dissolves into shadow. The Power Nodes dim. But you know she'll return — this was only the beginning of her plan.`,
    defeatText:  `The witch's ritual is complete. Darkness engulfs Caleb's Hollow.`,

    mapBuilder:      'witchs_trail',
    mapSize:         'standard',

    hasWitch:        true,
    disableScoring:  true,
    enemyUnits: [
      { type: 'minion', col: 10, row: 3 },
      { type: 'minion', col: 11, row: 6 },
    ],
    waves: [
      { round: 3,  units: [{ type: 'minion', spawnAt: 'graveyard' }] },
      { round: 5,  units: [{ type: 'minion', spawnAt: 'graveyard' }, { type: 'minion', spawnAt: 'map_edge' }] },
      { round: 7,  units: [{ type: 'wood_golem', spawnAt: 'graveyard' }] },
      { round: 10, units: [{ type: 'minion', spawnAt: 'map_edge' }, { type: 'wood_golem', spawnAt: 'graveyard' }] },
    ],
    aiPersonality: 'swarm',

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
    healBonus:         4,

    storyTriggers: [
      { type: 'round', round: 1, title: 'Into the Dark',
        text: 'The trail of corruption leads deep into the forest. The trees here are twisted and blackened, pulsing with malice. Somewhere ahead, a witch bends the land to her will.',
        flag: 'witchs_trail_start' },
      { type: 'round', round: 6, title: 'The Ritual Intensifies',
        text: 'A shockwave of dark energy ripples through the forest. The witch grows stronger with each passing moment — you must press the attack.',
        flag: 'ritual_intensifies' },
    ],

    requires: ['dark_ritual'],
  },
];

// ── Campaign definition ────────────────────────────────────────────────────

export default {
  id:          'calebs_hollow_prologue',
  title:       'Chapter 1 - Prologue',
  description: 'A cursed village, the walking dead, and a witch pulling the strings. Six missions stand between Caleb\'s Hollow and oblivion.',
  missions:    MISSIONS,
  mapBuilders: MAP_BUILDERS,
  firstMission: 'prologue',
  prerequisiteCampaign: null,
};
