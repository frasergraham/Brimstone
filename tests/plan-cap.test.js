// Tests for plan action cap (1.5× budget, but never less than budget + food)
// and toast warnings.

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
  const state    = makeState({ inventory: { shared: { food } } });
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
  test('cap is 1.5× budget when no food (rounded up)', () => {
    const { ui } = makeUI(4, 0);  // cap = max(ceil(4*1.5), 4+0) = 6
    addMoves(ui, 6);
    assert.equal(planLength(ui), 6);

    // 7th should be rejected
    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 99, toRow: 0 });
    assert.equal(planLength(ui), 6, 'should not exceed cap');
  });

  test('cap with odd budget rounds up', () => {
    const { ui } = makeUI(3, 0);  // cap = max(ceil(3*1.5), 3) = 5
    addMoves(ui, 5);
    assert.equal(planLength(ui), 5);

    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 99, toRow: 0 });
    assert.equal(planLength(ui), 5, 'cap should be ceil(3*1.5) = 5');
  });

  test('cap extends to budget + food when food exceeds 1.5× buffer', () => {
    // budget=4, food=5 → max(ceil(6), 4+5) = max(6, 9) = 9
    const { ui } = makeUI(4, 5);
    addMoves(ui, 9);
    assert.equal(planLength(ui), 9, 'should allow budget + food actions');

    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 99, toRow: 0 });
    assert.equal(planLength(ui), 9, 'should not exceed budget + food');
  });

  test('cap uses 1.5× when food is small', () => {
    // budget=4, food=1 → max(ceil(6), 4+1) = max(6, 5) = 6
    const { ui } = makeUI(4, 1);
    addMoves(ui, 6);
    assert.equal(planLength(ui), 6);

    ui._addToPlan({ type: PlanActionType.MOVE, entityId: 'hero1', toCol: 99, toRow: 0 });
    assert.equal(planLength(ui), 6, '1.5× cap should apply when food is small');
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
    const { ui } = makeUI(4, 10);  // budget 4, food 10 → cap = max(6, 14) = 14
    const toasts = [];
    ui._showPlanToast = (msg) => toasts.push(msg);

    addMoves(ui, 13);
    toasts.length = 0;

    // 14th action hits the cap
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
