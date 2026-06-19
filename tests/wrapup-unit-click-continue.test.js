// Tweak: clicking one of YOUR units while the round-summary wrap-up is on
// screen resolves it as Continue (same as the Continue button) and pre-selects
// that unit once planning begins.
//
// These exercise the load-bearing logic directly:
//   - showReplayWrapUp() exposes its resolver as ui._wrapUpResolve and records
//     ui._wrapUpFaction, and resolving it as 'next' tears the hook down.
//   - ui._myUnitAt(hex) finds the local player's controllable unit (and only
//     theirs — not enemies / NPCs / other players' units).
//   - enterPlanningMode() honours a stashed ui._pendingPlanSelectId and clears
//     it so nothing leaks across rounds.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobalMocks,
  createElementsBag,
  makeFakeRenderer,
  makeFakeElement,
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

// The wrap-up card + scrub-review machinery touches these timeline elements,
// which aren't in the default bag.
function wrapUpElements() {
  return {
    'replay-timeline':       makeFakeElement('replay-timeline'),
    'replay-timeline-track': makeFakeElement('replay-timeline-track'),
    'replay-progress':       makeFakeElement('replay-progress'),
    'replay-review-prev':    makeFakeElement('replay-review-prev'),
    'replay-review-next':    makeFakeElement('replay-review-next'),
    'replay-hud':            makeFakeElement('replay-hud'),
    'replay-dots':           makeFakeElement('replay-dots'),
  };
}

function makeUI() {
  const state    = new GameState(true, false); // hero human, witch AI
  state.fogOfWar = 'none';
  const renderer = makeFakeRenderer();
  renderer.getEntityScreenPositions = () => [];
  const els = createElementsBag(wrapUpElements());
  Object.assign(_elements, els);
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false);
  return { ui, state, renderer };
}

describe('round-summary wrap-up: dismiss-by-unit-click plumbing', () => {
  test('showReplayWrapUp exposes its resolver + faction; resolving clears them', async () => {
    const { ui } = makeUI();
    const p = ui.showReplayWrapUp({ titleHtml: 'Turn Complete', humanFaction: 'hero', canReplay: false });

    assert.equal(typeof ui._wrapUpResolve, 'function', 'resolver is exposed while the card is up');
    assert.equal(ui._wrapUpFaction, 'hero', 'records whose units the player owns');

    ui._wrapUpResolve('next');           // simulate a board click resolving Continue
    const action = await p;
    assert.equal(action, 'next', 'wrap-up promise resolves as Continue');
    assert.equal(ui._wrapUpResolve, null, 'hook is cleared so board clicks stop intercepting');
  });

  test('humanFaction falls back to state.myFaction when not passed (online/async)', async () => {
    const { ui, state } = makeUI();
    state.myFaction = 'witch';
    const p = ui.showReplayWrapUp({ titleHtml: 'Turn Complete', canReplay: false });
    assert.equal(ui._wrapUpFaction, 'witch');
    ui._wrapUpResolve('next');
    await p;
  });
});

describe('_myUnitAt — owner filtering', () => {
  test('finds the local player\'s own controllable unit at a hex', () => {
    const { ui, state } = makeUI();
    const hero = state.entities.find(e => e.owner === 'hero' && e.alive);
    ui._wrapUpFaction = 'hero';
    const found = ui._myUnitAt({ col: hero.col, row: hero.row });
    assert.equal(found, hero, 'returns the own unit standing on the clicked hex');
  });

  test('returns null for an enemy unit (not the player\'s faction)', () => {
    const { ui, state } = makeUI();
    const witch = state.entities.find(e => e.owner === 'witch' && e.alive);
    ui._wrapUpFaction = 'hero';
    assert.equal(ui._myUnitAt({ col: witch.col, row: witch.row }), null);
  });

  test('returns null for empty ground and when no faction is set', () => {
    const { ui, state } = makeUI();
    const occupied = new Set(state.entities.filter(e => e.alive).map(e => `${e.col},${e.row}`));
    let empty = null;
    for (const [key] of state.tiles) {
      if (!occupied.has(key)) { const [c, r] = key.split(',').map(Number); empty = { col: c, row: r }; break; }
    }
    ui._wrapUpFaction = 'hero';
    assert.equal(ui._myUnitAt(empty), null, 'empty hex → null');

    const hero = state.entities.find(e => e.owner === 'hero' && e.alive);
    ui._wrapUpFaction = null;
    assert.equal(ui._myUnitAt({ col: hero.col, row: hero.row }), null, 'no faction → null (no interception)');
  });

  test('does not match a scripted NPC even on the player\'s faction', () => {
    const { ui, state } = makeUI();
    const npc = createMinion(0, 0);
    npc.owner = 'hero';
    npc.isNpc = true;
    state.entities.push(npc);
    ui._wrapUpFaction = 'hero';
    assert.equal(ui._myUnitAt({ col: 0, row: 0 }), null, 'NPCs are never player-controllable');
  });
});

describe('enterPlanningMode — deferred selection from the wrap-up click', () => {
  test('honours _pendingPlanSelectId then clears it', () => {
    const { ui, state } = makeUI();
    // Use a non-leader unit on round 2+ so we know the round-1 leader auto-select
    // isn't what selected it.
    state.round = 2;
    const minion = createMinion(0, 0);
    minion.owner = 'hero';
    state.entities.push(minion);

    ui._pendingPlanSelectId = minion.id;
    ui.enterPlanningMode('hero', 3);

    assert.equal(ui._selectedEntity, minion, 'clicked unit is selected once planning begins');
    assert.equal(ui._pendingPlanSelectId, null, 'pending id consumed so it cannot leak into a later round');
  });

  test('a stale pending id for a non-controllable unit is dropped, not selected', () => {
    const { ui, state } = makeUI();
    state.round = 2;
    const witch = state.entities.find(e => e.owner === 'witch' && e.alive);
    ui._pendingPlanSelectId = witch.id; // wrong faction for a hero plan
    ui.enterPlanningMode('hero', 3);
    assert.notEqual(ui._selectedEntity, witch, 'an enemy id is never selected');
    assert.equal(ui._pendingPlanSelectId, null, 'still cleared');
  });
});
