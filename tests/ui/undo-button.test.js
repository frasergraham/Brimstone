// Tests for the floating UNDO button feature in planning mode.
//
// Covers the pure helpers:
//   - _computeLastActionHexes()  — groups units by their projected final hex
//   - _undoLastActionFor()       — pops a unit's last queued action
//   - _showUndoDisambig() flow   — triggers the arc popup when units collide
//
// No real DOM — the UIController is instantiated with the injected elements
// bag, and the renderer's ghost-step positions are faked directly.

import { describe, test, before } from 'node:test';
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
  const els      = createElementsBag({
    'undo-button-layer': makeFakeElement('undo-button-layer'),
  });
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  ui.enterPlanningMode('hero', 5);
  return { ui, state, renderer, els };
}

/** Build a ghost-step stub with a final-positions map. */
function setGhostPositions(renderer, positionsMap) {
  const positions = new Map(Object.entries(positionsMap));
  renderer.planGhostSteps = [{ positions, action: {}, arrow: null }];
}

// ── _computeLastActionHexes ──────────────────────────────────────────────────

describe('_computeLastActionHexes', () => {
  test('returns empty when no plans are queued', () => {
    const { ui } = makeUI();
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('returns empty when not in planning mode', () => {
    const { ui } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._planMode = false;
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('returns empty when plan is submitted', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 1, row: 2 } });
    ui._planSubmitted = true;
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('one unit with one action → one bucket at projected hex', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 3, row: 4 } });

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].col, 3);
    assert.equal(buckets[0].row, 4);
    assert.deepEqual(buckets[0].entityIds, ['h1']);
  });

  test('one unit with two actions → one bucket at final projected hex', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 3, toRow: 4 },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 5, toRow: 6 },
    ]);
    setGhostPositions(renderer, { h1: { col: 5, row: 6 } });

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].col, 5);
    assert.equal(buckets[0].row, 6);
  });

  test('two units with distinct end hexes → two separate buckets', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._unitPlans.set('h2', [{ type: PlanActionType.MOVE, entityId: 'h2' }]);
    setGhostPositions(renderer, {
      h1: { col: 1, row: 1 },
      h2: { col: 2, row: 2 },
    });

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 2);
    const byKey = new Map(buckets.map(b => [`${b.col},${b.row}`, b]));
    assert.deepEqual(byKey.get('1,1').entityIds, ['h1']);
    assert.deepEqual(byKey.get('2,2').entityIds, ['h2']);
  });

  test('two units converging on same hex → one bucket with both IDs', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._unitPlans.set('h2', [{ type: PlanActionType.MOVE, entityId: 'h2' }]);
    setGhostPositions(renderer, {
      h1: { col: 4, row: 4 },
      h2: { col: 4, row: 4 },
    });

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].col, 4);
    assert.equal(buckets[0].row, 4);
    assert.deepEqual(buckets[0].entityIds.sort(), ['h1', 'h2']);
  });

  test('falls back to entity current position when ghost state is empty', () => {
    const { ui, renderer, state } = makeUI();
    state.entities = [{ id: 'h1', col: 7, row: 8, alive: true }];
    ui._unitPlans.set('h1', [{ type: PlanActionType.FORTIFY, entityId: 'h1' }]);
    renderer.planGhostSteps = null;

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].col, 7);
    assert.equal(buckets[0].row, 8);
  });
});

// ── _undoLastActionFor ───────────────────────────────────────────────────────

describe('_undoLastActionFor', () => {
  test('pops the last action from the queue', () => {
    const { ui } = makeUI();
    ui._unitPlans.set('h1', [
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 2 },
    ]);

    ui._undoLastActionFor('h1');

    const queue = ui._unitPlans.get('h1');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].toCol, 1);
  });

  test('deletes the queue entry when the last action is removed', () => {
    const { ui } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._undoLastActionFor('h1');
    assert.equal(ui._unitPlans.has('h1'), false,
      'empty queue should be purged from _unitPlans');
  });

  test('clears the current selection', () => {
    const { ui } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._selectedEntity = { id: 'h1' };
    ui._undoLastActionFor('h1');
    assert.equal(ui._selectedEntity, null,
      'undo should deselect the unit per spec');
  });

  test('is a no-op when the entity has no plan', () => {
    const { ui } = makeUI();
    // Should not throw.
    ui._undoLastActionFor('ghost-entity');
    assert.equal(ui._unitPlans.size, 0);
  });
});

// ── disambiguation dispatch ──────────────────────────────────────────────────

describe('_onUndoButtonClicked', () => {
  test('single entity in bucket → undoes immediately (no popup)', () => {
    const { ui } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);

    let shownPopup = false;
    ui._showArcDisambig = () => { shownPopup = true; };

    ui._onUndoButtonClicked({ col: 0, row: 0, entityIds: ['h1'] });

    assert.equal(shownPopup, false, 'should not open disambig for a single unit');
    assert.equal(ui._unitPlans.has('h1'), false);
  });

  test('multiple entities in bucket → opens disambig popup', () => {
    const { ui, state } = makeUI();
    state.entities = [
      { id: 'h1', col: 4, row: 4, alive: true, type: 'hero', displayName: 'Hero', hp: 10, maxHp: 10 },
      { id: 'h2', col: 4, row: 4, alive: true, type: 'survivor', displayName: 'S', hp: 8, maxHp: 8 },
    ];
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._unitPlans.set('h2', [{ type: PlanActionType.MOVE, entityId: 'h2' }]);

    let calledWith = null;
    ui._showArcDisambig = (units, tag, hex) => {
      calledWith = { units, tag, hex };
    };

    ui._onUndoButtonClicked({ col: 4, row: 4, entityIds: ['h1', 'h2'] });

    assert.ok(calledWith, 'disambig popup should have been shown');
    assert.equal(calledWith.tag, 'undo_pick');
    assert.equal(calledWith.hex.col, 4);
    assert.equal(calledWith.hex.row, 4);
    assert.equal(calledWith.units.length, 2);
    // Undo is staged — the plans are NOT yet mutated
    assert.equal(ui._unitPlans.get('h1').length, 1);
    assert.equal(ui._unitPlans.get('h2').length, 1);
    // _pendingUndoPick should be seeded so the popup click handler can route it
    assert.deepEqual(ui._pendingUndoPick.entityIds.sort(), ['h1', 'h2']);
  });
});

// ── undo_pick handler (arc popup button click) ───────────────────────────────

describe('_handleActionButton: undo_pick', () => {
  test('pops the last action for the clicked portrait', () => {
    const { ui } = makeUI();
    ui._unitPlans.set('h1', [
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 2 },
    ]);
    ui._unitPlans.set('h2', [{ type: PlanActionType.MOVE, entityId: 'h2' }]);
    ui._pendingUndoPick = { entityIds: ['h1', 'h2'] };

    const btn = { dataset: { action: 'undo_pick', unitId: 'h1' } };
    ui._handleActionButton(btn);

    assert.equal(ui._unitPlans.get('h1').length, 1,
      'only the targeted unit has an action popped');
    assert.equal(ui._unitPlans.get('h2').length, 1,
      'other unit in the bucket is untouched');
    assert.equal(ui._pendingUndoPick, null, 'pending pick should be cleared');
  });
});

// ── overlap suppression ──────────────────────────────────────────────────────
//
// The undo-button-layer sits at z-index 55, well above the unit-stats-bar
// (z-index 20). When a unit's planned final hex is near the top-center of the
// screen, the floating UNDO button can cover the bar's deselect (✕) button and
// swallow taps. The renderer skips any undo button whose computed anchor
// overlaps the visible bar — this keeps the deselect button reachable.

/** Install a minimal fake layer that records appended buttons. */
function spyOnLayer(els) {
  const appended = [];
  const layer = els['undo-button-layer'];
  layer.appendChild = (btn) => { appended.push(btn); };
  // innerHTML clear should not blow away our spy; resetting it is a no-op here.
  return appended;
}

/** Stub a rect on a fake element. */
function setRect(el, rect) {
  el.getBoundingClientRect = () => rect;
}

describe('_refreshUndoButtons overlap suppression', () => {
  test('skips buttons whose anchor would overlap the visible unit-stats-bar', () => {
    const { ui, renderer, els } = makeUI();
    const appended = spyOnLayer(els);

    // Canvas fills the viewport.
    setRect(fakeCanvas, { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });

    // Unit-stats-bar visible at the top-center of the viewport.
    const bar = els['unit-stats-bar'];
    bar.style.display = 'flex';
    setRect(bar, { left: 200, top: 8, right: 600, bottom: 68, width: 400, height: 60 });

    // Plan panel hidden (no overlap from that side).
    setRect(els['plan-panel'], { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

    // Projected final hex sits directly beneath the bar → undo anchor lands inside it.
    // sx = 0 + 400*1 = 400 (centered), sy = 0 + 60 - 30*0.85 ≈ 34.5 → within bar rect (8..68).
    renderer.hexToCanvasPos = () => ({ x: 400, y: 60 });
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 5, row: 1 } });

    ui._refreshUndoButtons();

    assert.equal(appended.length, 0,
      'button overlapping the deselect bar must be suppressed');
  });

  test('still draws buttons whose anchor falls outside the bar', () => {
    const { ui, renderer, els } = makeUI();
    const appended = spyOnLayer(els);

    setRect(fakeCanvas, { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });

    const bar = els['unit-stats-bar'];
    bar.style.display = 'flex';
    setRect(bar, { left: 200, top: 8, right: 600, bottom: 68, width: 400, height: 60 });

    setRect(els['plan-panel'], { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

    // Hex in the middle of the canvas — well below the bar.
    renderer.hexToCanvasPos = () => ({ x: 400, y: 300 });
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 5, row: 5 } });

    ui._refreshUndoButtons();

    assert.equal(appended.length, 1,
      'button below the bar should still render');
  });

  test('ignores the bar when it is hidden (display:none)', () => {
    const { ui, renderer, els } = makeUI();
    const appended = spyOnLayer(els);

    setRect(fakeCanvas, { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });

    // Bar is hidden — its rect should not suppress buttons even if it overlaps.
    const bar = els['unit-stats-bar'];
    bar.style.display = 'none';
    setRect(bar, { left: 200, top: 8, right: 600, bottom: 68, width: 400, height: 60 });

    setRect(els['plan-panel'], { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

    renderer.hexToCanvasPos = () => ({ x: 400, y: 60 });
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 5, row: 1 } });

    ui._refreshUndoButtons();

    assert.equal(appended.length, 1,
      'button should render when the bar is not visible');
  });
});
