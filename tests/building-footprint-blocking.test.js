// P3: building-footprint hexes are FULLY IMPASSABLE — no entity may end its
// turn on one and none may transit through. Implemented as capacity 0 on the
// footprint tile, plus explicit guards in pathfinding, AI step helpers, and
// action targeting (explore/battle/fortify belong to the ENTRANCE, never a
// footprint hex).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import {
  TileType, BuildingType, Tile,
  TILE_CAPACITY, tileTotalCapacity, tileCapacityRemaining, tileOccupancyCount,
  isBuildingFootprint, decomposeTileType,
} from '../src/tiles.js';
import {
  getReachableHexes, findShortestPath, executeMove, getValidActions, ActionType,
} from '../src/actions.js';
import { hexKey, hexDistance, getNeighbors, hexRange } from '../src/hex.js';
import { stepToward } from '../src/ai.js';
import { createMinion } from '../src/entities.js';

// ── Setup helpers ──────────────────────────────────────────────────────────

function freshState() {
  return new GameState(true, true);
}

// Flatten every tile within hexDistance r of (col,row) to plain explored grass
// so passability is governed only by what the test deliberately places.
function normalizeRegion(state, col, row, r) {
  for (const [, t] of state.tiles) {
    if (hexDistance(col, row, t.col, t.row) > r) continue;
    decomposeTileType(t, TileType.GRASS);
    t.building = null;
    t.hiddenSurvivor = false;
    t.fortifyLevel = 0;
    t.buildingFootprintOf = null;
    t.footprintHexes = [];
    t.explored = true;
  }
}

// Turn the tile at (fpCol,fpRow) into a footprint hex of an entrance building
// at (entCol,entRow). The footprint hex keeps a grass base; only the
// buildingFootprintOf back-pointer marks it impassable.
function makeFootprint(state, entCol, entRow, fpCol, fpRow) {
  const ent = state.tiles.get(hexKey(entCol, entRow));
  decomposeTileType(ent, TileType.BUILDING);
  ent.building = BuildingType.HOUSE;
  ent.footprintHexes = [hexKey(fpCol, fpRow)];
  const fp = state.tiles.get(hexKey(fpCol, fpRow));
  fp.buildingFootprintOf = hexKey(entCol, entRow);
  return fp;
}

// Find a goal hex 2 away from H plus the "stepping stones" (hexes adjacent to
// BOTH H and the goal — the only intermediates of a 2-step path). Blocking
// every stone forces a strictly-longer detour. Returns null if the local
// geometry near H doesn't yield a usable layout (edge of map).
function pickGoalAndStones(state, H) {
  for (const n1 of getNeighbors(H.col, H.row)) {
    for (const goal of getNeighbors(n1.col, n1.row)) {
      if (hexDistance(H.col, H.row, goal.col, goal.row) !== 2) continue;
      const stones = getNeighbors(H.col, H.row).filter(a =>
        getNeighbors(goal.col, goal.row).some(b => b.col === a.col && b.row === a.row));
      const all = [H, goal, ...stones];
      if (stones.length >= 1 && all.every(h => state.tiles.has(hexKey(h.col, h.row)))) {
        return { goal, stones };
      }
    }
  }
  return null;
}

// A guaranteed-interior hex: one whose full radius-`pad` disc is in-bounds AND
// present in state.tiles. Using the randomized hero spawn (which can sit on a
// map edge) made the detour tests flaky — a blocked goal near an edge can have
// no in-bounds detour. An interior hex always has breathing room. Returns the
// chosen {col,row}, or null if the map has no such hex.
//
// Disc size for a fully in-bounds radius-r neighbourhood: 3r²+3r+1.
function fullDisc(r) { return 3 * r * r + 3 * r + 1; }

function interiorHexFor(state, pad = 4) {
  for (const [, t] of state.tiles) {
    const disc = hexRange(t.col, t.row, pad);
    if (disc.length !== fullDisc(pad)) continue; // clipped by map bounds
    if (disc.every(h => state.tiles.has(hexKey(h.col, h.row)))) {
      return { col: t.col, row: t.row };
    }
  }
  return null;
}

// ── Capacity ────────────────────────────────────────────────────────────────

describe('footprint hex capacity is 0', () => {
  test('tileTotalCapacity → 0 on a footprint hex, TILE_CAPACITY otherwise', () => {
    const plain = new Tile(0, 0, TileType.GRASS);
    assert.equal(tileTotalCapacity(plain), TILE_CAPACITY);
    const fp = new Tile(1, 1, TileType.GRASS);
    fp.buildingFootprintOf = '0,0';
    assert.equal(isBuildingFootprint(fp), true);
    assert.equal(tileTotalCapacity(fp), 0);
  });

  test('tileCapacityRemaining → 0 (full) on a footprint hex even with no units', () => {
    const fp = new Tile(1, 1, TileType.GRASS);
    fp.buildingFootprintOf = '0,0';
    assert.equal(tileCapacityRemaining(fp, 0), 0);
    assert.equal(tileCapacityRemaining(fp, []), 0);
    // A footprint never has a building of its own, so occupancy is 0 — the
    // impassability comes entirely from the 0 total capacity.
    assert.equal(tileOccupancyCount(fp), 0);
  });
});

// ── Pathfinding ───────────────────────────────────────────────────────────

describe('pathfinding routes around footprint hexes', () => {
  test('getReachableHexes never includes a footprint hex', () => {
    const state = freshState();
    const H = { col: state.hero.col, row: state.hero.row };
    normalizeRegion(state, H.col, H.row, 3);
    state.entities = [state.hero];

    const nb = getNeighbors(H.col, H.row).find(n => state.tiles.has(hexKey(n.col, n.row)));
    assert.ok(nb, 'hero should have an in-bounds neighbour');
    // Use a far-off entrance so the entrance isn't itself in range.
    makeFootprint(state, H.col, H.row, nb.col, nb.row); // entrance = hero hex (just a marker)
    // Re-flatten the entrance: we only care that nb is a footprint here.
    decomposeTileType(state.tiles.get(hexKey(H.col, H.row)), TileType.GRASS);

    const reachable = getReachableHexes(state, state.hero, 1);
    assert.ok(!reachable.some(h => h.col === nb.col && h.row === nb.row),
      'footprint neighbour must not be reachable');
  });

  test('findShortestPath returns null when the goal IS a footprint hex', () => {
    const state = freshState();
    const H = { col: state.hero.col, row: state.hero.row };
    normalizeRegion(state, H.col, H.row, 3);
    state.entities = [state.hero];
    const nb = getNeighbors(H.col, H.row).find(n => state.tiles.has(hexKey(n.col, n.row)));
    const ent = getNeighbors(nb.col, nb.row).find(e =>
      state.tiles.has(hexKey(e.col, e.row)) && !(e.col === H.col && e.row === H.row));
    makeFootprint(state, ent.col, ent.row, nb.col, nb.row);

    assert.equal(findShortestPath(state, state.hero, nb.col, nb.row), null);
  });

  test('findShortestPath detours (longer, not null) when stones are footprints', () => {
    const state = freshState();
    const interior = interiorHexFor(state);
    assert.ok(interior, 'map should have an interior hex with breathing room');
    state.hero.col = interior.col;
    state.hero.row = interior.row;
    const H = { col: state.hero.col, row: state.hero.row };
    normalizeRegion(state, H.col, H.row, 3);
    state.entities = [state.hero];

    const pick = pickGoalAndStones(state, H);
    assert.ok(pick, 'expected a usable 2-hex layout near the hero');
    const { goal, stones } = pick;
    // Footprint every stepping stone; entrance marker placed off to the side.
    for (const s of stones) makeFootprint(state, goal.col, goal.row, s.col, s.row);
    // Keep the goal itself plain grass (entrance marker only set footprintHexes there).
    const gt = state.tiles.get(hexKey(goal.col, goal.row));
    gt.buildingFootprintOf = null;
    decomposeTileType(gt, TileType.GRASS);

    const path = findShortestPath(state, state.hero, goal.col, goal.row);
    assert.ok(path, 'a detour path should still exist on open grass');
    assert.equal(path[path.length - 1].col, goal.col);
    assert.equal(path[path.length - 1].row, goal.row);
    // Direct route was 2 steps; with every stone blocked the detour is ≥3.
    assert.ok(path.length >= 3, `expected a detour ≥3 steps, got ${path.length}`);
    for (const step of path) {
      assert.equal(isBuildingFootprint(state.tiles.get(hexKey(step.col, step.row))), false,
        'no path step may land on a footprint hex');
    }
  });

  test('a unit adjacent to a footprint cannot move INTO it', () => {
    const state = freshState();
    const H = { col: state.hero.col, row: state.hero.row };
    normalizeRegion(state, H.col, H.row, 3);
    state.entities = [state.hero];
    const nb = getNeighbors(H.col, H.row).find(n => state.tiles.has(hexKey(n.col, n.row)));
    const ent = getNeighbors(nb.col, nb.row).find(e =>
      state.tiles.has(hexKey(e.col, e.row)) && !(e.col === H.col && e.row === H.row));
    makeFootprint(state, ent.col, ent.row, nb.col, nb.row);

    const res = executeMove(state, state.hero, nb.col, nb.row);
    assert.equal(res.success, false, 'move into footprint must be rejected');
    assert.ok(state.hero.col === H.col && state.hero.row === H.row,
      'hero must not have stepped onto the footprint');
  });
});

// ── AI step helpers ──────────────────────────────────────────────────────────

describe('AI stepToward skips footprint hexes', () => {
  test('first step routes around footprint stepping-stones', () => {
    const state = freshState();
    const interior = interiorHexFor(state);
    assert.ok(interior, 'map should have an interior hex with breathing room');
    const H = { col: interior.col, row: interior.row };
    normalizeRegion(state, H.col, H.row, 3);
    const unit = createMinion(H.col, H.row);
    state.entities = [unit];

    const pick = pickGoalAndStones(state, H);
    assert.ok(pick, 'expected a usable 2-hex layout near the unit');
    const { goal, stones } = pick;
    for (const s of stones) makeFootprint(state, goal.col, goal.row, s.col, s.row);
    const gt = state.tiles.get(hexKey(goal.col, goal.row));
    gt.buildingFootprintOf = null;
    decomposeTileType(gt, TileType.GRASS);

    const step = stepToward(state, unit, goal);
    assert.ok(step, 'stepToward should find a detour, not give up');
    assert.equal(isBuildingFootprint(state.tiles.get(hexKey(step.col, step.row))), false,
      'first AI step must not be a footprint hex');
  });
});

// ── Action targeting ──────────────────────────────────────────────────────

describe('getValidActions never targets a footprint hex', () => {
  test('no explore / fortify offered, and battle-hex excludes footprints', () => {
    const state = freshState();
    const H = { col: state.hero.col, row: state.hero.row };
    normalizeRegion(state, H.col, H.row, 3);
    state.entities = [state.hero];
    const nb = getNeighbors(H.col, H.row).find(n => state.tiles.has(hexKey(n.col, n.row)));
    const ent = getNeighbors(nb.col, nb.row).find(e =>
      state.tiles.has(hexKey(e.col, e.row)) && !(e.col === H.col && e.row === H.row));

    // Place the hero directly ON a footprint hex (test-only — normally
    // unreachable) and confirm explore/fortify are withheld there.
    makeFootprint(state, ent.col, ent.row, H.col, H.row);
    const onFp = state.tiles.get(hexKey(H.col, H.row));
    onFp.explored = false; // unexplored, yet explore must still be withheld

    const actions = getValidActions(state, state.hero);
    assert.ok(!actions.some(a => a.type === ActionType.EXPLORE),
      'EXPLORE must not be offered on a footprint hex');
    assert.ok(!actions.some(a => a.type === ActionType.FORTIFY),
      'FORTIFY must not be offered on a footprint hex');

    const battleHex = actions.find(a => a.type === ActionType.BATTLE_HEX);
    if (battleHex) {
      assert.ok(!battleHex.targets.some(t => t.col === H.col && t.row === H.row),
        'BATTLE_HEX must not target a footprint hex');
    }
  });

  test('regression: entrance retains explore + fortify validity', () => {
    const state = freshState();
    const H = { col: state.hero.col, row: state.hero.row };
    normalizeRegion(state, H.col, H.row, 3);
    state.entities = [state.hero];
    const nb = getNeighbors(H.col, H.row).find(n => state.tiles.has(hexKey(n.col, n.row)));
    // Hero stands on a building ENTRANCE (footprint lives on the neighbour).
    makeFootprint(state, H.col, H.row, nb.col, nb.row);
    const entrance = state.tiles.get(hexKey(H.col, H.row));
    entrance.explored = false;

    const actions = getValidActions(state, state.hero);
    assert.ok(actions.some(a => a.type === ActionType.EXPLORE),
      'entrance should still offer EXPLORE');
    assert.ok(actions.some(a => a.type === ActionType.FORTIFY),
      'entrance should still offer FORTIFY');
  });

  test('a unit placed on a footprint hex does not crash queries', () => {
    const state = freshState();
    const H = { col: state.hero.col, row: state.hero.row };
    normalizeRegion(state, H.col, H.row, 3);
    const nb = getNeighbors(H.col, H.row).find(n => state.tiles.has(hexKey(n.col, n.row)));
    const ent = getNeighbors(nb.col, nb.row).find(e =>
      state.tiles.has(hexKey(e.col, e.row)) && !(e.col === H.col && e.row === H.row));
    makeFootprint(state, ent.col, ent.row, nb.col, nb.row);
    // Force a minion onto the footprint hex directly (illegal in normal play).
    const unit = createMinion(nb.col, nb.row);
    state.entities = [unit];

    assert.doesNotThrow(() => {
      getReachableHexes(state, unit, 1);
      getValidActions(state, unit);
    });
  });
});
