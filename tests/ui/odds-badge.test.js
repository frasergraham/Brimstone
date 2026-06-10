// Tests for the odds badges shown above attackable enemies in plan mode.
//
// Covers the pure helper _computeOddsBadges():
//   - one badge per red-highlighted (battle-target) hex
//   - hit/crush probabilities match actions.computeCombatOdds
//   - several defenders on one hex collapse to the best (highest hit %)
//   - inactive outside plan mode / after submit / without a friendly selection
//
// No real DOM — UIController is instantiated with the injected elements bag.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeRenderer,
  makeFakeElement,
  createElementsBag,
} from './setup.js';

const { fakeCanvas } = installGlobalMocks();

let UIController, GameState, ActionType, computeCombatOdds, createHero, createMinion, createIronGolem;

before(async () => {
  const [uiMod, gameMod, actionsMod, entMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
    import('../../src/actions.js'),
    import('../../src/entities.js'),
  ]);
  UIController      = uiMod.UIController;
  GameState         = gameMod.GameState;
  ActionType        = actionsMod.ActionType;
  computeCombatOdds = actionsMod.computeCombatOdds;
  createHero        = entMod.createHero;
  createMinion      = entMod.createMinion;
  createIronGolem   = entMod.createIronGolem;
});

function makeUI() {
  const state    = new GameState(true, false);
  state.fogOfWar = 'none';
  const renderer = makeFakeRenderer();
  const els      = createElementsBag({
    'odds-badge-layer': makeFakeElement('odds-badge-layer'),
  });
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  ui.enterPlanningMode('hero', 5);
  return { ui, state };
}

/** Select `actor` and mark `targets` as attackable (the red overlay set). */
function arm(ui, actor, targets) {
  ui._selectedEntity   = actor;
  ui._isEnemySelection = false;
  ui._awaitingTarget   = null;
  ui._validActions     = [{ type: ActionType.BATTLE, targets }];
}

describe('_computeOddsBadges', () => {
  test('one badge per attackable enemy, odds matching computeCombatOdds', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    const badges = ui._computeOddsBadges();
    assert.equal(badges.length, 1);
    const expected = computeCombatOdds(state, hero, minion);
    assert.equal(badges[0].col, minion.col);
    assert.equal(badges[0].row, minion.row);
    assert.equal(badges[0].hit, expected.hit);
    assert.equal(badges[0].crush, expected.crush);
  });

  test('several defenders on one hex collapse to the best hit chance', () => {
    const { ui, state } = makeUI();
    const hero  = createHero(3, 3, 'p1', state);
    const weak  = createMinion(3, 4, 'p2', state);     // easy to hit
    const tough = createIronGolem(3, 4, 'p2', state);  // hard to hit
    state.entities.push(hero, weak, tough);
    arm(ui, hero, [weak, tough]);

    const badges = ui._computeOddsBadges();
    assert.equal(badges.length, 1, 'shared hex must show a single badge');
    const weakOdds  = computeCombatOdds(state, hero, weak);
    const toughOdds = computeCombatOdds(state, hero, tough);
    assert.equal(badges[0].hit, Math.max(weakOdds.hit, toughOdds.hit));
  });

  test('separate hexes get separate badges', () => {
    const { ui, state } = makeUI();
    const hero = createHero(3, 3, 'p1', state);
    const a = createMinion(3, 4, 'p2', state);
    const b = createMinion(3, 2, 'p2', state);
    state.entities.push(hero, a, b);
    arm(ui, hero, [a, b]);
    assert.equal(ui._computeOddsBadges().length, 2);
  });

  test('inactive outside plan mode, after submit, and for enemy selections', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    ui._planMode = false;
    assert.deepEqual(ui._computeOddsBadges(), []);
    ui._planMode = true;

    ui._planSubmitted = true;
    assert.deepEqual(ui._computeOddsBadges(), []);
    ui._planSubmitted = false;

    ui._isEnemySelection = true;
    assert.deepEqual(ui._computeOddsBadges(), []);
    ui._isEnemySelection = false;

    ui._selectedEntity = null;
    assert.deepEqual(ui._computeOddsBadges(), []);
  });

  test('inactive while targeting a non-battle action (e.g. Attack Hex)', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);
    ui._awaitingTarget = { actionType: ActionType.BATTLE_HEX, actor: hero };
    assert.deepEqual(ui._computeOddsBadges(), []);
  });

  test('active while explicitly targeting an attack', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);
    ui._awaitingTarget = { actionType: ActionType.BATTLE, actor: hero };
    assert.equal(ui._computeOddsBadges().length, 1);
  });
});
