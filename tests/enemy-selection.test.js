// Tests for enemy unit view-only selection.
//
// When no friendly unit occupies a hex, clicking an enemy unit should select it
// for stats inspection (stats bar visible) without enabling any actions.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobalMocks,
  createElementsBag,
  makeFakeRenderer,
  makeFakeCanvas,
} from './ui/setup.js';

const { fakeCanvas, _elements } = installGlobalMocks();

let UIController, GameState;

before(async () => {
  const [uiMod, gameMod] = await Promise.all([
    import('../src/ui.js'),
    import('../src/game.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
});

function makeUI() {
  const state    = new GameState(true, false);
  state.fogOfWar = false;  // disable fog so enemies are always visible in tests
  const renderer = makeFakeRenderer();
  const els      = createElementsBag();
  Object.assign(_elements, els);
  const redraw   = () => {};
  const ui = new UIController(fakeCanvas, state, renderer, null, redraw, null, false);
  return { ui, state, renderer };
}

// ── Enemy selection basics ──────────────────────────────────────────────────

describe('enemy unit view-only selection', () => {
  test('selecting an enemy unit sets _selectedEntity and _isEnemySelection', () => {
    const { ui, state } = makeUI();
    // Find a witch-owned entity (the witch itself)
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    assert.ok(enemy, 'state should have a living witch-faction entity');

    ui._selectEnemyEntity(enemy);

    assert.equal(ui._selectedEntity, enemy, 'enemy should be selected');
    assert.equal(ui._isEnemySelection, true, 'flag should indicate enemy selection');
  });

  test('enemy selection produces no valid actions', () => {
    const { ui, state } = makeUI();
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    ui._selectEnemyEntity(enemy);

    assert.deepEqual(ui._validActions, [], 'no actions for enemy units');
    assert.equal(ui._awaitingTarget, null, 'no awaiting target for enemy units');
  });

  test('enemy selection sets renderer selectedHex and selectedEntityId', () => {
    const { ui, state, renderer } = makeUI();
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    ui._selectEnemyEntity(enemy);

    assert.deepEqual(renderer.selectedHex, { col: enemy.col, row: enemy.row });
    assert.equal(renderer.selectedEntityId, enemy.id);
  });

  test('enemy selection clears highlight hexes', () => {
    const { ui, state, renderer } = makeUI();
    renderer.highlightHexes = [{ col: 0, row: 0 }];
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    ui._selectEnemyEntity(enemy);

    assert.deepEqual(renderer.highlightHexes, [], 'highlights should be empty');
  });

  test('_clearSelection resets _isEnemySelection', () => {
    const { ui, state } = makeUI();
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    ui._selectEnemyEntity(enemy);
    assert.equal(ui._isEnemySelection, true);

    ui._clearSelection();
    assert.equal(ui._isEnemySelection, false);
    assert.equal(ui._selectedEntity, null);
  });

  test('_selectEntity resets _isEnemySelection flag', () => {
    const { ui, state } = makeUI();
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    ui._selectEnemyEntity(enemy);
    assert.equal(ui._isEnemySelection, true);

    // Now select a friendly unit
    const friendly = state.entities.find(e => e.owner === 'hero' && e.alive);
    assert.ok(friendly, 'state should have a living hero-faction entity');
    ui._selectEntity(friendly);

    assert.equal(ui._isEnemySelection, false, 'friendly selection clears enemy flag');
    assert.equal(ui._selectedEntity, friendly);
  });
});

// ── _handleSelection two-pass logic ─────────────────────────────────────────

describe('_handleSelection enemy fallback', () => {
  test('clicking hex with only enemy selects enemy entity', () => {
    const { ui, state } = makeUI();
    // state.activePlayer is 'hero', so witch entities are enemies
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    assert.ok(enemy);

    // Ensure no friendly entities share this hex
    const friendliesOnHex = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.col === enemy.col && e.row === enemy.row
    );
    assert.equal(friendliesOnHex.length, 0, 'no friendlies should be on enemy hex');

    ui._handleSelection({ col: enemy.col, row: enemy.row });

    assert.equal(ui._selectedEntity, enemy, 'enemy entity should be selected');
    assert.equal(ui._isEnemySelection, true);
    assert.deepEqual(ui._validActions, []);
  });

  test('clicking hex with friendly unit does not select enemy even if present', () => {
    const { ui, state } = makeUI();
    const hero = state.entities.find(e => e.owner === 'hero' && e.type === 'hero');
    assert.ok(hero);

    // Place a witch minion on the hero's hex
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    enemy.col = hero.col;
    enemy.row = hero.row;

    ui._handleSelection({ col: hero.col, row: hero.row });

    assert.equal(ui._selectedEntity, hero, 'friendly unit takes priority');
    assert.equal(ui._isEnemySelection, false);
  });

  test('clicking empty hex deselects', () => {
    const { ui, state } = makeUI();
    const enemy = state.entities.find(e => e.owner === 'witch' && e.alive);
    ui._selectEnemyEntity(enemy);

    // Click an empty hex (0,0 is likely empty or at least has no entities)
    // Find a hex with no entities
    const occupied = new Set(state.entities.filter(e => e.alive).map(e => `${e.col},${e.row}`));
    let emptyHex = null;
    for (const [key] of state.tiles) {
      if (!occupied.has(key)) {
        const [c, r] = key.split(',').map(Number);
        emptyHex = { col: c, row: r };
        break;
      }
    }
    assert.ok(emptyHex, 'should find an empty hex');

    ui._handleSelection(emptyHex);
    assert.equal(ui._selectedEntity, null, 'should deselect on empty hex');
    assert.equal(ui._isEnemySelection, false);
  });
});
