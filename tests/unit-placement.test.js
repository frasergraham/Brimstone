// Unit-placement validity — a freshly-spawned unit must never land on
// impassable terrain.
//
// Bug (June 2026): a Survivor spawned by a hero holding a power node could be
// placed on a building's impassable footprint hex, because the node-survivor
// spawner only rejected rivers and occupied hexes — not building walls. The
// fix routes every fresh-spawn seam through the shared `isPlaceableTile`
// validator in `src/factions.js`.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { getFaction, isPlaceableTile } from '../src/factions.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { isBuildingFootprint, isRiver, isBuildingTile } from '../src/tiles.js';

// Force Math.random to a fixed value for the duration of `fn` so the
// probabilistic node spawn (33% chance) deterministically fires.
function withRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try { return fn(); } finally { Math.random = orig; }
}

function logText(entry) {
  return typeof entry === 'string' ? entry : entry.text;
}

// Mark every hex the spawner could consider — the cluster's satellite hexes and
// all their neighbours — as an impassable building footprint, except the hero's
// own hex (which is excluded by occupancy anyway). After this, no passable,
// unoccupied spawn hex remains around the node.
function wallOffNode(state, obj, keepHexKey) {
  const targets = new Set();
  for (const clusterHex of obj.hexes) {
    targets.add(hexKey(clusterHex.col, clusterHex.row));
    for (const n of getNeighbors(clusterHex.col, clusterHex.row)) {
      targets.add(hexKey(n.col, n.row));
    }
  }
  targets.delete(keepHexKey);
  for (const k of targets) {
    const t = state.tiles.get(k);
    if (t) t.buildingFootprintOf = keepHexKey;
  }
}

describe('node-survivor spawning never lands on impassable terrain', () => {
  test('all node neighbours impassable → no survivor placed on a wall, fails loudly', () => {
    const state = new GameState(true, true, 'standard');
    const obj = state.witchObjectives[0];
    const center = obj.hexes[0];

    // Hero leader stands on the node; it is night (the spawn trigger).
    state.hero.col = center.col;
    state.hero.row = center.row;
    state.phase = Phase.NIGHT;

    wallOffNode(state, obj, hexKey(center.col, center.row));

    const survivorsBefore = state.entities.filter(
      e => e.alive && e.type === EntityType.SURVIVOR
    ).length;
    const logLenBefore = state.log.length;

    withRandom(0, () => getFaction('hero')._applyNodeSurvivorSpawning(state));

    // No unit may sit on an impassable footprint hex.
    for (const e of state.entities) {
      if (!e.alive) continue;
      const t = state.tiles.get(hexKey(e.col, e.row));
      assert.ok(!isBuildingFootprint(t),
        `entity ${e.type} ended up on an impassable footprint at ${e.col},${e.row}`);
    }

    // Nothing was spawned, and the spawner logged that it could not.
    const survivorsAfter = state.entities.filter(
      e => e.alive && e.type === EntityType.SURVIVOR
    ).length;
    assert.equal(survivorsAfter, survivorsBefore, 'no survivor should spawn when no tile is passable');
    assert.equal(state.nodeSpawnedSurvivors.length, 0, 'no spawn descriptor emitted');

    const newLogs = state.log.slice(logLenBefore).map(logText);
    assert.ok(newLogs.some(t => /no safe ground/i.test(t)),
      'spawner should log that there was no safe ground');
  });

  test('a passable neighbour exists → survivor spawns on a placeable tile', () => {
    const state = new GameState(true, true, 'standard');
    const obj = state.witchObjectives[0];
    const center = obj.hexes[0];

    state.hero.col = center.col;
    state.hero.row = center.row;
    state.phase = Phase.NIGHT;

    // Sanity: the node must actually have at least one placeable neighbour so
    // the happy path is exercised (standard maps place nodes on open ground).
    const placeableNeighbours = obj.hexes.flatMap(h => getNeighbors(h.col, h.row))
      .filter(n => isPlaceableTile(state, n.col, n.row, 'hero'));
    assert.ok(placeableNeighbours.length > 0, 'node should have a placeable neighbour');

    withRandom(0, () => getFaction('hero')._applyNodeSurvivorSpawning(state));

    assert.equal(state.nodeSpawnedSurvivors.length, 1, 'one survivor should spawn');
    const spawned = state.entities.find(e => e.id === state.nodeSpawnedSurvivors[0].id);
    assert.ok(spawned, 'spawned survivor exists in entity list');
    const t = state.tiles.get(hexKey(spawned.col, spawned.row));
    assert.ok(!isBuildingTile(t) && !isRiver(t),
      'survivor must spawn on passable, non-building terrain');
  });
});

describe('isPlaceableTile validator', () => {
  // A fresh standard state gives us real, fully-populated tiles to mutate.
  function freshState() {
    return new GameState(true, true, 'standard');
  }

  // An open grass tile with no special path/structure — guaranteed passable.
  function openTile(state) {
    for (const [, t] of state.tiles) {
      if (!isRiver(t) && !isBuildingTile(t) && (t.fortifyLevel || 0) === 0) {
        const occupied = state.entities.some(e => e.alive && e.col === t.col && e.row === t.row);
        if (!occupied) return t;
      }
    }
    return null;
  }

  test('accepts an open, unoccupied tile', () => {
    const state = freshState();
    const t = openTile(state);
    assert.ok(t, 'standard map should have an open tile');
    assert.equal(isPlaceableTile(state, t.col, t.row, 'hero'), true);
  });

  test('rejects an off-map hex', () => {
    const state = freshState();
    assert.equal(isPlaceableTile(state, -1, -1, 'hero'), false);
  });

  test('rejects a river hex', () => {
    const state = freshState();
    const river = [...state.tiles.values()].find(t => isRiver(t));
    if (!river) return; // some seeds have no river-adjacent open node; skip
    assert.equal(isPlaceableTile(state, river.col, river.row, 'hero'), false);
  });

  test('rejects a building footprint (impassable wall)', () => {
    const state = freshState();
    const t = openTile(state);
    t.buildingFootprintOf = hexKey(t.col + 1, t.row); // make it a footprint
    assert.equal(isBuildingFootprint(t), true);
    assert.equal(isPlaceableTile(state, t.col, t.row, 'hero'), false);
  });

  test('rejects a building entrance tile too', () => {
    const state = freshState();
    const entrance = [...state.tiles.values()].find(t => isBuildingTile(t) && !isBuildingFootprint(t));
    if (!entrance) return;
    assert.equal(isPlaceableTile(state, entrance.col, entrance.row, 'hero'), false);
  });

  test('rejects a fort wall for a wall-blocked faction but not for the hero', () => {
    const state = freshState();
    const t = openTile(state);
    t.fortifyLevel = 3; // level 2+ is an impassable wall
    // Witch-side factions are blocked by walls; hero-side are not.
    assert.equal(isPlaceableTile(state, t.col, t.row, 'witch'), false);
    assert.equal(isPlaceableTile(state, t.col, t.row, 'hero'), true);
  });

  test('rejects a tile with no remaining capacity', () => {
    const state = freshState();
    const t = openTile(state);
    // Saturate the tile with units until it is full.
    let guard = 0;
    while (isPlaceableTile(state, t.col, t.row, 'hero') && guard++ < 20) {
      state.entities.push({ id: `f${guard}`, owner: 'hero', type: EntityType.SURVIVOR, col: t.col, row: t.row, alive: true });
    }
    assert.equal(isPlaceableTile(state, t.col, t.row, 'hero'), false, 'a full tile is not placeable');
  });
});
