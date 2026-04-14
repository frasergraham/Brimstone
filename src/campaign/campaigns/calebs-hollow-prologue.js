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

  // Resources + survivors — one survivor near the hero start, two further away.
  setResource(tiles, 2, 7, ResourceType.FOOD);
  setResource(tiles, 6, 4, ResourceType.HERBS);
  setResource(tiles, 8, 5, ResourceType.WOOD);
  setHiddenSurvivor(tiles, 4, 7);   // apothecary — close to inn at (1,9)
  setHiddenSurvivor(tiles, 3, 3);   // house — across the map
  setHiddenSurvivor(tiles, 8, 7);   // barn — far east

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

  // Resources clustered in and around the starting buildings — the village
  // is holed up for the night. No hidden survivors on this mission: the
  // mission deploys a fixed party via survivorStartPositions.
  setResource(tiles, 5, 8, ResourceType.WOOD);
  setResource(tiles, 1, 7, ResourceType.HERBS);
  setResource(tiles, 3, 8, ResourceType.FOOD);
  setResource(tiles, 2, 4, ResourceType.WOOD);

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

  // N-S river cutting the map roughly in half (cols 9-12 with drift).
  const riverCol = 10;
  const riverPath = [];
  for (let row = 0; row < ROWS; row++) {
    const drift = Math.floor(rand() * 3) - 1;
    const col = Math.max(9, Math.min(12, riverCol + drift));
    riverPath.push({ col, row });
  }
  carveRiver(tiles, riverPath);
  const riverMap = buildRiverMap(riverPath, false);

  // Buildings — hero party starts on the west bank, the church waits on
  // the far east bank as the objective.
  setBuilding(tiles, 1, 4, BuildingType.INN, 1);          // west start
  setBuilding(tiles, 5, 3, BuildingType.HOUSE, 0);
  setBuilding(tiles, 7, 5, BuildingType.BLACKSMITH, 0);
  setBuilding(tiles, 14, 2, BuildingType.GRAVEYARD, 0);    // far side
  setBuilding(tiles, 15, 4, BuildingType.CHURCH, 1);       // far side — objective

  // MST roads — ensures bridges get placed crossing the river.
  const bldgs = [
    { col: 1, row: 4 }, { col: 5, row: 3 }, { col: 7, row: 5 },
    { col: 14, row: 2 }, { col: 15, row: 4 },
  ];
  buildRoadNetwork(tiles, bldgs, rand, 2);

  // Dense forest flanking the road, giving zombies cover to swarm the banks.
  growForests(tiles, [
    { col: 3, row: 1 }, { col: 6, row: 7 },
    { col: 4, row: 6 }, { col: 9, row: 1 },
    { col: 7, row: 7 }, { col: 2, row: 0 },
    { col: 10, row: 7 }, { col: 13, row: 7 },
    { col: 13, row: 0 },
  ], rand, 0.65, 0.35);

  // Dirt
  scatterDirt(tiles, 3, rand, COLS);

  // Resources — 4 herbs clustered around the church on the far bank
  // (the "healing stockpile" the survivor has been hoarding). A little
  // food and wood on the approach for the long crossing.
  setResource(tiles, 3, 5, ResourceType.FOOD);
  setResource(tiles, 7, 2, ResourceType.WOOD);
  setResource(tiles, 15, 3, ResourceType.HERBS);
  setResource(tiles, 15, 5, ResourceType.HERBS);
  setResource(tiles, 16, 3, ResourceType.HERBS);
  setResource(tiles, 16, 5, ResourceType.HERBS);
  // The survivor is holed up inside the church itself.
  setHiddenSurvivor(tiles, 15, 4);

  return {
    tiles,
    witchObjectives: [],
    heroStart:      { col: 1, row: 4 },
    witchStart:     { col: 15, row: 2 },
    mapSize:        'standard',   // action budget
    survivorCounts: { buildings: 1, terrain: 0 },
    cols: COLS,
    rows: ROWS,
    // reach_hex objective uses this (legacy / fallback display)
    targetHex: { col: 15, row: 4 },
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
    briefing: `You awaken at the Caleb's Hollow Inn to the sound of screaming. Shambling corpses stagger through the streets — but something worse stirs behind them, a crude thing of wood and bone answering to their blood. Cut down the dead and face what rises in their wake.`,
    victoryText: `The golem crumbles into splintered timber and dust. Silence returns to Caleb's Hollow's streets, but you sense this is only the beginning. A survivor stumbles from the wreckage — together, you may stand a chance against what's coming.`,
    defeatText:  `The dead overwhelm you. Caleb's Hollow falls before the fight even begins.`,

    // Daytime only — the opening mission takes place entirely in daylight.
    phaseCycle: {
      phases: ['dawn', 'day', 'day', 'day'],
      loop: true,
    },

    mapBuilder:      'prologue',
    mapSize:         'skirmish',

    hasWitch:        false,
    disableScoring:  true,
    enemyUnits: [
      { type: 'zombie', col: 3, row: 2, overrides: { attack: 1 } },
      { type: 'zombie', col: 6, row: 5, overrides: { attack: 1 } },
      { type: 'zombie', col: 4, row: 6, overrides: { attack: 1 } },
    ],
    waves: [
      {
        id: 'golem-awakens',
        trigger: 'hero_kills',
        count: 3,
        units: [{
          type: 'wood_golem',
          spawnAt: 'map_edge',
          overrides: { maxHp: 2, hp: 2, attack: 1, defense: 1 },
          spawnLog: '🗿 A crude wood-and-bone golem lurches out of the alley!',
        }],
      },
    ],
    aiPersonality: 'balanced',
    aiBudgetBonus: 0,

    maxSurvivorsFromRoster:    0,
    missionSurvivors:          1,
    maxDiscoverableSurvivors:  0,

    objectives: {
      win:  { type: 'eliminate_all', reason: "The golem shatters — Caleb's Hollow is silent again." },
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
    briefing: `The village is clear, but others may have survived. Smoke rises from distant buildings — signs of life, or something worse. Find at least two survivors and thin the pack of dead before dusk. If night falls while you still search alone, you will not see the dawn.`,
    victoryText: `The last zombie falls. You've gathered a small band of survivors — frightened but determined. Together you fortify what remains of Caleb's Hollow, knowing the true horror still lurks beyond the tree line.`,
    defeatText:  `You searched too far and too recklessly. The dead found you before you found help.`,

    // Six daytime turns (dawn + 5 day) then dusk on the seventh turn. The
    // mission resolves at dusk — win if two survivors are in hand, lose
    // otherwise.
    phaseCycle: {
      phases: ['dawn', 'day', 'day', 'day', 'day', 'day', 'dusk'],
      loop: false,
    },

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
      { round: 5, units: [{ type: 'zombie', spawnAt: 'map_edge' }, { type: 'zombie', spawnAt: 'map_edge' }] },
    ],
    aiPersonality: 'balanced',
    aiBudgetBonus: 1,

    maxSurvivorsFromRoster:    0,
    missionSurvivors:          2,
    maxDiscoverableSurvivors:  3,

    objectives: {
      win: {
        type: 'gather_and_survive',
        survivors: 2,
        kills: 4,
        phaseFallback: 'dusk',
        reason: 'The survivors are safe — Caleb\'s Hollow holds out another night.',
      },
      lose: [
        { type: 'hero_killed' },
        {
          type: 'phase_without_survivors',
          phase: 'dusk',
          survivors: 2,
          reason: 'Night fell before you found enough survivors.',
        },
      ],
    },

    startingResources: { food: 1, herbs: 1 },
    rewards:           { food: 2, herbs: 1, wood: 2 },
    healBonus:         2,

    storyTriggers: [
      { type: 'round', round: 1, title: 'Voices in the Fog',
        text: 'Through the morning haze you hear voices — desperate, frightened. Others survived the night. Find at least two of them and cut down the dead before dusk.',
        flag: 'gathering_intro' },
      { type: 'round', round: 6, title: 'The Light is Fading',
        text: 'Long shadows stretch across the square. This is the last of the daylight — when dusk falls you will be out of time. Hurry.',
        flag: 'gathering_last_day' },
      { type: 'area', hexes: [{ col: 4, row: 7 }], title: 'Sanctuary',
        text: 'The apothecary\'s door is barricaded from the inside. You call out and hear weeping — then the scrape of wood as the barricade is removed. A survivor emerges, pale but alive.',
        flag: 'found_apothecary' },
    ],

    requires: ['prologue'],
  },

  // ── Mission 3: The First Night ────────────────────────────────────────
  {
    id:       'first_night',
    title:    'The First Night',
    chapter:  1,
    briefing: `Dusk falls on Caleb's Hollow. You and your companions shelter in the old inn, church and house while waves of corpses claw their way from the graveyard and the tree line. Hold out until dawn — one dusk turn, five long nights, and the light returns.`,
    victoryText: `Dawn breaks. The wave subsides, leaving the village battered but standing. Among the rubble, a new ally emerges — another survivor drawn to your fight.`,
    defeatText:  `The dead breach your defenses. Caleb's Hollow is overrun.`,

    // One dusk turn, five nights, then dawn on round 7 — the victory
    // check fires as soon as dawn arrives.
    phaseCycle: {
      phases: ['dusk', 'night', 'night', 'night', 'night', 'night', 'dawn'],
      loop: false,
    },

    mapBuilder:      'first_night',
    mapSize:         'standard',

    hasWitch:        false,
    disableScoring:  true,
    enemyUnits: [
      { type: 'zombie', col: 10, row: 2 },
      { type: 'zombie', col: 11, row: 4 },
    ],
    // Enemies come in heavy and from multiple directions, pressing in
    // around the buildings where the party is holed up.
    waves: [
      { round: 1, units: [
        { type: 'zombie', spawnAt: 'graveyard' },
      ] },
      { round: 2, units: [
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'zombie', spawnAt: 'map_edge' },
      ] },
      { round: 3, units: [
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'minion', spawnAt: 'map_edge' },
      ] },
      { round: 4, units: [
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'minion', spawnAt: 'map_edge' },
        { type: 'minion', spawnAt: 'map_edge' },
      ] },
      { round: 5, units: [
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'zombie', spawnAt: 'map_edge' },
      ] },
      { round: 6, units: [
        { type: 'zombie', spawnAt: 'map_edge' },
      ] },
    ],
    aiPersonality: 'aggressive',
    aiBudgetBonus: 2,

    // Guarantee a full party of two companions at the start of the night.
    maxSurvivorsFromRoster:    2,
    missionSurvivors:          0,
    maxDiscoverableSurvivors:  0,
    minSurvivors:              2,
    // Place the hero's companions in nearby buildings (church + house)
    // instead of spilling them onto roads around the inn.
    survivorStartPositions: [
      { col: 3, row: 6 }, // church
      { col: 1, row: 6 }, // house
    ],

    objectives: {
      win: {
        type: 'survive_with_party',
        phase: 'dawn',
        survivors: 2,
        reason: 'You and your companions held out until dawn.',
      },
      lose: [
        { type: 'hero_killed' },
        {
          type: 'phase_without_survivors',
          phase: 'dawn',
          survivors: 2,
          reason: 'Dawn came too late — the village fell with you.',
        },
      ],
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
      { type: 'round', round: 4, title: 'The Witching Hour',
        text: 'The dead of night. The attacks intensify — they come from every side now, scratching at the walls and shutters. Hold the line. Dawn is still hours away.',
        flag: 'witching_hour' },
    ],

    requires: ['gathering_survivors'],
  },

  // ── Mission 4: The River Crossing ─────────────────────────────────────
  {
    id:       'river_crossing',
    title:    'The River Crossing',
    chapter:  1,
    briefing: `A survivor holed up in the old river church sends word: they have herbs and news of the witch, but the dead swarm the banks in daylight. You and your two companions must cut a path east, cross the bridges, and get every one of you inside the church. No one is left behind.`,
    victoryText: `The church doors close behind you and the last bar slams into place. Inside, the survivor hands you a bundle of bitter-smelling herbs and a scrap of a witch-mark. The trail is getting warmer.`,
    defeatText:  `The dead close the gap on the bridge. One of you does not make it. You retreat to the west bank with nothing but a warning.`,

    // Daylight only — the dead swarm the crossing but dusk never falls.
    phaseCycle: {
      phases: ['dawn', 'day', 'day', 'day'],
      loop: true,
    },

    mapBuilder:      'river_crossing',
    mapSize:         'standard',

    hasWitch:        false,
    disableScoring:  true,

    // Heavy opposition: zombies and minions swarming the banks, bridges and
    // forest flanks.
    enemyUnits: [
      { type: 'zombie', col: 5,  row: 6 },
      { type: 'zombie', col: 6,  row: 3 },
      { type: 'zombie', col: 8,  row: 4 },
      { type: 'zombie', col: 9,  row: 6 },
      { type: 'minion', col: 11, row: 3 },
      { type: 'minion', col: 12, row: 5 },
      { type: 'zombie', col: 13, row: 4 },
      { type: 'zombie', col: 14, row: 6 },
      { type: 'minion', col: 14, row: 3 },
    ],
    waves: [
      { round: 2, units: [
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'zombie', spawnAt: 'map_edge' },
      ] },
      { round: 4, units: [
        { type: 'zombie', spawnAt: 'graveyard' },
        { type: 'minion', spawnAt: 'map_edge' },
        { type: 'zombie', spawnAt: 'map_edge' },
      ] },
      { round: 6, units: [
        { type: 'minion', spawnAt: 'graveyard' },
        { type: 'zombie', spawnAt: 'map_edge' },
      ] },
      { round: 8, units: [
        { type: 'zombie', spawnAt: 'map_edge' },
        { type: 'minion', spawnAt: 'map_edge' },
      ] },
    ],
    aiPersonality: 'aggressive',
    aiBudgetBonus: 2,

    // Start with a full party of two companions. They die = mission failed.
    maxSurvivorsFromRoster:    2,
    minSurvivors:              2,
    missionSurvivors:          1,
    maxDiscoverableSurvivors:  1,
    survivorStartPositions: [
      { col: 2, row: 4 }, // just east of the inn
      { col: 1, row: 5 }, // south of the inn
    ],

    objectives: {
      win: {
        type: 'all_party_at_hexes',
        // Church + immediate neighbors on the far bank. Every living party
        // member (hero + survivors) must be standing on one of these hexes.
        hexes: [
          { col: 15, row: 4 }, // church
          { col: 14, row: 4 },
          { col: 16, row: 4 },
          { col: 15, row: 3 },
          { col: 15, row: 5 },
        ],
        reason: 'You and your companions reached the river church together.',
      },
      lose: [
        { type: 'hero_killed' },
        { type: 'survivors_below', count: 2,
          reason: 'A companion fell — the party is broken.' },
        { type: 'rounds_exceeded', rounds: 15,
          reason: 'Reinforcements arrived. The crossing is lost.' },
      ],
    },

    startingResources: { food: 2, wood: 1 },
    rewards:           { metal: 2, wood: 1, herbs: 1 },
    healBonus:         3,

    // Horses never appear on this mission — the swamp-river terrain and
    // swarming dead make riding a non-starter.
    lootOverrides: { remove: ['horse'] },

    storyTriggers: [
      { type: 'round', round: 1, title: 'The Long Road',
        text: 'A narrow trail leads east through dense forest. The river glints in the distance — your only way forward. The dead have been here, and there are many of them. Stay close — no one is left behind on this road.',
        flag: 'river_start' },
      { type: 'area', hexes: [{ col: 10, row: 3 }, { col: 10, row: 4 }, { col: 10, row: 5 }, { col: 11, row: 4 }], title: 'The Crossing',
        text: 'The bridge is ancient, its timbers groaning under your weight. On the far bank, shadows move between the trees. You grip your weapon tighter and step forward — together.',
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
    aiBudgetBonus: 3,

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
    aiBudgetBonus: 2,

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
  title:       'Chapter 1 - Welcome to Caleb\'s Hollow',
  description: 'A cursed village, the walking dead, and a witch pulling the strings. Six missions stand between Caleb\'s Hollow and oblivion.',
  missions:    MISSIONS,
  mapBuilders: MAP_BUILDERS,
  firstMission: 'prologue',
  prerequisiteCampaign: null,
};
