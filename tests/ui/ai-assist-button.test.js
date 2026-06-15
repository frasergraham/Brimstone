// Tests for the AI-assist planning button (debug "watch an AI play" mode).
//
// Covers the UI-layer behaviour:
//   - _syncAIAssistButton()  — visibility follows aiAssistEnabled + planning
//   - _fillAIAssistPlan()    — loads an AI plan into the per-unit plan queues
//
// No real DOM — the UIController is instantiated with the injected elements
// bag (see ./setup.js).

import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeRenderer,
  makeFakeElement,
  createElementsBag,
} from './setup.js';

const { fakeCanvas } = installGlobalMocks();

let UIController, GameState, PlanActionType;

before(async () => {
  const [uiMod, gameMod, plannerMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
    import('../../src/planner.js'),
  ]);
  UIController   = uiMod.UIController;
  GameState      = gameMod.GameState;
  PlanActionType = plannerMod.PlanActionType;
});

function makeUI() {
  const state    = new GameState(true, false);
  const renderer = makeFakeRenderer();
  const aiBtn    = makeFakeElement('plan-aiassist-btn');
  const els      = createElementsBag({
    'undo-button-layer': makeFakeElement('undo-button-layer'),
    'plan-aiassist-btn': aiBtn,
  });
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return { ui, state, renderer, aiBtn };
}

describe('_syncAIAssistButton', () => {
  test('button is hidden when AI assist is disabled', () => {
    const { ui, aiBtn } = makeUI();
    ui.aiAssistEnabled = false;
    ui.enterPlanningMode('hero', 5);
    assert.equal(aiBtn.style.display, 'none');
  });

  test('button is shown while planning when AI assist is enabled', () => {
    const { ui, aiBtn } = makeUI();
    ui.aiAssistEnabled = true;
    ui.enterPlanningMode('hero', 5);
    assert.equal(aiBtn.style.display, '');
  });

  test('button is hidden again after the plan is submitted', () => {
    const { ui, aiBtn } = makeUI();
    ui.aiAssistEnabled = true;
    ui.enterPlanningMode('hero', 5);
    ui.markPlanSubmitted();
    ui._syncAIAssistButton();
    assert.equal(aiBtn.style.display, 'none');
  });
});

describe('_fillAIAssistPlan', () => {
  test('loads the AI plan into per-unit queues for review', () => {
    const { ui, state } = makeUI();
    ui.aiAssistEnabled = true;
    ui.enterPlanningMode('hero', 5);

    const hero = state.hero;
    const plan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: hero.col + 1, toRow: hero.row },
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: hero.col + 2, toRow: hero.row },
    ];
    let requestedFaction = null;
    ui.onAIAssistRequest = (faction) => { requestedFaction = faction; return plan; };

    ui._fillAIAssistPlan();

    // Asks for the faction currently planning.
    assert.equal(requestedFaction, 'hero');
    // Both actions land under the hero's queue.
    assert.deepEqual([...ui._unitPlans.keys()], [hero.id]);
    assert.equal(ui._unitPlans.get(hero.id).length, 2);
  });

  test('replaces any previously queued actions', () => {
    const { ui, state } = makeUI();
    ui.aiAssistEnabled = true;
    ui.enterPlanningMode('hero', 5);

    // Pre-seed a stale queue.
    ui._unitPlans.set('stale-id', [{ type: PlanActionType.GUARD, entityId: 'stale-id' }]);

    const hero = state.hero;
    ui.onAIAssistRequest = () => [
      { type: PlanActionType.GUARD, entityId: hero.id },
    ];
    ui._fillAIAssistPlan();

    assert.ok(!ui._unitPlans.has('stale-id'), 'stale queue cleared');
    assert.deepEqual([...ui._unitPlans.keys()], [hero.id]);
  });

  test('empty AI plan leaves the queue untouched', () => {
    const { ui } = makeUI();
    ui.aiAssistEnabled = true;
    ui.enterPlanningMode('hero', 5);
    ui.onAIAssistRequest = () => [];

    ui._fillAIAssistPlan();
    assert.equal(ui._unitPlans.size, 0);
  });

  test('no-op once the plan is already submitted', () => {
    const { ui, state } = makeUI();
    ui.aiAssistEnabled = true;
    ui.enterPlanningMode('hero', 5);
    ui.markPlanSubmitted();

    let called = false;
    ui.onAIAssistRequest = () => { called = true; return [{ type: PlanActionType.GUARD, entityId: state.hero.id }]; };
    ui._fillAIAssistPlan();

    assert.equal(called, false);
    assert.equal(ui._unitPlans.size, 0);
  });
});

describe('autorun (_maybeAutorun)', () => {
  const tick = (ms) => new Promise(r => setTimeout(r, ms));

  test('entering planning fills then auto-submits the AI plan', async () => {
    const { ui, state } = makeUI();
    ui.aiAutorun = true;
    ui.aiAutorunDelay = 5;
    let submitted = null;
    ui.onPlanSubmit = (plan) => { submitted = plan; };
    ui.onAIAssistRequest = () => [{ type: PlanActionType.GUARD, entityId: state.hero.id }];

    ui.enterPlanningMode('hero', 5);
    // Filled synchronously on planning entry.
    assert.equal(ui._unitPlans.size, 1);
    assert.equal(submitted, null, 'not submitted yet — waits for the pacing delay');

    await tick(20);
    assert.ok(submitted, 'auto-submitted after the delay');
    assert.equal(submitted.length, 1);
  });

  test('does not autorun in tutorial mode', async () => {
    const { ui, state } = makeUI();
    ui.aiAutorun = true;
    ui.tutorialMode = true;
    ui.aiAutorunDelay = 5;
    let submitted = false;
    ui.onPlanSubmit = () => { submitted = true; };
    ui.onAIAssistRequest = () => [{ type: PlanActionType.GUARD, entityId: state.hero.id }];

    ui.enterPlanningMode('hero', 5);
    await tick(20);
    assert.equal(submitted, false);
    assert.equal(ui._unitPlans.size, 0);
  });

  test('exiting planning cancels a pending auto-submit', async () => {
    const { ui, state } = makeUI();
    ui.aiAutorun = true;
    ui.aiAutorunDelay = 30;
    let submitted = false;
    ui.onPlanSubmit = () => { submitted = true; };
    ui.onAIAssistRequest = () => [{ type: PlanActionType.GUARD, entityId: state.hero.id }];

    ui.enterPlanningMode('hero', 5);
    ui.exitPlanningMode();
    await tick(50);
    assert.equal(submitted, false, 'timer cleared on exit');
  });
});
