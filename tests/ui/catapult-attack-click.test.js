// Regression: an IMMOBILE ranged unit (the Captain's catapult) must let the
// player queue an attack by clicking a highlighted target.
//
// The bug: _selectEntity only set a default MOVE target-handler when the unit
// could move. A catapult has no MOVE, so _awaitingTarget stayed null and a
// click on a highlighted enemy fell through to plain selection — it just
// re-selected the enemy instead of stacking an attack. The fix gives a
// move-less-but-armed unit a default BATTLE target-handler.
//
// No real DOM — UIController runs against the injected elements bag + fake
// renderer (same harness as undo-button.test.js).

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';

const { fakeCanvas } = installGlobalMocks();

let UIController, GameState, ActionType, PlanActionType, createCatapult, createZombie;

before(async () => {
  const [uiMod, gameMod, plannerMod, actionsMod, entMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
    import('../../src/planner.js'),
    import('../../src/actions.js'),
    import('../../src/entities.js'),
  ]);
  UIController   = uiMod.UIController;
  GameState      = gameMod.GameState;
  ActionType     = actionsMod.ActionType;
  PlanActionType = plannerMod.PlanActionType;
  createCatapult = entMod.createCatapult;
  createZombie   = entMod.createZombie;
});

function makeUI() {
  const state    = new GameState(true, false);
  state.fogOfWar = 'none';               // keep the enemy visible for BATTLE targets
  const renderer = makeFakeRenderer();
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, createElementsBag({}));
  ui.enterPlanningMode('hero', 8);
  return { ui, state };
}

// A hero-side catapult with a witch zombie two hexes away (inside its range-4
// weapon). Returns both so tests can act on them.
function withCatapultAndEnemy(state) {
  const cat = createCatapult(5, 5, null, state);
  cat.owner = 'hero';
  const zombie = createZombie(7, 5, null, state);
  zombie.owner = 'witch';
  state.entities.push(cat, zombie);
  return { cat, zombie };
}

describe('Catapult (immobile ranged) attack-by-click', () => {
  test('selecting the catapult arms a DEFAULT battle target-handler', () => {
    const { ui, state } = makeUI();
    const { cat } = withCatapultAndEnemy(state);

    ui._selectEntity(cat);

    assert.equal(ui._awaitingTarget?.actionType, ActionType.BATTLE,
      'a move-less but armed unit defaults to BATTLE targeting');
    assert.equal(ui._awaitingTarget?.isDefault, true, 'and it is the default handler');
    assert.equal(ui._awaitingTarget?.actor?.id, cat.id);
  });

  test('clicking the in-range enemy queues the attack (does NOT re-select the enemy)', () => {
    const { ui, state } = makeUI();
    const { cat, zombie } = withCatapultAndEnemy(state);

    ui._selectEntity(cat);
    ui._handleTargetClick({ col: zombie.col, row: zombie.row });

    const plan = ui._unitPlans.get(cat.id) ?? [];
    assert.equal(plan.filter(a => a.type === PlanActionType.BATTLE_UNIT).length, 1,
      'a BATTLE_UNIT is queued for the catapult');
    assert.equal(plan[0].targetId, zombie.id, 'aimed at the clicked enemy');
    assert.equal(ui._isEnemySelection, false, 'the enemy was NOT selected');
    assert.equal(ui._selectedEntity?.id, cat.id, 'the catapult stays selected so more attacks can stack');
  });

  test('clicking off any target falls through to selection — the unit is not stuck', () => {
    const { ui, state } = makeUI();
    const { cat } = withCatapultAndEnemy(state);

    ui._selectEntity(cat);
    // An empty hex far from the enemy: no attack queued, no throw.
    ui._handleTargetClick({ col: 0, row: 0 });

    const plan = ui._unitPlans.get(cat.id) ?? [];
    assert.equal(plan.filter(a => a.type === PlanActionType.BATTLE_UNIT).length, 0,
      'clicking empty ground queues no attack');
  });
});
