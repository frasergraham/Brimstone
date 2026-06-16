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
//
// The UNDO button is only shown for the active selected unit. These tests
// assume a unit is selected via ui._selectedEntity before computing buckets.

describe('_computeLastActionHexes', () => {
  test('returns empty when no plans are queued', () => {
    const { ui } = makeUI();
    ui._selectedEntity = { id: 'h1' };
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('returns empty when not in planning mode', () => {
    const { ui } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._selectedEntity = { id: 'h1' };
    ui._planMode = false;
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('returns empty when plan is submitted', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 1, row: 2 } });
    ui._selectedEntity = { id: 'h1' };
    ui._planSubmitted = true;
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('returns empty when no unit is selected', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 3, row: 4 } });
    ui._selectedEntity = null;
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('returns empty when the selected unit is an enemy', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 3, row: 4 } });
    ui._selectedEntity = { id: 'h1' };
    ui._isEnemySelection = true;
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('returns empty when the selected unit has no queued plan', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h2', [{ type: PlanActionType.MOVE, entityId: 'h2' }]);
    setGhostPositions(renderer, { h2: { col: 1, row: 1 } });
    ui._selectedEntity = { id: 'h1' };
    assert.deepEqual(ui._computeLastActionHexes(), []);
  });

  test('selected unit with one action → one bucket at projected hex', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 3, row: 4 } });
    ui._selectedEntity = { id: 'h1' };

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].col, 3);
    assert.equal(buckets[0].row, 4);
    assert.deepEqual(buckets[0].entityIds, ['h1']);
  });

  test('selected unit with two actions → one bucket at final projected hex', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 3, toRow: 4 },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 5, toRow: 6 },
    ]);
    setGhostPositions(renderer, { h1: { col: 5, row: 6 } });
    ui._selectedEntity = { id: 'h1' };

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].col, 5);
    assert.equal(buckets[0].row, 6);
  });

  test('only the selected unit is returned even when other units have plans', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._unitPlans.set('h2', [{ type: PlanActionType.MOVE, entityId: 'h2' }]);
    setGhostPositions(renderer, {
      h1: { col: 1, row: 1 },
      h2: { col: 2, row: 2 },
    });
    ui._selectedEntity = { id: 'h2' };

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].col, 2);
    assert.equal(buckets[0].row, 2);
    assert.deepEqual(buckets[0].entityIds, ['h2']);
  });

  test('units converging on the same hex → bucket only for selected unit', () => {
    const { ui, renderer } = makeUI();
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    ui._unitPlans.set('h2', [{ type: PlanActionType.MOVE, entityId: 'h2' }]);
    setGhostPositions(renderer, {
      h1: { col: 4, row: 4 },
      h2: { col: 4, row: 4 },
    });
    ui._selectedEntity = { id: 'h1' };

    const buckets = ui._computeLastActionHexes();
    assert.equal(buckets.length, 1);
    assert.deepEqual(buckets[0].entityIds, ['h1']);
  });

  test('falls back to entity current position when ghost state is empty', () => {
    const { ui, renderer, state } = makeUI();
    state.entities = [{ id: 'h1', col: 7, row: 8, alive: true }];
    ui._unitPlans.set('h1', [{ type: PlanActionType.FORTIFY, entityId: 'h1' }]);
    renderer.planGhostSteps = null;
    ui._selectedEntity = { id: 'h1' };

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

// NOTE: this file previously asserted styles.css text (z-index ordering and
// pointer-events for #unit-stats-bar vs #undo-button-layer). CSS layering has
// no logic a unit test can exercise — those guarantees are covered by browser
// verification (verifier-browser skill) per CLAUDE.md Guideline 7.

// ── stable DOM across RAF ticks ──────────────────────────────────────────────
//
// _refreshUndoButtons runs every frame via requestAnimationFrame. Originally
// it did `layer.innerHTML = ''` and rebuilt each button — destroying the touch
// target mid-gesture on mobile, so the tap never produced a click. Keep the
// same DOM nodes across calls; only update their positions.

/** Spy that records appendChild / remove and lets the UI mutate a live child list. */
function makeLayerSpy(els) {
  const layer = els['undo-button-layer'];
  const kids  = [];
  layer.children = kids;
  layer.appendChild = (child) => {
    kids.push(child);
    child.remove = () => {
      const i = kids.indexOf(child);
      if (i >= 0) kids.splice(i, 1);
    };
  };
  // Stub out the plan-panel rect so the existing panel-suppression check
  // (sx >= panelLeft) doesn't filter every button out in tests.
  els['plan-panel'].getBoundingClientRect = () => ({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0,
  });
  return kids;
}

/** Minimal fake renderer.hexToCanvasPos that puts each hex at a unique spot. */
function installPositioning(renderer) {
  renderer.hexToCanvasPos = (col, row) => ({ x: 100 + col * 50, y: 100 + row * 50 });
}

describe('_refreshUndoButtons DOM stability', () => {
  test('reuses the same button element across repeated refreshes', () => {
    const { ui, renderer, els } = makeUI();
    const kids = makeLayerSpy(els);
    installPositioning(renderer);

    ui._selectedEntity = { id: 'h1' }; // UNDO only shows for the selected unit
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 3, row: 4 } });

    ui._refreshUndoButtons();
    assert.equal(kids.length, 1, 'first refresh creates the button');
    const btn = kids[0];
    assert.equal(btn.dataset.key, '3,4', 'button is keyed by hex');

    // Two more RAF-style refreshes — nothing changed.
    ui._refreshUndoButtons();
    ui._refreshUndoButtons();

    assert.equal(kids.length, 1, 'still exactly one button');
    assert.strictEqual(kids[0], btn,
      'same DOM node is reused — otherwise taps that span multiple frames are dropped on mobile');
  });

  test('updates position of an existing button when its hex moves (pan/zoom)', () => {
    const { ui, renderer, els } = makeUI();
    const kids = makeLayerSpy(els);
    let origin = { x: 100, y: 100 };
    renderer.hexToCanvasPos = () => ({ x: origin.x, y: origin.y });

    ui._selectedEntity = { id: 'h1' }; // UNDO only shows for the selected unit
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 3, row: 4 } });

    ui._refreshUndoButtons();
    const btn = kids[0];
    const before = { left: btn.style.left, top: btn.style.top };

    // Simulate a pan — canvas-space position changes.
    origin = { x: 180, y: 220 };
    ui._refreshUndoButtons();

    assert.strictEqual(kids[0], btn, 'same node');
    assert.notEqual(btn.style.left, before.left, 'left updated');
    assert.notEqual(btn.style.top,  before.top,  'top updated');
  });

  test('removes orphaned buttons when the planned hex changes', () => {
    const { ui, renderer, els } = makeUI();
    const kids = makeLayerSpy(els);
    installPositioning(renderer);

    ui._selectedEntity = { id: 'h1' }; // UNDO only shows for the selected unit
    ui._unitPlans.set('h1', [{ type: PlanActionType.MOVE, entityId: 'h1' }]);
    setGhostPositions(renderer, { h1: { col: 3, row: 4 } });
    ui._refreshUndoButtons();
    assert.equal(kids.length, 1);
    const first = kids[0];

    // Plan re-routes to a new hex → old bucket gone, new one appears.
    setGhostPositions(renderer, { h1: { col: 7, row: 2 } });
    ui._refreshUndoButtons();

    assert.equal(kids.length, 1, 'exactly one button at any time');
    assert.notStrictEqual(kids[0], first, 'orphan was removed, new node appended');
    assert.equal(kids[0].dataset.key, '7,2');
  });
});
