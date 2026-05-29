// Tests for movement disambiguation logic.
// When a hex is a valid move target AND contains a selectable friendly unit,
// the UI should present a disambiguation choice rather than auto-moving.

import { describe, test } from 'node:test';
import { legacyTileType, isBuildingFootprint } from '../src/tiles.js';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import { EntityType, createSurvivor } from '../src/entities.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { getValidActions } from '../src/actions.js';

describe('move disambiguation — friendly unit on target hex', () => {
  test('a selectable ally on a valid move target triggers disambiguation', () => {
    const state = new GameState(true, true);
    const hero = state.hero;

    // Place a survivor on an adjacent hex that the hero can move to
    const neighbors = getNeighbors(hero.col, hero.row);
    const passable = neighbors.find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== 'river' && !isBuildingFootprint(t) &&
        !state.entities.some(e => e.alive && e.id !== hero.id && e.col === n.col && e.row === n.row);
    });
    assert.ok(passable, 'need a passable neighbor hex');

    const survivor = createSurvivor(passable.col, passable.row);
    survivor.owner = 'hero';
    state.entities.push(survivor);

    // Verify the hex is a valid move target for the hero
    const actions = getValidActions(state, hero);
    const moveAction = actions.find(a => a.type === 'move');
    assert.ok(moveAction, 'hero should have a move action');
    const isValidTarget = moveAction.targets.some(
      t => t.col === passable.col && t.row === passable.row,
    );
    assert.ok(isValidTarget, 'survivor hex should be a valid move target');

    // Verify there's a selectable friendly unit at that hex
    const alliesAtHex = state.entities.filter(e =>
      e.alive && e.owner === hero.owner && e.id !== hero.id &&
      e.col === passable.col && e.row === passable.row,
    );
    assert.ok(alliesAtHex.length > 0,
      'should detect a friendly unit at the target hex — disambiguation needed');
  });

  test('no disambiguation when target hex has no friendly units', () => {
    const state = new GameState(true, true);
    const hero = state.hero;

    const neighbors = getNeighbors(hero.col, hero.row);
    const emptyPassable = neighbors.find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== 'river' && !isBuildingFootprint(t) &&
        !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
    });
    assert.ok(emptyPassable, 'need an empty passable neighbor hex');

    const alliesAtHex = state.entities.filter(e =>
      e.alive && e.owner === hero.owner && e.id !== hero.id &&
      e.col === emptyPassable.col && e.row === emptyPassable.row,
    );
    assert.equal(alliesAtHex.length, 0,
      'empty hex should not trigger disambiguation');
  });
});
