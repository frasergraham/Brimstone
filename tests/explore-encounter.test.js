// Tests for explore action survivor encounter dialog trigger.
// Validates that encounterSurvivor from explore results is surfaced
// the same way as from move encounters during plan resolution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { GameState } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import { hexKey } from '../src/hex.js';

function freshState() {
  return new GameState(true, true);
}

describe('explore action — survivor encounter in resolution', () => {
  test('explore on a tile with hidden survivor returns encounterSurvivor in result', () => {
    const state = freshState();
    const hero = state.hero;

    // Plant a hidden survivor on the hero's tile so explore discovers it
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.hiddenSurvivor = true;
    t.explored = false;

    const heroPlan = [{
      type: PlanActionType.EXPLORE,
      entityId: hero.id,
    }];

    const steps = resolvePlans(state, heroPlan, []);

    // Find the explore event in the resolution steps
    let exploreResult = null;
    for (const step of steps) {
      for (const ev of (step.heroEvents ?? [])) {
        if (ev.action?.type === PlanActionType.EXPLORE && ev.result) {
          exploreResult = ev.result;
        }
      }
    }

    assert.ok(exploreResult, 'expected an explore result in resolution steps');
    assert.ok(exploreResult.encounterSurvivor, 'explore result should include encounterSurvivor when tile has hidden survivor');
    assert.equal(exploreResult.encounterSurvivor.type, 'survivor');
    assert.ok(exploreResult.encounterSurvivor.name, 'encounterSurvivor should have a name');
    assert.ok(exploreResult.encounterSurvivor.hp > 0, 'encounterSurvivor should have positive HP');
  });

  test('explore on a tile without hidden survivor returns no encounterSurvivor', () => {
    const state = freshState();
    const hero = state.hero;

    // Ensure no hidden survivor on hero's tile
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.hiddenSurvivor = false;
    t.explored = false;

    const heroPlan = [{
      type: PlanActionType.EXPLORE,
      entityId: hero.id,
    }];

    const steps = resolvePlans(state, heroPlan, []);

    let exploreResult = null;
    for (const step of steps) {
      for (const ev of (step.heroEvents ?? [])) {
        if (ev.action?.type === PlanActionType.EXPLORE && ev.result) {
          exploreResult = ev.result;
        }
      }
    }

    assert.ok(exploreResult, 'expected an explore result');
    assert.equal(exploreResult.encounterSurvivor, null, 'should be null when no hidden survivor');
  });
});
