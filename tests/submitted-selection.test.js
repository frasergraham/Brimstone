// Tests for view-only unit selection in SUBMITTED mode.
//
// After submitting a plan, the player should still be able to click on any
// unit (own, ally, enemy) to inspect its stats — but no actions or planning
// should be possible.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobalMocks,
  createElementsBag,
  makeFakeRenderer,
} from './ui/setup.js';

const { fakeCanvas, _elements } = installGlobalMocks();

let UIController, GameState, createMinion;

before(async () => {
  const [uiMod, gameMod, entMod] = await Promise.all([
    import('../src/ui.js'),
    import('../src/game.js'),
    import('../src/entities.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
  createMinion = entMod.createMinion;
});

/** Build a UI fixture in SUBMITTED state (plan locked, waiting for opponent). */
function makeSubmittedUI() {
  const state    = new GameState(true, false);
  state.fogOfWar = 'none';
  const renderer = makeFakeRenderer();
  // Arc-disambiguation popup needs entity screen positions for the canvas overlay
  renderer.getEntityScreenPositions = () => [];
  const els      = createElementsBag();
  Object.assign(_elements, els);
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false);

  // Enter planning then submit — mirrors the real SUBMITTED flow
  ui.enterPlanningMode('hero', 3);
  ui.markPlanSubmitted();

  return { ui, state, renderer };
}

// ── Single unit selection ──────────────────────────────────────────────────

describe('SUBMITTED mode view-only selection', () => {
  test('clicking own unit selects it as view-only', () => {
    const { ui, state } = makeSubmittedUI();
    const hero = state.entities.find(e => e.owner === 'hero' && e.alive);
    assert.ok(hero, 'should have a living hero entity');

    ui._handleViewOnlyClick({ col: hero.col, row: hero.row });

    assert.equal(ui._selectedEntity, hero, 'own unit should be selected');
    assert.equal(ui._isEnemySelection, true, 'should be view-only (enemy-style) selection');
    assert.deepEqual(ui._validActions, [], 'no valid actions in view-only');
    assert.equal(ui._awaitingTarget, null, 'no awaiting target');
  });

  test('clicking enemy unit selects it as view-only', () => {
    const { ui, state } = makeSubmittedUI();
    const witch = state.entities.find(e => e.owner === 'witch' && e.alive);
    assert.ok(witch, 'should have a living witch entity');

    ui._handleViewOnlyClick({ col: witch.col, row: witch.row });

    assert.equal(ui._selectedEntity, witch, 'enemy should be selected');
    assert.equal(ui._isEnemySelection, true, 'should be view-only selection');
    assert.deepEqual(ui._validActions, [], 'no valid actions');
  });

  test('sets renderer selectedHex and selectedEntityId', () => {
    const { ui, state, renderer } = makeSubmittedUI();
    const hero = state.entities.find(e => e.owner === 'hero' && e.alive);

    ui._handleViewOnlyClick({ col: hero.col, row: hero.row });

    assert.deepEqual(renderer.selectedHex, { col: hero.col, row: hero.row });
    assert.equal(renderer.selectedEntityId, hero.id);
  });

  test('clicking already-selected entity hex deselects', () => {
    const { ui, state } = makeSubmittedUI();
    const hero = state.entities.find(e => e.owner === 'hero' && e.alive);

    ui._handleViewOnlyClick({ col: hero.col, row: hero.row });
    assert.equal(ui._selectedEntity, hero);

    // Second click on same hex → deselect
    ui._handleViewOnlyClick({ col: hero.col, row: hero.row });
    assert.equal(ui._selectedEntity, null, 'should deselect on second tap');
  });

  test('clicking empty hex shows tile info only', () => {
    const { ui, state } = makeSubmittedUI();
    const occupied = new Set(
      state.entities.filter(e => e.alive).map(e => `${e.col},${e.row}`)
    );
    let emptyHex = null;
    for (const [key] of state.tiles) {
      if (!occupied.has(key)) {
        const [c, r] = key.split(',').map(Number);
        emptyHex = { col: c, row: r };
        break;
      }
    }
    assert.ok(emptyHex, 'should find an empty hex');

    ui._handleViewOnlyClick(emptyHex);

    assert.equal(ui._selectedEntity, null, 'no entity selected');
    assert.deepEqual(ui._selectedTile, emptyHex, 'tile info should be set');
  });
});

// ── Multiple units on same hex ─────────────────────────────────────────────

describe('SUBMITTED mode multi-unit picker', () => {
  test('multiple units on hex trigger picker popup', () => {
    const { ui, state } = makeSubmittedUI();
    const witch = state.entities.find(e => e.owner === 'witch' && e.alive);
    assert.ok(witch);

    // Place a second minion on the witch's hex
    const minion = createMinion(witch.col, witch.row);
    state.entities.push(minion);

    ui._handleViewOnlyClick({ col: witch.col, row: witch.row });

    assert.ok(ui._pendingEnemyPick, 'should set _pendingEnemyPick for disambiguation');
    assert.equal(ui._pendingEnemyPick.units.length, 2, 'picker should have 2 units');
    assert.equal(ui._popupVisible, true, 'popup should be visible');
  });
});

// ── Integration with _onClick guard ────────────────────────────────────────

describe('SUBMITTED mode _onClick integration', () => {
  test('_planSubmitted guard routes to view-only selection', () => {
    const { ui, state } = makeSubmittedUI();
    const witch = state.entities.find(e => e.owner === 'witch' && e.alive);
    assert.ok(witch);

    // Verify _planMode and _planSubmitted are set (the normal SUBMITTED path)
    assert.equal(ui._planMode, true);
    assert.equal(ui._planSubmitted, true);

    // Directly call _handleViewOnlyClick as the guard would
    ui._handleViewOnlyClick({ col: witch.col, row: witch.row });

    assert.equal(ui._selectedEntity, witch);
    assert.equal(ui._isEnemySelection, true);
  });
});
