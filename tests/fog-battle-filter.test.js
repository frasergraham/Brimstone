// Regression tests: getValidActions must not surface BATTLE/BATTLE_UNIT targets
// for enemies hidden by fog of war.
//
// Bug: during planning, clicking a hex that contained a fog-hidden enemy would
// still route to an attack, because getValidActions returned the enemy in its
// BATTLE targets list. The UI only filtered the red highlight — the underlying
// click handler (_handleTargetClick) still consulted the unfiltered targets and
// generated a BATTLE_UNIT plan step against an invisible target.
//
// Plan mode must ignore all enemies that aren't currently visible to the
// actor's faction. Players who want to attack into the fog must use the
// explicit "Attack Hex" (BATTLE_HEX) action.
//
// Scenario: the UI passes an "effective entity" at the projected (ghost)
// position after planned moves. An enemy adjacent to that ghost hex may still
// be out of sight range from the faction's real units — so visibility (which
// uses real positions) correctly hides it, but adjacentEnemies() happily
// returned it as a BATTLE target.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase } from '../src/game.js';
import { getValidActions, ActionType } from '../src/actions.js';
import { createMinion, EntityType } from '../src/entities.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { TileType } from '../src/tiles.js';

function freshState() {
  // Both AI => fogOfWar defaults to 'partial'.
  const state = new GameState(true, true);
  state.phase = Phase.NIGHT; // hero sight range = 1
  return state;
}

// Remove all entities except the faction leaders so co-located minions from
// the default setup can't interfere with the visibility calculations.
function stripToLeaders(state) {
  state.entities = state.entities.filter(
    e => e.type === EntityType.HERO || e.type === EntityType.WITCH,
  );
}

// Force a hex and its immediate neighbours to grass so BATTLE_HEX / visibility
// checks aren't affected by randomly-generated rivers or buildings.
function clearArea(state, col, row, radius = 2) {
  for (let r = row - radius; r <= row + radius; r++) {
    for (let c = col - radius; c <= col + radius; c++) {
      const k = hexKey(c, r);
      if (!state.tiles.has(k)) continue;
      state.tiles.set(k, {
        type: TileType.GRASS,
        building: null,
        fortifyLevel: 0,
        explored: false,
      });
    }
  }
}

describe('getValidActions filters BATTLE targets by fog visibility', () => {
  test('adjacent enemy outside sight range is NOT a battle target', () => {
    const state = freshState();
    stripToLeaders(state);
    clearArea(state, 5, 5);

    const hero = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);

    // Real hero far from the witch so sight (range 1 at night) does not reach.
    hero.col = 0; hero.row = 0;
    witch.col = 10; witch.row = 10; // well out of the way

    // Spawn a witch-owned minion adjacent to the hero's projected position.
    // Distance from real hero (0,0) to (6,5) exceeds sight range, so the
    // minion is hidden by partial fog.
    const minion = createMinion(6, 5, 'witch');
    state.entities.push(minion);

    // Emulate how the UI calls getValidActions in planning mode: it passes an
    // "effective entity" whose col/row are the projected ghost position rather
    // than the entity's real position.
    const projectedHero = { ...hero, col: 5, row: 5 };
    Object.setPrototypeOf(projectedHero, Object.getPrototypeOf(hero));

    const actions = getValidActions(state, projectedHero);
    const battle  = actions.find(a => a.type === ActionType.BATTLE);

    const targetsMinion =
      battle?.targets.some(t => t.col === 6 && t.row === 5) ?? false;
    assert.equal(
      targetsMinion, false,
      'fog-hidden minion should not appear in BATTLE targets',
    );
  });

  test('same-hex hidden enemy is NOT a battle target', () => {
    // Moving a unit onto a hex that happens to contain a fog-hidden enemy
    // must not silently create an attack plan step.
    const state = freshState();
    stripToLeaders(state);

    const hero = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);
    hero.col = 0; hero.row = 0;
    witch.col = 10; witch.row = 10;

    clearArea(state, 5, 5);

    // Hidden minion sitting on the hex the hero is about to move into.
    const minion = createMinion(5, 5, 'witch');
    state.entities.push(minion);

    const projectedHero = { ...hero, col: 5, row: 5 };
    Object.setPrototypeOf(projectedHero, Object.getPrototypeOf(hero));

    const actions = getValidActions(state, projectedHero);
    const battle  = actions.find(a => a.type === ActionType.BATTLE);

    const targetsMinion =
      battle?.targets.some(t => t.col === 5 && t.row === 5) ?? false;
    assert.equal(
      targetsMinion, false,
      'co-located hidden minion should not appear in BATTLE targets',
    );
  });

  test('visible adjacent enemy IS still a battle target', () => {
    // Sanity check: the fog filter must not break the normal case.
    const state = freshState();
    stripToLeaders(state);
    clearArea(state, 3, 3);

    const hero = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);
    hero.col = 3; hero.row = 3;
    witch.col = 10; witch.row = 10;

    // Adjacent to the real hero — distance 1, within night sight range.
    const minion = createMinion(4, 3, 'witch');
    state.entities.push(minion);

    const actions = getValidActions(state, hero);
    const battle  = actions.find(a => a.type === ActionType.BATTLE);
    assert.ok(battle, 'BATTLE action should exist for visible adjacent enemy');
    assert.ok(
      battle.targets.some(t => t.col === 4 && t.row === 3),
      'visible minion should be a BATTLE target',
    );
  });

  test('fog disabled means all adjacent enemies are battle targets', () => {
    // When fogOfWar is 'none' (no AI / both human), visibility filtering is
    // a no-op and every adjacent enemy is fair game — including ones that
    // would be hidden under partial fog.
    const state = freshState();
    state.fogOfWar = 'none';
    stripToLeaders(state);
    clearArea(state, 5, 5);

    const hero = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);
    hero.col = 0; hero.row = 0;
    witch.col = 10; witch.row = 10;

    const minion = createMinion(6, 5, 'witch');
    state.entities.push(minion);

    const projectedHero = { ...hero, col: 5, row: 5 };
    Object.setPrototypeOf(projectedHero, Object.getPrototypeOf(hero));

    const actions = getValidActions(state, projectedHero);
    const battle  = actions.find(a => a.type === ActionType.BATTLE);

    assert.ok(battle, 'BATTLE action should exist with fog off');
    assert.ok(
      battle.targets.some(t => t.col === 6 && t.row === 5),
      'minion should be a target when fog is disabled',
    );
  });

  test('BATTLE_HEX targets are unchanged — fog attack still available', () => {
    // The explicit "attack into fog" action must remain available against the
    // hex even when the enemy itself is filtered out of BATTLE targets.
    const state = freshState();
    stripToLeaders(state);
    clearArea(state, 5, 5);

    const hero = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);
    hero.col = 0; hero.row = 0;
    witch.col = 10; witch.row = 10;

    const minion = createMinion(6, 5, 'witch');
    state.entities.push(minion);

    const projectedHero = { ...hero, col: 5, row: 5 };
    Object.setPrototypeOf(projectedHero, Object.getPrototypeOf(hero));

    const actions = getValidActions(state, projectedHero);
    const battleHex = actions.find(a => a.type === ActionType.BATTLE_HEX);
    assert.ok(battleHex, 'BATTLE_HEX action should be available');
    assert.ok(
      battleHex.targets.some(t => t.col === 6 && t.row === 5),
      'BATTLE_HEX targets every adjacent non-river hex regardless of fog',
    );
  });
});
