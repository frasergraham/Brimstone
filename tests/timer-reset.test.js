// Tests for the timerReset message flow — ensures the client countdown
// stays in sync when the server resets its planning timer after a plan
// submission.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installGlobalMocks,
  makeFakeCanvas,
  makeFakeRenderer,
  createElementsBag,
} from './ui/setup.js';

const { fakeCanvas } = installGlobalMocks();

// platform.js accesses localStorage at module-init time — provide a stub
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

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
  const renderer = makeFakeRenderer();
  const els      = createElementsBag();
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return { ui, state, els };
}

// ── resetCountdown ───────────────────────────────────────────────────────────

describe('resetCountdown', () => {
  test('restarts countdown when in planning mode and not submitted', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3, 30_000);

    // Countdown should be running — now reset it to 90s
    ui.resetCountdown(90_000);

    const btn = els['plan-submit-btn'];
    // Progress bar should be set (submit button shows countdown via --progress)
    assert.ok(btn.style._props['--progress'] !== undefined,
      '--progress should be set on submit button');
    // Text should show ~1:30, not the original ~0:30
    assert.ok(btn.textContent.includes('1:'),
      `countdown should show reset value (~1:30), got: "${btn.textContent}"`);

    ui._stopCountdown();
  });

  test('is a no-op when plan is already submitted', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3, 30_000);
    // Simulate submit — sets _planSubmitted = true
    ui._planSubmitted = true;
    ui._stopCountdown();

    ui.resetCountdown(90_000);

    const btn = els['plan-submit-btn'];
    assert.equal(btn.style._props['--progress'], undefined,
      '--progress should not be set after submit');
  });

  test('is a no-op when not in planning mode', () => {
    const { ui, els } = makeUI();

    // Not in planning mode at all
    ui.resetCountdown(90_000);

    const btn = els['plan-submit-btn'];
    assert.equal(btn.style._props['--progress'], undefined,
      '--progress should not be set outside planning');
  });

  test('is a no-op when timeoutMs is 0', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3, 30_000);
    ui._stopCountdown();

    ui.resetCountdown(0);

    const btn = els['plan-submit-btn'];
    assert.equal(btn.style._props['--progress'], undefined,
      '--progress should not restart with 0 timeout');
  });
});

// ── Client message routing ───────────────────────────────────────────────────

describe('MultiplayerClient timerReset routing', () => {
  test('_route dispatches timerReset to onTimerReset callback', async () => {
    const mpMod = await import('../src/multiplayer.js');
    const MultiplayerClient = mpMod.MultiplayerClient;

    let received = null;
    const client = new MultiplayerClient({
      onTimerReset(ms) { received = ms; },
      onError() {},
    });

    // Simulate receiving a timerReset message
    client._route({ type: 'timerReset', timeoutMs: 90_000 });

    assert.equal(received, 90_000, 'onTimerReset should be called with the timeoutMs value');
  });
});

// ── Server-side broadcast (source inspection) ────────────────────────────────

describe('server lobby.js timerReset broadcast', () => {
  const lobbyJs = readFileSync(join(root, 'server', 'lobby.js'), 'utf8');

  test('handlePlanSubmit broadcasts timerReset after _submitPlayerPlan', () => {
    // Find the handlePlanSubmit function body
    const fnStart = lobbyJs.indexOf('export function handlePlanSubmit');
    assert.ok(fnStart !== -1, 'handlePlanSubmit must exist');
    const section = lobbyJs.slice(fnStart, fnStart + 1200);

    assert.ok(
      section.includes("type: 'timerReset'"),
      'handlePlanSubmit must broadcast a timerReset message',
    );
  });

  test('timerReset only sent to non-ready players', () => {
    const fnStart = lobbyJs.indexOf('export function handlePlanSubmit');
    const section = lobbyJs.slice(fnStart, fnStart + 1200);

    assert.ok(
      section.includes('playerReady.get(seat.playerId)'),
      'timerReset broadcast must check playerReady to exclude already-submitted players',
    );
  });

  test('timerReset guarded by planningPhase check', () => {
    const fnStart = lobbyJs.indexOf('export function handlePlanSubmit');
    const section = lobbyJs.slice(fnStart, fnStart + 1200);

    assert.ok(
      section.includes('room.state.planningPhase'),
      'timerReset broadcast must be guarded by planningPhase check',
    );
  });
});
