// Regression test for the cycle-bar visibility decoupling fix in PR-299.
//
// Before the fix, _renderObjectives hid the entire #score-bar element when
// state.disableScoring was true, which also hid the cycle-bump (the day/night
// pill positioned above the bar via CSS). All campaign missions ran with
// disableScoring=true, so the cycle indicator was always invisible there.
//
// Behaviour now expected from _renderObjectives, parameterised on the two
// independent flags:
//
//   disableScoring | disableCycleBar | bar visible | cycle-bump visible | bar.cycle-only class
//   ---------------|-----------------|-------------|--------------------|----------------------
//   false          | false           | yes         | yes                | no
//   true           | false           | yes (slim)  | yes                | yes
//   false          | true            | yes         | no                 | no
//   true           | true            | no          | no                 | no

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';

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

function makeUI(stateFlags = {}) {
  const state    = new GameState(true, false);
  Object.assign(state, stateFlags);
  const renderer = makeFakeRenderer();
  const els      = createElementsBag();
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return { ui, state, els };
}

describe('_renderObjectives — cycle-bar / score-bar visibility', () => {
  test('default: bar visible, cycle visible, no .cycle-only', () => {
    const { ui, els } = makeUI({ disableScoring: false, disableCycleBar: false });
    ui._renderObjectives();
    assert.notEqual(els['score-bar'].style.display, 'none', 'bar should be visible');
    assert.notEqual(els['cycle-bump'].style.display, 'none', 'cycle pill should be visible');
    assert.ok(!els['score-bar'].classList.contains('cycle-only'),
      'no cycle-only class when scoring is on');
  });

  test('disableScoring only: bar visible (anchor for pill), cycle visible, .cycle-only set', () => {
    const { ui, els } = makeUI({ disableScoring: true, disableCycleBar: false });
    ui._renderObjectives();
    assert.notEqual(els['score-bar'].style.display, 'none',
      'bar should remain visible to anchor the cycle pill');
    assert.notEqual(els['cycle-bump'].style.display, 'none',
      'cycle pill should be visible — this is the regression we are guarding against');
    assert.ok(els['score-bar'].classList.contains('cycle-only'),
      'cycle-only class hides the inner score content while keeping the bar');
  });

  test('disableCycleBar only: bar visible, cycle hidden', () => {
    const { ui, els } = makeUI({ disableScoring: false, disableCycleBar: true });
    ui._renderObjectives();
    assert.notEqual(els['score-bar'].style.display, 'none', 'bar should be visible');
    assert.equal(els['cycle-bump'].style.display, 'none', 'cycle pill should be hidden');
  });

  test('both flags: bar hidden entirely (legacy behaviour)', () => {
    const { ui, els } = makeUI({ disableScoring: true, disableCycleBar: true });
    ui._renderObjectives();
    assert.equal(els['score-bar'].style.display, 'none', 'bar should be hidden');
    assert.equal(els['cycle-bump'].style.display, 'none', 'cycle pill should be hidden');
  });
});
