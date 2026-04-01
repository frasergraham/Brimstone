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
    ui._unitPlans = new Map([['e1', [{ type: 'move', entityId: 'e1' }]]]); // pre-set dirty plan
    ui.enterPlanningMode('hero', 3);
    assert.equal(ui._unitPlans.size, 0);
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
    ui._unitPlans = new Map([['e1', [{ type: 'move', entityId: 'e1' }]]]);
    ui.exitPlanningMode();
    assert.equal(ui._unitPlans.size, 0);
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

  test('fires onPlanSubmit callback with interleaved plan', () => {
    const { ui } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._unitPlans = new Map([['h1', [{ type: 'explore', entityId: 'h1' }]]]);

    let received = null;
    ui.onPlanSubmit = plan => { received = plan; };

    ui._doSubmitPlan();

    assert.ok(received !== null, 'onPlanSubmit should have been called');
    assert.equal(received.length, 1, 'should pass the plan');
    assert.equal(received[0].entityId, 'h1');
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

// ── submit button progress bar ────────────────────────────────────────────────

describe('submit button progress bar', () => {
  test('sets --progress on submit button when timeoutMs > 0', () => {
    const { ui, els } = makeUI();

    ui.enterPlanningMode('hero', 3, 60000);

    const progress = els['plan-submit-btn'].style._props['--progress'];
    assert.ok(progress !== undefined,
      '--progress should be set on submit button when timeout is active');

    ui._stopCountdown();
  });

  test('submit button text shows mm:ss when countdown active', () => {
    const { ui, els } = makeUI();

    ui.enterPlanningMode('hero', 3, 60000);

    assert.ok(els['plan-submit-btn'].textContent.includes(':'),
      `submit button should show mm:ss, got: "${els['plan-submit-btn'].textContent}"`);

    ui._stopCountdown();
  });

  test('no --progress set when timeoutMs is 0 (local mode)', () => {
    const { ui, els } = makeUI();

    ui.enterPlanningMode('hero', 3, 0);

    const progress = els['plan-submit-btn'].style._props['--progress'];
    assert.equal(progress, undefined,
      '--progress should not be set in local (no-timeout) mode');
  });

  test('sets --progress on header submit button', () => {
    const { ui, els } = makeUI();

    ui.enterPlanningMode('hero', 3, 60000);

    const progress = els['end-turn-btn'].style._props['--progress'];
    assert.ok(progress !== undefined,
      '--progress should be set on header submit button when timeout is active');

    ui._stopCountdown();
  });

  test('_stopCountdown resets submit button to default', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3, 60000);
    ui._stopCountdown();

    assert.equal(els['plan-submit-btn'].style._props['--progress'], undefined,
      '--progress should be removed after stop');
    assert.equal(els['plan-submit-btn'].textContent, '\u2713 Submit',
      'button text should reset to default');
    assert.ok(!els['plan-submit-btn']._classList.has('countdown-urgent'),
      'urgent class should be removed');
  });

  test('_stopCountdown removes --progress from floating button', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3, 60000);
    ui._stopCountdown();

    assert.equal(els['end-turn-btn'].style._props['--progress'], undefined,
      '--progress should be removed from floating button after stop');
  });

  test('_doSubmitPlan resets progress bar', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3, 60000);
    ui._doSubmitPlan();

    assert.equal(els['plan-submit-btn'].style._props['--progress'], undefined,
      '--progress should be removed after submitting');
  });
});

// ── grace dialog ──────────────────────────────────────────────────────────────

describe('grace dialog', () => {
  test('_showGraceDialog makes dialog visible', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);

    ui._showGraceDialog(5000);

    assert.ok(els['grace-dialog']._classList.has('visible'),
      'grace dialog should have visible class');

    ui._dismissGraceDialog();
  });

  test('_dismissGraceDialog hides dialog', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._showGraceDialog(5000);
    ui._dismissGraceDialog();

    assert.ok(!els['grace-dialog']._classList.has('visible'),
      'grace dialog should not have visible class after dismiss');
  });

  test('_showGraceDialog is no-op when already submitted', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._doSubmitPlan();

    ui._showGraceDialog(5000);

    assert.ok(!els['grace-dialog']._classList.has('visible'),
      'grace dialog should not show when plan is already submitted');
  });

  test('_stopCountdown dismisses grace dialog', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._showGraceDialog(5000);
    ui._stopCountdown();

    assert.ok(!els['grace-dialog']._classList.has('visible'),
      'grace dialog should be dismissed by _stopCountdown');
    assert.equal(ui._graceActive, false);
  });

  test('exitPlanningMode cleans up grace dialog', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui._showGraceDialog(5000);
    ui.exitPlanningMode();

    assert.ok(!els['grace-dialog']._classList.has('visible'),
      'grace dialog should be dismissed on exit');
  });
});

// ── header submit button ────────────────────────────────────────────────────

describe('header submit button', () => {
  test('end-turn-btn gets planning-active class during planning', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);

    assert.ok(els['end-turn-btn']._classList.has('planning-active'),
      'end-turn-btn should have planning-active class in planning mode');

    ui._stopCountdown();
  });

  test('planning-active class removed after exiting planning', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3);
    ui.exitPlanningMode();

    assert.ok(!els['end-turn-btn']._classList.has('planning-active'),
      'planning-active should be removed after exit');
  });

  test('plan-open class set when panel is expanded', () => {
    const { ui, els } = makeUI();
    // Simulate expanded panel (visible and not collapsed)
    els['plan-panel'].style.display = '';
    els['plan-panel'].classList.remove('collapsed');

    ui.enterPlanningMode('hero', 3);

    assert.ok(els['end-turn-btn']._classList.has('plan-open'),
      'plan-open should be set when panel is expanded');

    ui._stopCountdown();
  });

  test('plan-open class not set when panel is collapsed', () => {
    const { ui, els } = makeUI();
    // Simulate collapsed panel
    els['plan-panel'].style.display = '';
    els['plan-panel'].classList.add('collapsed');

    ui.enterPlanningMode('hero', 3);
    // enterPlanningMode may uncollapse on wide screens, so force collapsed
    els['plan-panel'].classList.add('collapsed');
    ui._renderEndTurnBtn();

    assert.ok(!els['end-turn-btn']._classList.has('plan-open'),
      'plan-open should not be set when panel is collapsed');

    ui._stopCountdown();
  });
});
