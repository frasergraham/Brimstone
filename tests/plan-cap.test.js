// Tests for plan action cap (1.5× (budget + food)) and toast warnings.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeCanvas,
  makeFakeRenderer,
  createElementsBag,
  makeState,
} from './ui/setup.js';

const { fakeCanvas } = installGlobalMocks();

let UIController, PlanActionType;

before(async () => {
  const [uiMod, plannerMod] = await Promise.all([
    import('../src/ui.js'),
    import('../src/planner.js'),
  ]);
  UIController  = uiMod.UIController;
  PlanActionType = plannerMod.PlanActionType;
});

function makeUI(budget = 4, food = 0) {
  const state    = makeState({ inventory: { hero: { food } } });
  const renderer = makeFakeRenderer();
  const els      = createElementsBag();
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  ui.enterPlanningMode('hero', budget, 0, { showPhaseModal: false });
  return { ui, state, els };
}

function addMoves(ui, count) {
  for (let i = 0; i < count; i++) {
    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: i, toRow: 0 });
  }
}

function planLength(ui) {
  return ui._unitPlans.get('hero1')?.length ?? 0;
}

// ── Plan cap ──────────────────────────────────────────────────────────────────

describe('plan action cap', () => {
  test('cap is ceil(1.5× (budget + food)) with no food', () => {
    const { ui } = makeUI(4, 0);  // cap = ceil(4 * 1.5) = 6
    addMoves(ui, 6);
    assert.equal(planLength(ui), 6);

    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 99, toRow: 0 });
    assert.equal(planLength(ui), 6, 'should not exceed cap');
  });

  test('cap includes food in the calculation', () => {
    // budget=4, food=2 → ceil((4+2)*1.5) = 9
    const { ui } = makeUI(4, 2);
    addMoves(ui, 9);
    assert.equal(planLength(ui), 9);

    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 99, toRow: 0 });
    assert.equal(planLength(ui), 9, 'should not exceed ceil(1.5 * (budget+food))');
  });

  test('cap with odd total rounds up', () => {
    // budget=3, food=0 → ceil(3*1.5) = 5
    const { ui } = makeUI(3, 0);
    addMoves(ui, 5);
    assert.equal(planLength(ui), 5);

    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 99, toRow: 0 });
    assert.equal(planLength(ui), 5, 'cap should be ceil(3*1.5) = 5');
  });

  test('free actions (USE_ITEM) do not count toward cap', () => {
    const { ui } = makeUI(4, 0);  // cap = 6
    addMoves(ui, 6);

    ui._addToPlan({ type: PlanActionType.USE_ITEM, entityId: 'hero1', item: 'potion' });
    assert.equal(planLength(ui), 7, 'free actions should bypass the cap');
  });

  test('free actions (EQUIP_WEAPON) do not count toward cap', () => {
    const { ui } = makeUI(4, 0);  // cap = 6
    addMoves(ui, 6);

    ui._addToPlan({ type: PlanActionType.EQUIP_WEAPON, entityId: 'hero1' });
    assert.equal(planLength(ui), 7, 'equip weapon should bypass the cap');
  });
});

// ── Toast warnings ────────────────────────────────────────────────────────────

describe('plan toast warnings', () => {
  test('toast shown when entering food consumption territory', () => {
    const { ui } = makeUI(3, 2);  // budget 3, food 2
    const toasts = [];
    ui._showPlanToast = (msg) => toasts.push(msg);

    addMoves(ui, 3); // within budget — no toast
    assert.equal(toasts.length, 0, 'no toast when within budget');

    // 4th action goes over budget but food covers it
    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 10, toRow: 0 });
    assert.ok(toasts.some(t => /food/i.test(t)),
      'should warn about food consumption');
  });

  test('toast shown when action may not execute (no food)', () => {
    const { ui } = makeUI(3, 0);  // budget 3, no food → cap = 5
    const toasts = [];
    ui._showPlanToast = (msg) => toasts.push(msg);

    addMoves(ui, 3);
    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 10, toRow: 0 });
    assert.ok(toasts.some(t => /may not execute/i.test(t)),
      'should warn action may not execute');
  });

  test('toast shown when plan hits the cap', () => {
    const { ui } = makeUI(4, 2);  // budget 4, food 2 → cap = ceil(6*1.5) = 9
    const toasts = [];
    ui._showPlanToast = (msg) => toasts.push(msg);

    addMoves(ui, 8);
    toasts.length = 0;

    // 9th action hits the cap
    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 20, toRow: 0 });
    assert.ok(toasts.length > 0, 'should show toast(s) at cap');
  });

  test('plan-full toast when trying to add beyond cap', () => {
    const { ui } = makeUI(4, 0);  // cap = 6
    const toasts = [];
    ui._showPlanToast = (msg) => toasts.push(msg);

    addMoves(ui, 6); // fill to cap
    toasts.length = 0;

    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 99, toRow: 0 });
    assert.ok(toasts.some(t => /full/i.test(t)),
      'should show plan-full toast when at cap');
    assert.equal(planLength(ui), 6, 'action should not be added');
  });
});
