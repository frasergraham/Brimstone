// Hex capacity (slot model): TILE_CAPACITY = 7; each building, tree, or
// unit consumes slots; a full hex blocks movement INTO it (and through it).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import {
  TileType, BuildingType, Tile,
  TILE_CAPACITY, BUILDING_SLOT_COST, TREE_SLOT_COST,
  treeCountForTile, tileOccupancyCount, tileCapacityRemaining,
  decomposeTileType,
} from '../src/tiles.js';
import { getReachableHexes, executeMove, isTileFullForMove } from '../src/actions.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { stepToward } from '../src/ai.js';
import { createMinion, createSurvivor } from '../src/entities.js';

function freshState() {
  return new GameState(true, true);
}

// Force a tile to a specific type/base.
function setTile(state, col, row, type) {
  const t = state.tiles.get(hexKey(col, row));
  decomposeTileType(t, type);
  return t;
}

describe('tile capacity helpers', () => {
  test('empty grass hex → TILE_CAPACITY (7) remaining', () => {
    const t = new Tile(0, 0, TileType.GRASS);
    assert.equal(tileOccupancyCount(t), 0);
    assert.equal(tileCapacityRemaining(t, 0), TILE_CAPACITY);
    assert.equal(tileCapacityRemaining(t, []), TILE_CAPACITY);
  });

  test('forest hex consumes treeCountForTile slots (3-5 raw → 2-3 scaled)', () => {
    const t = new Tile(3, 4, TileType.FOREST);
    const n = treeCountForTile(t);
    assert.ok(n >= 2 && n <= 3,
      `expected 2-3 trees after density scaling, got ${n}`);
    assert.equal(tileOccupancyCount(t), n * TREE_SLOT_COST);
    assert.equal(tileCapacityRemaining(t, 0), TILE_CAPACITY - n);
  });

  test('building hex consumes BUILDING_SLOT_COST (3) → 4 remaining', () => {
    const t = new Tile(0, 0, TileType.BUILDING);
    t.building = BuildingType.INN;
    assert.equal(tileOccupancyCount(t), BUILDING_SLOT_COST);
    assert.equal(tileCapacityRemaining(t, 0), TILE_CAPACITY - BUILDING_SLOT_COST);
    assert.equal(tileCapacityRemaining(t, 0), 4);
  });

  test('building tile with 4 units → 0 remaining (full)', () => {
    const t = new Tile(0, 0, TileType.BUILDING);
    t.building = BuildingType.INN;
    assert.equal(tileCapacityRemaining(t, 4), 0);
    assert.ok(tileCapacityRemaining(t, 5) < 0, 'over-capacity is reported as negative');
  });

  test('non-forest tile → 0 trees', () => {
    assert.equal(treeCountForTile(new Tile(0, 0, TileType.GRASS)), 0);
    assert.equal(treeCountForTile(new Tile(0, 0, TileType.DIRT)),  0);
    assert.equal(treeCountForTile(new Tile(0, 0, TileType.ROAD)),  0);
  });

  test('treeCountForTile is deterministic per (col,row)', () => {
    const a = treeCountForTile(new Tile(5, 7, TileType.FOREST));
    const b = treeCountForTile(new Tile(5, 7, TileType.FOREST));
    const c = treeCountForTile(new Tile(5, 8, TileType.FOREST));
    assert.equal(a, b, 'same hex → same tree count');
    // Same seed always lands in the [2,3] scaled band — both a and c.
    assert.ok(a >= 2 && a <= 3);
    assert.ok(c >= 2 && c <= 3);
  });
});

describe('isTileFullForMove', () => {
  test('grass tile is never full unless ≥7 units occupy it', () => {
    const state = freshState();
    // Pick a grass neighbour of the hero.
    const n = getNeighbors(state.hero.col, state.hero.row)
      .find(({ col, row }) => {
        const t = state.tiles.get(hexKey(col, row));
        return t && t.base === TileType.GRASS && t.path == null && t.building == null;
      });
    if (!n) return; // map-dependent; if not found this round, skip
    assert.equal(isTileFullForMove(state, state.hero, n.col, n.row), false);
  });

  test('building tile with 4 stacked units is full for an incoming 5th', () => {
    const state = freshState();
    const n = getNeighbors(state.hero.col, state.hero.row)[0];
    setTile(state, n.col, n.row, TileType.BUILDING);
    state.tiles.get(hexKey(n.col, n.row)).building = BuildingType.HOUSE;
    // Add four minions belonging to a hostile owner so they are NOT the
    // moving actor (the gate excludes the moving actor only).
    for (let i = 0; i < 4; i++) {
      const m = createMinion(n.col, n.row);
      m.id = `cap-test-min-${i}`;
      state.entities.push(m);
    }
    assert.equal(isTileFullForMove(state, state.hero, n.col, n.row), true);
  });

  test('the moving actor does not count itself toward the gate', () => {
    const state = freshState();
    const hero = state.hero;
    // 3 other units on a building tile + the moving hero would be 4 units
    // (= 7 capacity total) which is exactly full. The gate considers only
    // OTHER units, so the hero itself stepping in should NOT be full.
    const n = getNeighbors(hero.col, hero.row)[0];
    setTile(state, n.col, n.row, TileType.BUILDING);
    state.tiles.get(hexKey(n.col, n.row)).building = BuildingType.HOUSE;
    for (let i = 0; i < 3; i++) {
      const m = createSurvivor(n.col, n.row);
      m.id = `cap-friend-${i}`;
      state.entities.push(m);
    }
    // 3 + building (3) = 6, +1 (hero excluded) → 6, 1 remaining. Not full.
    assert.equal(isTileFullForMove(state, hero, n.col, n.row), false);
  });
});

describe('move validation rejects full hexes', () => {
  test('getReachableHexes excludes a full neighbour', () => {
    const state = freshState();
    const hero = state.hero;
    // Pick an adjacent target and fill it.
    const n = getNeighbors(hero.col, hero.row).find(({ col, row }) => {
      const t = state.tiles.get(hexKey(col, row));
      return t && t.path == null && t.base !== TileType.RIVER;
    });
    if (!n) return;
    setTile(state, n.col, n.row, TileType.BUILDING);
    state.tiles.get(hexKey(n.col, n.row)).building = BuildingType.HOUSE;
    for (let i = 0; i < 4; i++) {
      const m = createSurvivor(n.col, n.row);
      m.id = `block-${i}`;
      state.entities.push(m);
    }
    const reach = getReachableHexes(state, hero, 1);
    const present = reach.some(h => h.col === n.col && h.row === n.row);
    assert.equal(present, false, 'full hex must not be reachable');
  });

  test('executeMove into a full hex fails', () => {
    const state = freshState();
    const hero = state.hero;
    const n = getNeighbors(hero.col, hero.row).find(({ col, row }) => {
      const t = state.tiles.get(hexKey(col, row));
      return t && t.base !== TileType.RIVER;
    });
    if (!n) return;
    setTile(state, n.col, n.row, TileType.BUILDING);
    state.tiles.get(hexKey(n.col, n.row)).building = BuildingType.HOUSE;
    for (let i = 0; i < 4; i++) {
      const m = createSurvivor(n.col, n.row);
      m.id = `full-${i}`;
      state.entities.push(m);
    }
    const r = executeMove(state, hero, n.col, n.row);
    assert.equal(r.success, false, 'move into a full hex must fail');
    assert.equal(hero.col !== n.col || hero.row !== n.row, true,
      'hero must not have entered the full hex');
  });
});

describe('AI stepToward respects capacity', () => {
  test('stepToward skips a full intermediate hex', () => {
    const state = freshState();
    const hero = state.hero;
    // Saturate every neighbour except one direction with full building
    // tiles + 4 occupants; stepToward should still find a route via the
    // remaining open neighbour.
    const ns = getNeighbors(hero.col, hero.row);
    // Use a faraway goal; we just want to verify stepToward avoids blocked
    // neighbours when others remain.
    const goal = { col: hero.col + 3, row: hero.row };
    // Fill one neighbour completely.
    const blocked = ns[0];
    setTile(state, blocked.col, blocked.row, TileType.BUILDING);
    state.tiles.get(hexKey(blocked.col, blocked.row)).building = BuildingType.HOUSE;
    for (let i = 0; i < 4; i++) {
      const m = createSurvivor(blocked.col, blocked.row);
      m.id = `step-block-${i}`;
      state.entities.push(m);
    }
    const step = stepToward(state, hero, goal);
    // If a step exists, it must not be the fully-blocked neighbour (unless
    // it is the goal, which it isn't here).
    if (step) {
      assert.equal(step.col === blocked.col && step.row === blocked.row, false,
        'stepToward must avoid the full hex');
    }
  });
});
