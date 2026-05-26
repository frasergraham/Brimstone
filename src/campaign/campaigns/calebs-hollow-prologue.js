// ═══════════════════════════════════════════════════════════════════════════
// Campaign: The Caleb's Hollow Prologue
// A 7-mission introductory arc set in cursed colonial Caleb's Hollow.
// ═══════════════════════════════════════════════════════════════════════════

import { Tile, TileType, BuildingType, ResourceType } from '../../tiles.js';
import { hexKey, setMapDimensions, getNeighbors } from '../../hex.js';
import {
  NODE_COLORS, rng, shuffle, generateRiverNS, generateRiverEW,
  buildRiverMap, riverSide,
} from '../../map.js';
import { buildRoadNetwork } from '../../road-network.js';
import { countHeldNodes } from '../../game.js';

// True when at least one Power Node is not currently hero-controlled.
// Used by The Long Watch's reminder story triggers — they should fire only
// while the hero hasn't yet completed the watch.
const notHoldingAllNodes = (state) =>
  countHeldNodes('hero', state.witchObjectives, state.entities)
    !== state.witchObjectives.length;

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

// MST road network (Kruskal MST → BFS roads → RIVER→BRIDGE up to a cap) is
// shared with the procedural generator — see `buildRoadNetwork` in
// src/road-network.js.

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

  // No power nodes — survival mission, not a node contest.
  const witchObjectives = [];

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

  // No river — deep forest. One landmark building only: the hero's starting
  // shelter on the south edge.
  setBuilding(tiles, 1, 10, BuildingType.HOUSE, 0);

  // Dense forest blankets most of the map. No road network.
  growForests(tiles, [
    // North band
    { col: 1, row: 1 }, { col: 4, row: 1 }, { col: 8, row: 1 }, { col: 11, row: 1 },
    // Mid-upper band (around the first clearing)
    { col: 2, row: 3 }, { col: 8, row: 3 }, { col: 11, row: 3 },
    // Middle band (between clearings)
    { col: 0, row: 5 }, { col: 2, row: 6 }, { col: 6, row: 5 }, { col: 7, row: 7 },
    { col: 11, row: 5 },
    // Lower band (around the second clearing)
    { col: 3, row: 7 }, { col: 8, row: 8 }, { col: 11, row: 8 },
    // South band
    { col: 0, row: 11 }, { col: 5, row: 11 }, { col: 9, row: 10 }, { col: 12, row: 11 },
  ], rand, 0.85, 0.55);

  // Carve three clearings: hero start, Ritual Circle, Dark Altar.
  const clearings = [
    { col: 1, row: 10 }, { col: 2, row: 10 }, // hero start clearing
    { col: 5, row: 4 }, { col: 4, row: 3 }, { col: 5, row: 3 }, { col: 4, row: 4 }, { col: 6, row: 4 }, { col: 5, row: 5 }, // Ritual Circle
    { col: 9, row: 6 }, { col: 10, row: 6 }, { col: 9, row: 5 }, { col: 8, row: 6 }, { col: 9, row: 7 }, // Dark Altar
  ];
  for (const { col, row } of clearings) {
    const t = tiles.get(hexKey(col, row));
    if (t && t.type === TileType.FOREST) t.type = TileType.GRASS;
  }

  // Old game-trail roads connecting hero shelter to both clearings — gives
  // the hero a viable approach through dense forest before dawn.
  buildRoadNetwork(tiles, [
    { col: 1, row: 10 },   // hero shelter
    { col: 5, row: 4 },    // Ritual Circle
    { col: 9, row: 6 },    // Dark Altar
  ], rand, 0);

  // Dirt scatter for visual texture.
  scatterDirt(tiles, 3, rand, COLS);

  // Resources — one herbs cache in each node clearing so the hero has a
  // reason to push through.
  setResource(tiles, 4, 4, ResourceType.HERBS);
  setResource(tiles, 10, 6, ResourceType.HERBS);

  // Two power nodes — visible to the hero from turn 1 so the objective is
  // obvious.
  const witchObjectives = [
    {
      col: 5, row: 4,
      label: 'Ritual Circle',
      hexes: [{ col: 5, row: 4 }, { col: 4, row: 3 }, { col: 5, row: 3 }],
      color: NODE_COLORS[0],
      seenByHero: true,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
    {
      col: 9, row: 6,
      label: 'Dark Altar',
      hexes: [{ col: 9, row: 6 }, { col: 10, row: 6 }, { col: 9, row: 5 }],
      color: NODE_COLORS[1],
      seenByHero: true,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 2, row: 10 },
    // Witch stands at the second clearing (Dark Altar) at game start —
    // her flee from this spot is the mission's pivotal beat.
    witchStart:     { col: 9, row: 6 },
    mapSize:        'standard',
    survivorCounts: { buildings: 0, terrain: 0 },
    cols: COLS,
    rows: ROWS,
  };
}

function buildLongWatchMap() {
  const COLS = 13, ROWS = 13;
  setMapDimensions(COLS, ROWS);
  const rand = rng(314);
  const tiles = makeTiles(COLS, ROWS);

  // River (E-W) splits the town into two halves so the hero must cross
  // bridges to reach distant nodes.
  const riverPath = generateRiverEW(rand);
  carveRiver(tiles, riverPath);

  // Town buildings spread across both river halves.
  setBuilding(tiles, 1, 10, BuildingType.INN, 1);          // hero start
  setBuilding(tiles, 3, 10, BuildingType.HOUSE, 0);
  setBuilding(tiles, 2, 8,  BuildingType.STABLE, 0);
  setBuilding(tiles, 5, 9,  BuildingType.CHURCH, 0);
  setBuilding(tiles, 9, 10, BuildingType.HOUSE, 0);
  setBuilding(tiles, 11, 8, BuildingType.WATCHTOWER, 0);
  setBuilding(tiles, 8, 2,  BuildingType.GRAVEYARD, 1);    // witch fodder
  setBuilding(tiles, 11, 3, BuildingType.HOUSE, 0);

  // Roads + bridges through the town.
  const bldgs = [
    { col: 1,  row: 10 }, { col: 3, row: 10 }, { col: 2, row: 8 },
    { col: 5,  row: 9  }, { col: 9, row: 10 }, { col: 11, row: 8 },
    { col: 8,  row: 2  }, { col: 11, row: 3 },
  ];
  buildRoadNetwork(tiles, bldgs, rand, 2);

  // Light forest around the edges so the witch has cover to flee into.
  growForests(tiles, [
    { col: 0, row: 1 }, { col: 12, row: 1 },
    { col: 6, row: 4 }, { col: 4, row: 6 },
    { col: 10, row: 6 }, { col: 0, row: 11 }, { col: 12, row: 11 },
  ], rand, 0.6, 0.4);

  scatterDirt(tiles, 4, rand, COLS);

  // Resources distributed so each node area has loot worth holding.
  setResource(tiles, 6, 11, ResourceType.WOOD);
  setResource(tiles, 10, 4, ResourceType.METAL);
  setResource(tiles, 4, 2,  ResourceType.HERBS);
  setResource(tiles, 1, 5,  ResourceType.SILVER);

  // Three Power Nodes — town square, north plaza, east terrace.
  const witchObjectives = [
    {
      col: 6, row: 9,
      label: 'Town Square',
      hexes: [{ col: 6, row: 9 }, { col: 5, row: 9 }, { col: 6, row: 10 }],
      color: NODE_COLORS[0],
      seenByHero: true,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
    {
      col: 7, row: 2,
      label: 'North Plaza',
      hexes: [{ col: 7, row: 2 }, { col: 8, row: 2 }, { col: 7, row: 3 }],
      color: NODE_COLORS[1],
      seenByHero: true,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
    {
      col: 11, row: 6,
      label: 'East Terrace',
      hexes: [{ col: 11, row: 6 }, { col: 11, row: 5 }, { col: 10, row: 5 }],
      color: NODE_COLORS[2],
      seenByHero: true,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
  ];

  return {
    tiles,
    witchObjectives,
    heroStart:      { col: 1, row: 10 },
    witchStart:     { col: 11, row: 1 }, // far corner — she keeps her distance
    mapSize:        'standard',
    survivorCounts: { buildings: 0, terrain: 0 },
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
      hexes: [{ col: 5, row: 5 }, { col: 5, row: 4 }, { col: 6, row: 4 }],
      color: NODE_COLORS[0],
      seenByHero: false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
    {
      col: 9, row: 6,
      label: 'Dark Hollow',
      hexes: [{ col: 9, row: 6 }, { col: 8, row: 6 }, { col: 8, row: 5 }],
      color: NODE_COLORS[1],
      seenByHero: false,
      seenByWitch: true,
      prevCtrl: 'neutral',
    },
    // Third node — needed so the witch must hold a "majority" (≥2 of 3)
    // to score under the night-extension scoring rules.
    {
      col: 7, row: 9,
      label: 'Black Cairn',
      hexes: [{ col: 7, row: 9 }, { col: 6, row: 9 }, { col: 7, row: 10 }],
      color: NODE_COLORS[2],
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
  long_watch:           buildLongWatchMap,
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
          spawnAt: 'near_hero',
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
    // Pre-placed enemies are ALREADY on the town's doorstep at mission start,
    // including two minions so the first night isn't just a zombie warm-up.
    enemyUnits: [
      { type: 'minion', col: 5, row: 7 },   // right next to the blacksmith
      { type: 'minion', col: 3, row: 5 },   // between apothecary and church
      { type: 'zombie', col: 6, row: 5 },   // east of the watchtower
      { type: 'zombie', col: 0, row: 7 },   // west of the house
      { type: 'zombie', col: 10, row: 2 },  // distant graveyard shambler
      { type: 'zombie', col: 11, row: 4 },  // distant graveyard shambler
    ],
    // Every round spawns a wave adjacent to town — and a minion arrives from
    // the very first night. Pressure escalates through the cycle.
    waves: [
      // Round 1 (dusk): two scouts arrive from north and south.
      { round: 1, units: [
        { type: 'zombie', spawnAt: { col: 1, row: 4 } },
        { type: 'zombie', spawnAt: { col: 4, row: 9 } },
      ] },
      // Round 2 (NIGHT 1): first real assault — minion + three zombies.
      { round: 2, units: [
        { type: 'minion', spawnAt: { col: 0, row: 7 } },
        { type: 'zombie', spawnAt: { col: 1, row: 4 } },
        { type: 'zombie', spawnAt: { col: 5, row: 4 } },
        { type: 'zombie', spawnAt: { col: 5, row: 7 } },
      ] },
      // Round 3 (night 2): western push, second minion.
      { round: 3, units: [
        { type: 'minion', spawnAt: { col: 3, row: 5 } },
        { type: 'zombie', spawnAt: { col: 0, row: 6 } },
        { type: 'zombie', spawnAt: { col: 0, row: 8 } },
        { type: 'zombie', spawnAt: { col: 4, row: 9 } },
      ] },
      // Round 4 (night 3): eastern push, two minions.
      { round: 4, units: [
        { type: 'minion', spawnAt: { col: 5, row: 6 } },
        { type: 'minion', spawnAt: { col: 5, row: 7 } },
        { type: 'zombie', spawnAt: { col: 6, row: 5 } },
        { type: 'zombie', spawnAt: { col: 6, row: 9 } },
      ] },
      // Round 5 (night 4): heaviest — all directions, two minions.
      { round: 5, units: [
        { type: 'minion', spawnAt: { col: 5, row: 4 } },
        { type: 'minion', spawnAt: { col: 6, row: 5 } },
        { type: 'zombie', spawnAt: { col: 1, row: 4 } },
        { type: 'zombie', spawnAt: { col: 0, row: 7 } },
        { type: 'zombie', spawnAt: { col: 4, row: 9 } },
      ] },
      // Round 6 (night 5): final desperate push before dawn.
      { round: 6, units: [
        { type: 'minion', spawnAt: { col: 4, row: 8 } },
        { type: 'minion', spawnAt: { col: 5, row: 7 } },
        { type: 'zombie', spawnAt: { col: 0, row: 8 } },
        { type: 'zombie', spawnAt: { col: 6, row: 5 } },
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
    briefing: `Deep in the forest the trees themselves hum with dark energy. Two Power Nodes pulse in clearings ahead; her thralls stand thick around them. Drive every last one of her forces off both nodes before dawn — or the ritual tips past recovery.`,
    victoryText: `Dawn breaks. The nodes dim and the forest exhales. Her ritual dies in the dark between the trees.`,
    defeatText:  `Dawn breaks on a grove still choked with shadow. The ritual holds; her power only grows.`,

    mapBuilder:      'dark_ritual',
    mapSize:         'standard',

    hasWitch:        true,     // witch holds the Dark Altar — flees on contact
    disableScoring:  true,     // we run our own win check, not dawn/dusk scoring

    // 11 rounds: start in daytime, end on dawn.
    // 3 day → 1 dusk → 6 night → 1 dawn.
    phaseCycle: {
      phases: ['day','day','day','dusk','night','night','night','night','night','night','dawn'],
      loop:   false,
    },

    enemyUnits: [
      // Garrison on the first clearing (Ritual Circle at 5,4) — 2 minions + 1 golem.
      { type: 'minion',     col: 4, row: 3 },
      { type: 'minion',     col: 5, row: 3 },
      { type: 'wood_golem', col: 5, row: 4 },
      // Garrison on the second clearing (Dark Altar at 9,6) — 2 minions + 1 golem.
      { type: 'minion',     col: 10, row: 6 },
      { type: 'minion',     col: 9, row: 5 },
      { type: 'wood_golem', col: 9, row: 6 },
    ],
    waves: [
      // Reinforcements — keep pressure on from the far edges.
      { round: 4, units: [
        { type: 'minion', spawnAt: 'map_edge' },
        { type: 'minion', spawnAt: 'map_edge' },
      ] },
      { round: 7, units: [{ type: 'minion', spawnAt: 'map_edge' }] },
      // Second-clearing ambush — the witch flees, leaves golems behind.
      {
        id: 'witch-flees',
        trigger: 'area',
        hexes: [
          { col: 9, row: 6 }, { col: 10, row: 6 }, { col: 9, row: 5 },
          { col: 8, row: 6 }, { col: 9, row: 7 }, { col: 10, row: 5 },
        ],
        units: [
          { type: 'wood_golem', spawnAt: { col: 11, row: 6 },
            spawnLog: '🗿 A wood golem crashes out of the thicket to cover her escape!' },
          { type: 'wood_golem', spawnAt: { col: 9, row: 8 },
            spawnLog: '🗿 Another golem lurches between you and the altar!' },
          { type: 'wood_golem', spawnAt: { col: 10, row: 4 },
            spawnLog: '🗿 A third golem blocks the path she took into the shadows!' },
        ],
      },
    ],
    // Evasive — she moves away from the hero rather than fighting; she'll
    // also summon sparingly so the witch_flees wave carries the threat.
    aiPersonality: 'evasive',
    // Hero AI override — consumed ONLY by scripts/headless-campaign.js for
    // AI playtesting. The real campaign UI has a human at the controls, so
    // src/main.js ignores this field. Headless rush-to-clear-every-node bias.
    heroPersonality: 'node_denier',
    aiBudgetBonus: 1,

    maxSurvivorsFromRoster:    3,
    missionSurvivors:          0,
    minSurvivors:              1,
    maxDiscoverableSurvivors:  0,

    objectives: {
      win:  { type: 'witch_denied_nodes', phase: 'dawn',
              reason: 'Dawn breaks — the nodes are free of her grasp.' },
      lose: [
        { type: 'hero_killed' },
        { type: 'witch_holds_node', phase: 'dawn',
          reason: 'Dawn breaks — the witch still holds a node. The ritual completes.' },
      ],
    },

    startingResources: { metal: 1, food: 2 },
    rewards:           { silver: 1, scripture: 1, metal: 1 },
    healBonus:         4,

    lootOverrides: { remove: ['horse'] },

    storyTriggers: [
      { type: 'round', round: 1, title: 'Into the Grove',
        text: 'Two clearings ahead pulse with purple light. Her garrison is thick around both. Dawn is all that stands between the ritual and its climax — you must drive her forces off both nodes before the sun returns.',
        flag: 'dark_ritual_start' },
      { type: 'area',
        hexes: [
          { col: 9, row: 6 }, { col: 10, row: 6 }, { col: 9, row: 5 },
          { col: 8, row: 6 }, { col: 9, row: 7 }, { col: 10, row: 5 },
        ],
        title: 'The Witch Flees',
        text: 'At the second clearing you meet her eyes across the altar. For a heartbeat she stares — then she melts into the dark, leaving her golems to choke your path. Finish them. Finish the ritual.',
        flag: 'witch_flees' },
    ],

    requires: ['river_crossing'],
  },

  // ── Mission 6: The Long Watch ─────────────────────────────────────────
  {
    id:       'long_watch',
    title:    'The Long Watch',
    chapter:  1,
    briefing: `The nights are growing longer. Three Power Nodes pulse through Caleb's Hollow — seize them all and hold them until dawn. The witch herself walks the streets, but she keeps her distance; her thralls are the real threat.`,
    victoryText: `Dawn breaks. Every node bears your mark. The town breathes again — for one more day.`,
    defeatText:  `Dawn breaks on a town still in her grip. The watch is broken; her ritual feeds another night.`,

    mapBuilder:      'long_watch',
    mapSize:         'standard',

    hasWitch:        true,
    disableScoring:  true,    // win is the dawn snapshot, not point accumulation

    // Long night: 1 day → 1 dusk → 7 night → 1 dawn = 10 rounds.
    phaseCycle: {
      phases: ['day','dusk','night','night','night','night','night','night','night','dawn'],
      loop:   false,
    },

    enemyUnits: [
      // Light minion presence on/near each node so the hero must clear before holding.
      { type: 'minion', col: 6, row: 9 },        // Town Square
      { type: 'minion', col: 7, row: 2 },        // North Plaza
      { type: 'minion', col: 11, row: 6 },       // East Terrace
      { type: 'minion', col: 8, row: 3 },        // patrol near North Plaza
      { type: 'wood_golem', col: 10, row: 5 },   // anchors the East Terrace
    ],
    waves: [
      { round: 4, units: [{ type: 'minion', spawnAt: 'graveyard' }] },
      { round: 6, units: [
        { type: 'minion', spawnAt: 'graveyard' },
      ] },
      { round: 8, units: [
        { type: 'minion', spawnAt: 'map_edge' },
        { type: 'minion', spawnAt: 'graveyard' },
      ] },
    ],
    aiPersonality: 'evasive',
    // Hero AI override — headless-only (see scripts/headless-campaign.js).
    // Real campaign play uses the human; src/main.js ignores this field.
    heroPersonality: 'node_denier',
    aiBudgetBonus: 0,

    maxSurvivorsFromRoster: 5,
    missionSurvivors:       1,
    minSurvivors:           2,
    maxSurvivors:           5,

    objectives: {
      win:  { type: 'hero_holds_all_nodes', phase: 'dawn',
              reason: 'You hold every node at dawn — the watch holds.' },
      lose: [
        { type: 'hero_killed' },
        // Anything less than full hero control at dawn = lose.
        { type: 'witch_holds_node', phase: 'dawn',
          reason: 'Dawn — and the nodes are not yours.' },
      ],
    },

    startingResources: { wood: 1, food: 2 },
    rewards:           { silver: 1, scripture: 1, food: 2 },
    healBonus:         5,

    storyTriggers: [
      { type: 'round', round: 1, title: 'The Long Watch',
        text: 'Three Power Nodes. One night. Hold them all when the sun returns.',
        flag: 'long_watch_start' },
      // Reminders fire only if the hero has not yet seized every node.
      { type: 'round', round: 4, condition: notHoldingAllNodes,
        title: 'The Hour Wears On',
        text: 'A node still pulses without your banner. Seize them all before dawn.',
        flag: 'long_watch_remind_4' },
      { type: 'round', round: 7, condition: notHoldingAllNodes,
        title: 'Dawn Approaches',
        text: 'Dawn nears, and the watch is incomplete. The nodes must be yours.',
        flag: 'long_watch_remind_7' },
    ],

    requires: ['dark_ritual'],
  },

  // ── Mission 7: The Witch's Trail ──────────────────────────────────────
  {
    id:       'witchs_trail',
    title:    'The Witch\'s Trail',
    chapter:  1,
    briefing: `She is here, and her ritual feeds on the night itself. Three Power Nodes pulse in the heart of town — every time she holds the majority of them, the night grows longer. The dawn will not come on its own. Strike her down before the sun forgets to rise.`,
    victoryText: `The witch screams and dissolves into shadow. The Power Nodes dim and dawn's first light slips through the trees. The night is over — for now.`,
    defeatText:  `The night does not end. Her ritual is complete; the dawn forgets Caleb's Hollow.`,

    mapBuilder:      'witchs_trail',
    mapSize:         'standard',

    hasWitch:         true,
    disableScoring:   false,  // multiplayer-style scoring drives the loss condition
    disableNodeSweep: true,   // points only — sweeping nodes does not instantly win/lose
    disableScoreWin:  true,   // engine's built-in "first to N points wins" off — our witch_score_threshold lose drives it

    // 1 day → 1 dusk → 3 night, then phase clamps to NIGHT.  Each witch
    // score also appends another 'night' (visible cycle growth).
    phaseCycle: {
      phases: ['day','dusk','night','night','night'],
      loop:   false,
      extraScoringPhases: ['night'],   // score every NIGHT turn she holds majority
      extendOnWitchScore: ['night'],   // each witch point lengthens the night
    },

    enemyUnits: [
      // Garrison spread across the three nodes — one minion each, plus
      // a single bodyguard golem near the witch.
      { type: 'minion',     col: 5, row: 5 },     // Forest Shrine
      { type: 'minion',     col: 9, row: 6 },     // Dark Hollow
      { type: 'minion',     col: 7, row: 9 },     // Black Cairn
      { type: 'minion',     col: 6, row: 9 },
      { type: 'wood_golem', col: 10, row: 3 },    // witch's bodyguard
      { type: 'wood_golem', col: 9, row: 5 },
    ],
    waves: [
      { round: 3, units: [{ type: 'minion', spawnAt: 'graveyard' }] },
      { round: 5, units: [
        { type: 'minion',     spawnAt: 'graveyard' },
        { type: 'wood_golem', spawnAt: 'graveyard' },
      ] },
      { round: 7, units: [{ type: 'minion', spawnAt: 'map_edge' }] },
    ],
    aiPersonality: 'aggressive',  // she's holding the nodes, not fleeing
    // Hero AI override — headless-only (see scripts/headless-campaign.js).
    // Real campaign play uses the human; src/main.js ignores this field.
    heroPersonality: 'witch_hunter',
    aiBudgetBonus: 1,

    maxSurvivorsFromRoster: 5,
    missionSurvivors:       1,
    minSurvivors:           2,
    maxSurvivors:           5,

    objectives: {
      win:  { type: 'slay_witch', reason: 'The witch dies before the ritual completes.' },
      lose: [
        { type: 'hero_killed' },
        { type: 'witch_score_threshold', points: 5,
          reason: 'The ritual is complete — the night will never end.' },
      ],
    },

    startingResources: { silver: 1 },
    rewards:           { metal: 2, silver: 1, scripture: 1 },
    healBonus:         4,

    storyTriggers: [
      { type: 'round', round: 1, title: 'No Dawn Until It\'s Done',
        text: 'She is here, and her ritual feeds on the night. Each time she holds the majority of nodes, the night grows longer. Strike her down before the sun forgets to rise.',
        flag: 'witchs_trail_intro' },
      { type: 'round', round: 4, title: 'The Night Deepens',
        text: 'Shadows thicken. The dawn you were counting on is no longer coming on its own.',
        flag: 'witchs_trail_remind' },
    ],

    requires: ['long_watch'],
  },
];

// ── Campaign definition ────────────────────────────────────────────────────

export default {
  id:          'calebs_hollow_prologue',
  title:       'Chapter 1 - Welcome to Caleb\'s Hollow',
  description: 'A cursed village, the walking dead, and a witch pulling the strings. Seven missions stand between Caleb\'s Hollow and oblivion.',
  missions:    MISSIONS,
  mapBuilders: MAP_BUILDERS,
  firstMission: 'prologue',
  prerequisiteCampaign: null,
};
