// Tests for plan panel state transitions.
//
// Verifies that entering planning mode shows the panel, submitting locks it
// with .plan-submitted, and exiting hides it — all via the injected element bag
// so no real DOM is needed.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeCanvas,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';

// Must run before any module import that touches document/canvas.
const { fakeCanvas } = installGlobalMocks();

let UIController, GameState;

before(async () => {
  const [uiMod, gameMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
});

function makeUI(elsOverrides = {}) {
  const state    = new GameState(true, false);
  const renderer = makeFakeRenderer();
  const els      = createElementsBag(elsOverrides);
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return { ui, state, els };
}

// ── enterPlanningMode ─────────────────────────────────────────────────────────

describe('enterPlanningMode', () => {
  test('shows plan panel (removes display:none)', () => {
    const { ui, els } = makeUI();
    els['plan-panel'].style.display = 'none';

    ui.enterPlanningMode('hero', 3);

    assert.equal(els['plan-panel'].style.display, '',
      'panel should be visible after entering planning mode');
  });

  test('removes plan-submitted class from panel', () => {
    const { ui, els } = makeUI();
    els['plan-panel'].classList.add('plan-submitted');

    ui.enterPlanningMode('hero', 3);

    assert.ok(!els['plan-panel']._classList.has('plan-submitted'),
      'plan-submitted class should be removed on new planning phase');
  });

  test('sets witch faction data attribute for witch planning', () => {
    const { ui, els } = makeUI();

    ui.enterPlanningMode('witch', 4);

    assert.equal(els['plan-panel'].dataset.witchMode, '1',
      'witch mode should set data-witch-mode="1"');
  });

  test('clears witch faction data for hero planning', () => {
    const { ui, els } = makeUI();
    els['plan-panel'].dataset.witchMode = '1'; // pre-set

    ui.enterPlanningMode('hero', 3);

    assert.equal(els['plan-panel'].dataset.witchMode, '',
      'hero planning should clear witch-mode');
  });

  test('sets _planFaction', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('witch', 4);
    assert.equal(ui._planFaction, 'witch');
  });

  test('sets _planBudget', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 5);
    assert.equal(ui._planBudget, 5);
  });

  test('clears previous plan', () => {
    const { ui } = makeUI();
    ui._plan = [{ type: 'move' }]; // pre-set dirty plan
    ui.enterPlanningMode('hero', 3);
    assert.deepEqual(ui._plan, []);
  });

  test('_planMode is true after entering', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 3);
    assert.equal(ui._planMode, true);
  });
});

// ── exitPlanningMode ──────────────────────────────────────────────────────────

describe('exitPlanningMode', () => {
  test('hides plan panel', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui.exitPlanningMode();
    assert.equal(els['plan-panel'].style.display, 'none',
      'panel should be hidden after exiting planning mode');
  });

  test('removes collapsed class', () => {
    const { ui, els } = makeUI();
    els['plan-panel'].classList.add('collapsed');
    ui.exitPlanningMode();
    assert.ok(!els['plan-panel']._classList.has('collapsed'),
      'collapsed class should be removed on exit');
  });

  test('_planMode is false after exiting', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui.exitPlanningMode();
    assert.equal(ui._planMode, false);
  });

  test('_planFaction is null after exiting', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui.exitPlanningMode();
    assert.equal(ui._planFaction, null);
  });

  test('plan queue is cleared', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._plan = [{ type: 'move' }];
    ui.exitPlanningMode();
    assert.deepEqual(ui._plan, []);
  });
});

// ── _doSubmitPlan ─────────────────────────────────────────────────────────────

describe('_doSubmitPlan', () => {
  test('adds plan-submitted class to panel', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._doSubmitPlan();
    assert.ok(els['plan-panel']._classList.has('plan-submitted'),
      'plan-submitted class should be added after submitting');
  });

  test('sets status text to waiting message', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._doSubmitPlan();
    assert.ok(
      els['plan-status'].textContent.includes('Waiting'),
      `status should say Waiting, got: "${els['plan-status'].textContent}"`,
    );
  });

  test('sets _planSubmitted to true', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._doSubmitPlan();
    assert.equal(ui._planSubmitted, true);
  });

  test('fires onPlanSubmit callback with plan copy', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._plan = [{ type: 'explore', entityId: 'h1' }];

    let received = null;
    ui.onPlanSubmit = plan => { received = plan; };

    ui._doSubmitPlan();

    assert.ok(received !== null, 'onPlanSubmit should have been called');
    assert.equal(received.length, 1, 'should pass the plan');
    assert.notStrictEqual(received, ui._plan, 'should pass a copy, not the live array');
  });

  test('double-submit is a no-op', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 3);

    let callCount = 0;
    ui.onPlanSubmit = () => { callCount++; };

    ui._doSubmitPlan();
    ui._doSubmitPlan(); // second call should be ignored

    assert.equal(callCount, 1, 'onPlanSubmit should only fire once');
  });

  test('marks local player as submitted in _players using playerId', () => {
    // Regression: player objects use `playerId` (not `id`), so the find must
    // use p.playerId.  Previously p.id was used, so the local player's row
    // never got the ✓ checkmark.
    const { ui } = makeUI();
    const myId = 'player-uuid-123';
    ui.myPlayerId = myId;
    ui._players = [
      { playerId: myId,           name: 'Alice', faction: 'hero',  isAI: false },
      { playerId: 'opponent-456', name: 'Bob',   faction: 'witch', isAI: false },
    ];

    ui.enterPlanningMode('hero', 3);
    ui._doSubmitPlan();

    const me = ui._players.find(p => p.playerId === myId);
    assert.equal(me._submitted, true,
      'local player entry should be marked _submitted=true after plan submission');

    const opponent = ui._players.find(p => p.playerId === 'opponent-456');
    assert.ok(!opponent._submitted,
      'opponent entry should remain un-submitted');
  });
});

// ── countdown timer ───────────────────────────────────────────────────────────

describe('countdown timer', () => {
  test('countdown element shown when timeoutMs > 0', () => {
    const { ui, els } = makeUI();
    els['plan-countdown'].style.display = 'none';

    ui.enterPlanningMode('hero', 3, 60000);

    assert.equal(els['plan-countdown'].style.display, '',
      'countdown should be visible when timeout is set');

    // Clean up interval
    ui._stopCountdown();
  });

  test('countdown not shown when timeoutMs is 0 (local mode)', () => {
    const { ui, els } = makeUI();
    els['plan-countdown'].style.display = 'none';

    ui.enterPlanningMode('hero', 3, 0);

    assert.equal(els['plan-countdown'].style.display, 'none',
      'countdown should remain hidden in local (no-timeout) mode');
  });

  test('_stopCountdown hides countdown element', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3, 60000);
    ui._stopCountdown();
    assert.equal(els['plan-countdown'].style.display, 'none',
      'countdown should be hidden after stop');
  });
});
