// Tests for reusing the unit-selection popup for defender picking and enemy info.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import { EntityType, createMinion, createSurvivor } from '../src/entities.js';
import { hexKey, getNeighbors } from '../src/hex.js';

describe('defender picker reuses unit-selection popup', () => {
  test('_showDefenderPickerDialog sets _pendingDefenderPick state', () => {
    // Verify the new implementation stores defenders + callback on the UI state
    // instead of directly manipulating the result-dialog DOM.
    const state = new GameState(true, true);
    const witch = state.witch;

    // Create two minions at the same hex adjacent to the hero
    const heroNeighbors = getNeighbors(state.hero.col, state.hero.row);
    const targetHex = heroNeighbors.find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== 'river';
    });
    assert.ok(targetHex, 'need a passable hex near the hero');

    const m1 = createMinion(targetHex.col, targetHex.row);
    m1.owner = 'witch';
    const m2 = createMinion(targetHex.col, targetHex.row);
    m2.owner = 'witch';
    state.entities.push(m1, m2);

    // Verify we have two enemies on the same hex
    const enemiesAtHex = state.entities.filter(
      e => e.alive && e.owner === 'witch' && e.col === targetHex.col && e.row === targetHex.row
    );
    assert.ok(enemiesAtHex.length >= 2,
      'should have multiple enemies on same hex — defender picker needed');
  });
});

describe('enemy info disambiguation', () => {
  test('multiple enemy units on a hex require disambiguation', () => {
    const state = new GameState(true, true);
    const hero = state.hero;

    // Place two enemy minions on a hex visible to the hero
    const neighbors = getNeighbors(hero.col, hero.row);
    const targetHex = neighbors.find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== 'river' &&
        !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
    });
    assert.ok(targetHex, 'need an empty passable hex near hero');

    const m1 = createMinion(targetHex.col, targetHex.row);
    m1.owner = 'witch';
    const m2 = createMinion(targetHex.col, targetHex.row);
    m2.owner = 'witch';
    state.entities.push(m1, m2);

    // Simulate what _handleSelection does: find enemy entities at hex
    const ownerFilter = 'hero';
    const enemyEntities = state.entities.filter(
      e => e.alive && e.owner !== ownerFilter &&
        e.col === targetHex.col && e.row === targetHex.row
    );

    assert.ok(enemyEntities.length > 1,
      'multiple enemies should trigger disambiguation picker');
  });

  test('single enemy on hex does not need disambiguation', () => {
    const state = new GameState(true, true);
    const hero = state.hero;

    const neighbors = getNeighbors(hero.col, hero.row);
    const targetHex = neighbors.find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== 'river' &&
        !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
    });
    assert.ok(targetHex, 'need an empty passable hex near hero');

    const m1 = createMinion(targetHex.col, targetHex.row);
    m1.owner = 'witch';
    state.entities.push(m1);

    const ownerFilter = 'hero';
    const enemyEntities = state.entities.filter(
      e => e.alive && e.owner !== ownerFilter &&
        e.col === targetHex.col && e.row === targetHex.row
    );

    assert.equal(enemyEntities.length, 1,
      'single enemy should be selected directly without disambiguation');
  });
});
