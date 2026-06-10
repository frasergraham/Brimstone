// Tests for the in-planning "replay last round" button.
//
// The button lets the player re-watch the previous round's resolution while
// mid-planning (offline SP / campaign / hot-seat) and return to their
// in-progress plan. main.js drives the flow, but the two UI contracts it
// depends on live in ui.js and are exercised here:
//   1. enterPlanningMode shows/hides #replay-turn-btn based on _hasReplayHistory.
//   2. The plan-preservation handshake (snapshot _unitPlans → exit → enter →
//      restore + markPlanSubmitted) survives an exit/enter cycle intact.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
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

// ── Button visibility gating ──────────────────────────────────────────────────

describe('replay-last-round button visibility', () => {
  test('shown when there is replay history', () => {
    const { ui, els } = makeUI();
    els['replay-turn-btn'].style.display = 'none';

    ui._hasReplayHistory = true;
    ui.enterPlanningMode('hero', 3);

    assert.equal(els['replay-turn-btn'].style.display, '',
      'button should be visible when history exists (e.g. after resuming a save)');
  });

  test('hidden when there is no replay history', () => {
    const { ui, els } = makeUI();

    ui._hasReplayHistory = false;
    ui.enterPlanningMode('hero', 3);

    assert.equal(els['replay-turn-btn'].style.display, 'none',
      'button should stay hidden on a fresh round-1 plan with no history');
  });
});

// ── Plan-preservation handshake ────────────────────────────────────────────────

describe('replay-last-round preserves the in-progress plan', () => {
  test('snapshot → exit → enter → restore keeps the plan and submitted lock', () => {
    const { ui, els } = makeUI();

    // Player is mid-plan: a queued move for one unit, and they've already locked
    // it in (the worst case to preserve across a re-watch).
    ui._hasReplayHistory = true;
    ui.enterPlanningMode('hero', 3);
    ui._unitPlans.set('unit-1', [{ type: 'MOVE', entityId: 'unit-1', col: 2, row: 3 }]);
    ui.markPlanSubmitted();

    // The handshake main.js performs around the inline replay.
    const savedPlans   = new Map(ui._unitPlans);
    const wasSubmitted  = ui._planSubmitted;
    const savedFaction  = ui._planFaction;
    const savedBudget   = ui._planBudget;

    ui.exitPlanningMode();
    // exitPlanningMode clears the queue — without restoration the plan is lost.
    assert.equal(ui._unitPlans.size, 0, 'exit clears the live plan queue');

    ui.enterPlanningMode(savedFaction, savedBudget);
    ui._unitPlans = savedPlans;
    if (wasSubmitted) ui.markPlanSubmitted();

    // Plan restored verbatim, same faction, still locked.
    assert.equal(ui._planFaction, 'hero', 'planning faction restored');
    assert.deepEqual(ui._unitPlans.get('unit-1'),
      [{ type: 'MOVE', entityId: 'unit-1', col: 2, row: 3 }],
      'queued action restored intact');
    assert.equal(ui._planSubmitted, true, 'submitted lock restored');
    assert.ok(els['plan-panel']._classList.has('plan-submitted'),
      'panel re-shows the submitted state');
  });
});
