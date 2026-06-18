// Task 1: explore results carry `lootItemIds` (index-aligned with the emoji
// `lootItems`) so the action card + round summary can show a discovered item's
// full name + stats. Plus lootDisplayLabel() unit coverage.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import { executeExplore } from '../src/actions.js';
import { createSurvivor } from '../src/entities.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { TileType, legacyTileType, isBuildingFootprint } from '../src/tiles.js';
import { lootDisplayLabel } from '../src/items.js';

function freshState() { return new GameState(true, true); }

// A passable, unexplored, unoccupied neighbour of the hero we can stage loot on.
function freeNeighbourTile(state) {
  for (const n of getNeighbors(state.hero.col, state.hero.row)) {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
        !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row)) {
      t.explored = false;
      t.buildingFootprintOf = null;
      t.footprintHexes = [];
      return { tile: t, col: n.col, row: n.row };
    }
  }
  return null;
}

describe('lootDisplayLabel', () => {
  test('weapons reuse their authored label (name + stats)', () => {
    assert.equal(lootDisplayLabel('sword'), '⚔ Sword (+2 ATK)');
    assert.match(lootDisplayLabel('musket'), /Musket.*\+2 ATK.*range 2/);
  });
  test('key items use their label; horse + resources use the fallback table', () => {
    assert.equal(lootDisplayLabel('horn'), '📯 Horn');
    assert.match(lootDisplayLabel('horse'), /Horse/);
    assert.equal(lootDisplayLabel('wood'), '🪵 Wood');
    assert.equal(lootDisplayLabel('herbs'), '🌿 Herbs');
  });
  test('unknown id degrades to the raw id, never blank', () => {
    assert.equal(lootDisplayLabel('mystery'), 'mystery');
    assert.equal(lootDisplayLabel(undefined), '');
  });
});

describe('executeExplore carries lootItemIds index-aligned with lootItems', () => {
  test('a forced resource override yields aligned ids', () => {
    const state = freshState();
    const spot = freeNeighbourTile(state);
    if (!spot) return; // rare fenced-in map — skip rather than flake
    spot.tile.exploreOverride = { kind: 'resource', id: 'wood', amount: 2 };
    const surv = createSurvivor(spot.col, spot.row, null);
    surv.owner = 'hero';
    state.entities.push(surv);

    const res = executeExplore(state, surv);
    assert.ok(res.success);
    assert.equal(res.lootItems.length, res.lootItemIds.length, 'arrays aligned');
    assert.deepEqual(res.lootItemIds, ['wood', 'wood']);
    assert.equal(lootDisplayLabel(res.lootItemIds[0]), '🪵 Wood');
  });

  test('a forced weapon override yields the concrete weapon id (→ name + stats)', () => {
    const state = freshState();
    const spot = freeNeighbourTile(state);
    if (!spot) return;
    spot.tile.exploreOverride = { kind: 'weapon', id: 'sword' };
    const surv = createSurvivor(spot.col, spot.row, null);
    surv.owner = 'hero';
    state.entities.push(surv);

    const res = executeExplore(state, surv);
    assert.ok(res.success);
    // The survivor may or may not be able to wield it depending on class, but
    // when a loot floater fires its id must be present and aligned.
    if (res.lootItems.length) {
      assert.equal(res.lootItems.length, res.lootItemIds.length);
      assert.equal(res.lootItemIds[0], 'sword');
      assert.equal(lootDisplayLabel(res.lootItemIds[0]), '⚔ Sword (+2 ATK)');
    }
  });

  test('a "nothing" override leaves both arrays empty', () => {
    const state = freshState();
    const spot = freeNeighbourTile(state);
    if (!spot) return;
    spot.tile.exploreOverride = { kind: 'nothing' };
    const surv = createSurvivor(spot.col, spot.row, null);
    surv.owner = 'hero';
    state.entities.push(surv);

    const res = executeExplore(state, surv);
    assert.ok(res.success);
    assert.equal(res.lootItems.length, 0);
    assert.equal(res.lootItemIds.length, 0);
  });
});
