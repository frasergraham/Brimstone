// Arc action menu under strict tutorial gating (Learn to Play).
//
// The conductor publishes ui.tutorialAllowedActions per step. Non-whitelisted
// commands must render DISABLED — visible but unclickable — rather than being
// hidden: the menu keeps its shape so the player learns where every command
// lives, while the scripted plan stays safe from stray commands.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobalMocks,
  createElementsBag,
  makeFakeRenderer,
} from './ui/setup.js';

const { fakeCanvas, _elements } = installGlobalMocks();

let UIController, GameState, ActionType, normalizeItems, buildLearnMap, placeLearnUnits;

before(async () => {
  const [uiMod, gameMod, actMod, entMod, learnMod] = await Promise.all([
    import('../src/ui.js'),
    import('../src/game.js'),
    import('../src/actions.js'),
    import('../src/entities.js'),
    import('../src/learn/learn-config.js'),
  ]);
  UIController   = uiMod.UIController;
  GameState      = gameMod.GameState;
  ActionType     = actMod.ActionType;
  normalizeItems = entMod.normalizeItems;
  buildLearnMap  = learnMod.buildLearnMap;
  placeLearnUnits = learnMod.placeLearnUnits;
});

/** The Learn-to-Play board, in planning mode, exactly as the launcher builds it. */
function makeLearnUI() {
  const state = new GameState(false, false, 'tutorial', null, buildLearnMap());
  state.fogOfWar = 'partial';
  placeLearnUnits(state);
  state.inventory.hero = normalizeItems({ wood: 2, food: 1 });

  const renderer = makeFakeRenderer();
  renderer.getEntityScreenPositions = () => [];
  Object.assign(_elements, createElementsBag());
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false);
  ui.enterPlanningMode('hero', 6);
  return { ui, state };
}

const itemFor = (ui, action) =>
  (ui._arcItems ?? []).find(i => i.attrs?.includes(`data-action="${action}"`));

// The popup starts a rAF tracking loop (mocked to setTimeout here) that only
// stops once the popup hides — close it or the test process never exits.
const closePopup = (ui) => { ui._clearSelection(); };

describe('tutorial arc-menu gating: disable, never hide', () => {
  test('whitelisted action stays enabled; the rest render disabled', () => {
    const { ui, state } = makeLearnUI();
    // fortify_intro publishes allowActions [FORTIFY]
    ui.tutorialAllowedActions = new Set([ActionType.FORTIFY]);
    ui._showActionPopup(state.hero);

    const fortify = itemFor(ui, 'fortify');
    const explore = itemFor(ui, 'explore');
    const guard   = itemFor(ui, 'guard');
    assert.ok(fortify, 'Fortify present (hero on the church-class Inn tile with wood)');
    assert.equal(fortify.dis, false, 'whitelisted Fortify stays clickable');
    assert.ok(explore, 'Explore stays VISIBLE while non-whitelisted');
    assert.equal(explore.dis, true, 'non-whitelisted Explore is disabled');
    assert.ok(guard, 'Guard stays VISIBLE while non-whitelisted');
    assert.equal(guard.dis, true, 'non-whitelisted Guard is disabled');
    closePopup(ui);
  });

  test('an empty whitelist (move/attack steps) disables every command but hides none', () => {
    const { ui, state } = makeLearnUI();
    ui.tutorialAllowedActions = new Set();   // allowActions: []
    ui._showActionPopup(state.hero);
    const items = (ui._arcItems ?? []).filter(i => i.attrs?.includes('data-action='));
    assert.ok(items.length > 0, 'the menu still shows the commands');
    for (const it of items) {
      assert.equal(it.dis, true, `"${it.label}" must be disabled under an empty whitelist`);
    }
    closePopup(ui);
  });

  test('null whitelist (free play / after handoff) leaves the menu unrestricted', () => {
    const { ui, state } = makeLearnUI();
    ui.tutorialAllowedActions = null;
    ui._showActionPopup(state.hero);
    const explore = itemFor(ui, 'explore');
    const guard   = itemFor(ui, 'guard');
    assert.ok(explore && guard, 'commands present');
    assert.equal(explore.dis, false, 'Explore enabled in free play');
    assert.equal(guard.dis, false, 'Guard enabled in free play');
    closePopup(ui);
  });
});
