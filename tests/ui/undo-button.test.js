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

// ── z-order + hit-test guarantees ────────────────────────────────────────────
//
// The unit-stats-bar sits above the undo-button-layer so the deselect (✕)
// button isn't covered by a floating UNDO anchored near the top of the map.
// But the bar's chrome must itself be pointer-events:none, with its buttons
// re-enabling pointer-events — otherwise the bar would swallow taps meant for
// an UNDO button it happens to cover on mobile (where the bar spans ~92vw).

describe('unit-stats-bar layering vs #undo-button-layer', () => {
  async function readStyles() {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(__dirname, '..', '..', 'styles.css'), 'utf8');
  }

  function blockFor(css, selector) {
    const re = new RegExp(`${selector.replace(/[.#]/g, '\\$&')}\\s*\\{[^}]*\\}`);
    const m = css.match(re);
    assert.ok(m, `expected a ${selector} block in styles.css`);
    return m[0];
  }

  test('#unit-stats-bar z-index is above #undo-button-layer', async () => {
    const css  = await readStyles();
    const barZ  = Number((blockFor(css, '#unit-stats-bar'    ).match(/z-index:\s*(\d+)/) || [])[1]);
    const undoZ = Number((blockFor(css, '#undo-button-layer' ).match(/z-index:\s*(\d+)/) || [])[1]);
    assert.ok(Number.isFinite(barZ) && Number.isFinite(undoZ),
      'both blocks must set z-index');
    assert.ok(barZ > undoZ,
      `#unit-stats-bar z-index (${barZ}) must be above #undo-button-layer (${undoZ})`);
  });

  test('#unit-stats-bar is pointer-events:none so UNDO stays clickable underneath', async () => {
    const css = await readStyles();
    const bar = blockFor(css, '#unit-stats-bar');
    assert.match(bar, /pointer-events:\s*none/,
      'bar chrome must not capture taps — otherwise it swallows UNDO clicks it visually covers');
  });

  test('.usb-deselect-btn and .usb-cycle-btn re-enable pointer-events', async () => {
    const css = await readStyles();
    assert.match(blockFor(css, '.usb-deselect-btn'), /pointer-events:\s*auto/,
      'deselect button must opt back in to hit testing');
    assert.match(blockFor(css, '.usb-cycle-btn'), /pointer-events:\s*auto/,
      'cycle buttons must opt back in to hit testing');
  });
});
