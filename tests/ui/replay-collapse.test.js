// Tests for the replay turn-card collapse toggle (mobile card collapse).
//
// Covers the new card markup (header + +/- button + … hint) and the
// _applyReplayCollapse toggle that drives the CSS-collapsed view. The
// show-only-the-active-action and … behaviours themselves are pure CSS and so
// aren't exercised here.

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

function makeUI() {
  const state    = new GameState(true, false);
  const renderer = makeFakeRenderer();
  const els      = createElementsBag({ 'replay-timeline': makeReplayTimelineEl() });
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return { ui, els };
}

// createElementsBag doesn't include the replay overlay; build a trackable one.
function makeReplayTimelineEl() {
  // makeFakeElement isn't exported by name here; reuse the bag factory which
  // returns trackable fakes, then pull one out.
  return createElementsBag()['game-screen'];
}

function moveCol() {
  return {
    stepIndex: 0,
    entries: [{
      entityId: 'h1', actionType: 'move', label: 'MOVE',
      actor: { name: 'Sam', type: 'survivor', title: null, color: '#abc', glyph: '☺' },
      actorAllies: [], target: null, targetAllies: [],
      outcomeKind: null, note: null, discovered: [],
    }],
  };
}

describe('replay card markup', () => {
  test('_replayColHtml renders a header, +/- toggle and … hint', () => {
    const { ui } = makeUI();
    const html = ui._replayColHtml(moveCol(), 1);
    assert.match(html, /replay-step-header/);
    assert.match(html, /replay-collapse-btn/);
    assert.match(html, /replay-more/);
    assert.match(html, /Turn 1/);
  });
});

describe('_applyReplayCollapse', () => {
  test('toggles the collapsed class and remembers the choice', () => {
    const { ui, els } = makeUI();
    const wrap = els['replay-timeline'];

    ui._applyReplayCollapse(true);
    assert.equal(ui._replayCollapsed, true);
    assert.ok(wrap._classList.has('collapsed'));

    ui._applyReplayCollapse(false);
    assert.equal(ui._replayCollapsed, false);
    assert.ok(!wrap._classList.has('collapsed'));
  });
});
