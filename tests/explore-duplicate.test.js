// Regression test: two explore actions in the same turn must produce
// independent lootItems arrays — the second explore's result should
// never contain items from the first explore.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { GameState } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { createSurvivor } from '../src/entities.js';
import { TileType, BuildingType, legacyTileType, decomposeTileType, isBuildingFootprint } from '../src/tiles.js';

function freshState() {
  return new GameState(true, true);
}

// Procedural maps can drop an impassable building footprint (cap-0) on any hex.
// Test fixtures that carve out passable/explorable terrain must neutralize any
// footprint markers a random map happened to place there.
function clearFootprint(tile) {
  if (!tile) return tile;
  tile.buildingFootprintOf = null;
  tile.footprintHexes = [];
  return tile;
}

/** Collect all ACTION_OK explore events from resolution steps. */
function collectExploreEvents(steps) {
  const results = [];
  for (const step of steps) {
    for (const ev of (step.heroEvents ?? [])) {
      if (ev.type === ResEventType.ACTION_OK && ev.action?.type === PlanActionType.EXPLORE) {
        results.push(ev);
      }
    }
  }
  return results;
}

describe('explore — no duplicate results across multiple explores', () => {

  test('two entities exploring different tiles in the same step get independent lootItems', () => {
    const state = freshState();
    const hero = state.hero;

    // Find a passable neighbor for the survivor
    const neighbors = getNeighbors(hero.col, hero.row);
    let survivorHex = null;
    for (const n of neighbors) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
          !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row)) {
        survivorHex = n;
        break;
      }
    }
    // Random maps can fence the hero in with river/footprint hexes; skip the
    // rare layout where no passable neighbor exists rather than flake.
    if (!survivorHex) return;

    // Place survivor and set both tiles as unexplored buildings (guaranteed loot)
    const survivor = createSurvivor(survivorHex.col, survivorHex.row, null);
    survivor.owner = 'hero';
    state.entities.push(survivor);

    const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
    heroTile.explored = false;
    decomposeTileType(heroTile, TileType.BUILDING);
    heroTile.building = BuildingType.INN;
    clearFootprint(heroTile);

    const survTile = state.tiles.get(hexKey(survivorHex.col, survivorHex.row));
    survTile.explored = false;
    decomposeTileType(survTile, TileType.BUILDING);
    survTile.building = BuildingType.BLACKSMITH;
    clearFootprint(survTile);

    const heroPlan = [
      { type: PlanActionType.EXPLORE, entityId: hero.id },
      { type: PlanActionType.EXPLORE, entityId: survivor.id },
    ];
    const steps = resolvePlans(state, heroPlan, []);
    const explores = collectExploreEvents(steps);

    assert.equal(explores.length, 2, 'both explores should succeed');

    // The two lootItems arrays must be distinct references
    assert.notEqual(explores[0].result.lootItems, explores[1].result.lootItems,
      'lootItems arrays must not be the same reference');

    // Each should contain only its own items
    assert.ok(Array.isArray(explores[0].result.lootItems), 'first lootItems is an array');
    assert.ok(Array.isArray(explores[1].result.lootItems), 'second lootItems is an array');
  });

  test('same entity exploring twice (move-explore-move-explore) gets independent lootItems', () => {
    const state = freshState();
    const hero = state.hero;

    // Find two passable neighbors (tile1 adjacent to hero, tile2 adjacent to tile1)
    const neighbors = getNeighbors(hero.col, hero.row);
    let tile1 = null, tile2 = null;
    for (const n of neighbors) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (!t || legacyTileType(t) === TileType.RIVER || isBuildingFootprint(t)) continue;
      if (state.entities.some(e => e.alive && e.col === n.col && e.row === n.row && e.id !== hero.id)) continue;
      if (!tile1) { tile1 = n; continue; }
      // tile2 must be a neighbor of tile1 for the second move
      const t1n = getNeighbors(tile1.col, tile1.row);
      if (t1n.some(nn => nn.col === n.col && nn.row === n.row)) {
        tile2 = n;
        break;
      }
    }
    // Random maps can fence the hero in with river/footprint hexes; skip the
    // rare layout where no two adjacent passable tiles exist rather than flake.
    if (!tile1 || !tile2) return;

    // Set both tiles as unexplored buildings
    const t1 = state.tiles.get(hexKey(tile1.col, tile1.row));
    t1.explored = false; decomposeTileType(t1, TileType.BUILDING); t1.building = BuildingType.INN; clearFootprint(t1);
    const t2 = state.tiles.get(hexKey(tile2.col, tile2.row));
    t2.explored = false; decomposeTileType(t2, TileType.BUILDING); t2.building = BuildingType.BLACKSMITH; clearFootprint(t2);

    const heroPlan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: tile1.col, toRow: tile1.row },
      { type: PlanActionType.EXPLORE, entityId: hero.id },
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: tile2.col, toRow: tile2.row },
      { type: PlanActionType.EXPLORE, entityId: hero.id },
    ];
    const steps = resolvePlans(state, heroPlan, []);
    const explores = collectExploreEvents(steps);

    assert.equal(explores.length, 2, 'both explores should succeed');
    assert.notEqual(explores[0].result.lootItems, explores[1].result.lootItems,
      'lootItems arrays must not be the same reference');

    // Each explore's result should contain only items from its own tile
    assert.ok(Array.isArray(explores[0].result.lootItems));
    assert.ok(Array.isArray(explores[1].result.lootItems));
  });
});
