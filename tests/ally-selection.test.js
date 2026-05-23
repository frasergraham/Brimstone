// Tests for ally unit view-only selection in N-player multiplayer.
//
// In multiplayer games with teammates on the same faction, clicking a
// teammate's unit should select it for stats inspection — same view-only
// behavior as enemy selection (stats bar visible, no actions enabled).

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobalMocks,
  createElementsBag,
  makeFakeRenderer,
} from './ui/setup.js';

const { fakeCanvas, _elements } = installGlobalMocks();

let UIController, GameState, createSurvivor;

before(async () => {
  const [uiMod, gameMod, entMod] = await Promise.all([
    import('../src/ui.js'),
    import('../src/game.js'),
    import('../src/entities.js'),
  ]);
  UIController   = uiMod.UIController;
  GameState      = gameMod.GameState;
  createSurvivor = entMod.createSurvivor;
});

// Build a UI fixture configured as a multiplayer client where the local
// player owns the hero entity, and a teammate owns one of the survivors.
function makeAllyUI() {
  const state    = new GameState(true, false);
  state.fogOfWar = 'none';
  const renderer = makeFakeRenderer();
  const els      = createElementsBag();
  Object.assign(_elements, els);
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false);
  ui.myPlayerId = 'me';

  // Mark the hero as "mine".
  const hero = state.entities.find(e => e.alive && e.type === 'paladin');
  hero.ownerId = 'me';

  // Spawn a real ally survivor entity (with proper Entity prototype, so the
  // `alive` getter works) on the first free hex we can find.
  const occupied = new Set(
    state.entities.filter(e => e.alive).map(e => `${e.col},${e.row}`)
  );
  let target = null;
  for (const [key] of state.tiles) {
    if (occupied.has(key)) continue;
    const [c, r] = key.split(',').map(Number);
    target = { col: c, row: r };
    break;
  }
  assert.ok(target, 'expected to find a free hex for ally unit');
  const allyUnit = createSurvivor(target.col, target.row, 'ally');
  state.entities.push(allyUnit);

  return { ui, state, renderer, hero, allyUnit };
}

// ── _handleSelection ally fallback ──────────────────────────────────────────

describe('_handleSelection ally fallback', () => {
  test('clicking hex with only an ally unit selects it as view-only', () => {
    const { ui, allyUnit } = makeAllyUI();

    ui._handleSelection({ col: allyUnit.col, row: allyUnit.row });

    assert.equal(ui._selectedEntity, allyUnit, 'ally unit should be selected');
    assert.equal(
      ui._isEnemySelection,
      true,
      'view-only flag should be set for ally selection'
    );
    assert.deepEqual(ui._validActions, [], 'no actions for ally units');
    assert.equal(ui._awaitingTarget, null, 'no awaiting target for ally units');
  });

  test('clicking hex with my own unit still selects mine, not the ally', () => {
    const { ui, hero, allyUnit } = makeAllyUI();

    // Co-locate ally on hero's hex
    allyUnit.col = hero.col;
    allyUnit.row = hero.row;

    ui._handleSelection({ col: hero.col, row: hero.row });

    assert.equal(ui._selectedEntity, hero, 'my own unit takes priority');
    assert.equal(ui._isEnemySelection, false, 'controllable selection');
  });

  test('ally selection sets renderer selection (hex + entityId)', () => {
    const { ui, renderer, allyUnit } = makeAllyUI();

    ui._handleSelection({ col: allyUnit.col, row: allyUnit.row });

    assert.deepEqual(renderer._selection.hex, {
      col: allyUnit.col,
      row: allyUnit.row,
    });
    assert.equal(renderer._selection.entityId, allyUnit.id);
    assert.deepEqual(
      renderer.highlightHexes,
      [],
      'no movement highlights for ally inspection'
    );
  });

  test('clicking my own unit clears any prior ally selection', () => {
    const { ui, hero, allyUnit } = makeAllyUI();

    ui._handleSelection({ col: allyUnit.col, row: allyUnit.row });
    assert.equal(ui._isEnemySelection, true);

    ui._handleSelection({ col: hero.col, row: hero.row });
    assert.equal(ui._selectedEntity, hero);
    assert.equal(
      ui._isEnemySelection,
      false,
      'selecting my own unit clears the view-only flag'
    );
  });
});
