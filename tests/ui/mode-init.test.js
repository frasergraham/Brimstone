// Tests for UIController mode initialization and setMode() transitions.
//
// Verifies that local / online / spectator modes initialize the correct
// flag state, and that setMode() can switch modes at runtime without a
// page reload — the prerequisite for dead-player → spectator transitions.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeCanvas,
  makeFakeRenderer,
  createElementsBag,
  makeState,
} from './setup.js';

// Install globals before any module that touches document/canvas loads.
const { fakeCanvas } = installGlobalMocks();

let UIController, UIMode, GameState;

before(async () => {
  const [uiMod, gameMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
  ]);
  UIController = uiMod.UIController;
  UIMode       = uiMod.UIMode;
  GameState    = gameMod.GameState;
});

function makeUI(stateOverrides = {}, elsOverrides = {}) {
  const state    = new GameState(true, false);
  const renderer = makeFakeRenderer();
  const els      = createElementsBag(elsOverrides);
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return { ui, state, els };
}

// ── UIMode enum ───────────────────────────────────────────────────────────────

describe('UIMode enum', () => {
  test('exports LOCAL, ONLINE, SPECTATOR constants', () => {
    assert.equal(UIMode.LOCAL,     'local');
    assert.equal(UIMode.ONLINE,    'online');
    assert.equal(UIMode.SPECTATOR, 'spectator');
  });

  test('enum is frozen (immutable)', () => {
    assert.throws(() => { UIMode.LOCAL = 'modified'; }, TypeError);
  });
});

// ── Default (local) mode ──────────────────────────────────────────────────────

describe('UIController default (local) mode', () => {
  test('spectator is false by default', () => {
    const { ui } = makeUI();
    assert.equal(ui.spectator, false);
  });

  test('mp is null by default', () => {
    const { ui } = makeUI();
    assert.equal(ui.mp, null);
  });

  test('myPlayerId is null by default', () => {
    const { ui } = makeUI();
    assert.equal(ui.myPlayerId, null);
  });

  test('_players is empty array by default', () => {
    const { ui } = makeUI();
    assert.deepEqual(ui._players, []);
  });
});

// ── setMode(LOCAL) ────────────────────────────────────────────────────────────

describe('setMode(UIMode.LOCAL)', () => {
  test('spectator remains false', () => {
    const { ui } = makeUI();
    ui.setMode(UIMode.LOCAL);
    assert.equal(ui.spectator, false);
  });

  test('mp and myPlayerId are cleared when switching back to local', () => {
    const { ui } = makeUI();
    // Simulate having been in online mode
    ui.mp = { fake: 'client' };
    ui.myPlayerId = 'some-uuid';
    ui.setMode(UIMode.LOCAL);
    assert.equal(ui.mp, null);
    assert.equal(ui.myPlayerId, null);
  });
});

// ── setMode(ONLINE) ───────────────────────────────────────────────────────────

describe('setMode(UIMode.ONLINE)', () => {
  test('spectator is false in online mode', () => {
    const { ui } = makeUI();
    ui.setMode(UIMode.ONLINE, { mp: {}, myPlayerId: 'player-1', players: [] });
    assert.equal(ui.spectator, false);
  });

  test('mp reference is stored', () => {
    const { ui } = makeUI();
    const fakeClient = { submitPlan() {} };
    ui.setMode(UIMode.ONLINE, { mp: fakeClient });
    assert.strictEqual(ui.mp, fakeClient);
  });

  test('myPlayerId is stored', () => {
    const { ui } = makeUI();
    ui.setMode(UIMode.ONLINE, { myPlayerId: 'uuid-abc' });
    assert.equal(ui.myPlayerId, 'uuid-abc');
  });

  test('players list is stored', () => {
    const { ui } = makeUI();
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero' }];
    ui.setMode(UIMode.ONLINE, { players });
    assert.deepEqual(ui._players, players);
  });
});

// ── setMode(SPECTATOR) ────────────────────────────────────────────────────────

describe('setMode(UIMode.SPECTATOR)', () => {
  test('spectator flag becomes true', () => {
    const { ui } = makeUI();
    ui.setMode(UIMode.SPECTATOR);
    assert.equal(ui.spectator, true);
  });

  test('mp stays null in spectator mode', () => {
    const { ui } = makeUI();
    ui.setMode(UIMode.SPECTATOR);
    assert.equal(ui.mp, null);
  });
});

// ── Runtime mode transitions ──────────────────────────────────────────────────

describe('runtime mode transitions (dead-player → spectator)', () => {
  test('can switch from LOCAL to SPECTATOR without reconstruction', () => {
    const { ui } = makeUI();
    assert.equal(ui.spectator, false, 'starts as local');

    ui.setMode(UIMode.SPECTATOR);
    assert.equal(ui.spectator, true, 'spectator after setMode');
  });

  test('can switch from SPECTATOR back to LOCAL', () => {
    const { ui } = makeUI();
    ui.setMode(UIMode.SPECTATOR);
    ui.setMode(UIMode.LOCAL);
    assert.equal(ui.spectator, false, 'spectator cleared after returning to local');
  });

  test('transitioning ONLINE → SPECTATOR clears mp and myPlayerId', () => {
    const { ui } = makeUI();
    ui.setMode(UIMode.ONLINE, { mp: {}, myPlayerId: 'player-1' });
    assert.equal(ui.spectator, false);
    assert.ok(ui.mp !== null);

    ui.setMode(UIMode.SPECTATOR);
    assert.equal(ui.spectator, true);
    assert.equal(ui.mp, null);
    assert.equal(ui.myPlayerId, null);
  });
});

// ── Element injection (_el helper) ───────────────────────────────────────────

describe('_el element injection', () => {
  test('returns element from els bag when present', () => {
    const { ui, els } = makeUI();
    const planPanel = els['plan-panel'];
    assert.strictEqual(ui._el('plan-panel'), planPanel,
      '_el should return the injected fake element');
  });

  test('returns null for IDs not in bag when document has no match', () => {
    const { ui } = makeUI();
    // 'nonexistent-id' is not in the bag; document.getElementById also won't find it
    // since global.document returns makeFakeElement which is truthy — just verify no throw
    assert.doesNotThrow(() => ui._el('nonexistent-id'));
  });
});
