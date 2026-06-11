// Tests for the timerReset message flow — ensures the client countdown
// stays in sync when the server resets its planning timer after a plan
// submission.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

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

  test('restarts countdown when plan is already submitted (waiting state)', () => {
    const { ui, els } = makeUI();
    ui.enterPlanningMode('hero', 3, 30_000);
    // Simulate submit — sets _planSubmitted = true
    ui._planSubmitted = true;
    ui._stopCountdown();

    ui.resetCountdown(90_000);

    // Countdown should restart so the waiting player sees the updated deadline.
    // After submission the timer ticks in plan-status, not the submit button,
    // but _countdownEnd should be set proving a countdown is active.
    assert.ok(ui._countdownEnd != null,
      '_countdownEnd should be set after resetCountdown while submitted');

    ui._stopCountdown();
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

// ── Server-side behavior: plan submission must not reset the round timer ─────

describe('server lobby.js — plan submission does not reset the planning timer', () => {
  let lobby;

  function mockWs() {
    const ws = {
      readyState: 1,
      messages: [],
      send(data) { ws.messages.push(JSON.parse(data)); },
      msgsOf(type) { return ws.messages.filter(m => m.type === type); },
      findMsg(type) { return ws.messages.find(m => m.type === type); },
    };
    return ws;
  }

  function cleanUpRooms() {
    for (const r of lobby.getRooms()) {
      const room = lobby.getRoom(r.id);
      if (room) {
        if (room.state) room.state.winner = 'hero';
        if (room.turnTimer) clearTimeout(room.turnTimer);
        if (room.allHumansGoneTimer) clearTimeout(room.allHumansGoneTimer);
        for (const t of room.disconnectTimers?.values() ?? []) clearTimeout(t);
        for (const t of room.takeoverTimers?.values() ?? []) clearTimeout(t);
      }
    }
  }

  /** 1v1 game with two humans so a single submission cannot trigger resolution. */
  function createTwoHumanGame() {
    const ws1 = mockWs();
    const ws2 = mockWs();
    const p1 = 'timer-reset-p1';
    const p2 = 'timer-reset-p2';
    lobby.createLobby(p1, 'TimerHero', ws1, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
    });
    const roomId = ws1.findMsg('lobbyJoined').lobby.id;
    lobby.claimSlot(p1, roomId, 0);
    lobby.joinLobby(p2, 'TimerWitch', ws2, roomId);
    lobby.claimSlot(p2, roomId, 1);
    lobby.startGame(p1, roomId);
    return { roomId: ws1.findMsg('matchFound').roomId, ws1, ws2, p1, p2 };
  }

  before(async () => { lobby = await import('../server/lobby.js'); });

  test('submitting a plan does not broadcast timerReset or restart the deadline', (t) => {
    const { roomId, ws1, ws2, p1 } = createTwoHumanGame();
    t.after(cleanUpRooms);

    const room = lobby.getRoom(roomId);
    const timerBefore    = room.turnTimer;
    const deadlineBefore = room.turnDeadline;
    assert.ok(timerBefore, 'planning timer should be running');

    const unit = room.state.entities.find(e => e.alive && e.ownerId === p1);
    lobby.handlePlanSubmit(p1, roomId, [{ type: 'explore', entityId: unit.id }], room.state.round);
    assert.equal(room.state.playerReady.get(p1), true, 'plan must be accepted');

    // Deadlines are fixed per round — nobody gets a timerReset and the
    // original timer/deadline survive the submission untouched.
    assert.equal(ws1.msgsOf('timerReset').length, 0, 'submitter must not receive timerReset');
    assert.equal(ws2.msgsOf('timerReset').length, 0, 'other players must not receive timerReset');
    assert.equal(room.turnTimer, timerBefore, 'planning timer handle must be unchanged');
    assert.equal(room.turnDeadline, deadlineBefore, 'planning deadline must be unchanged');
    assert.equal(room.phase, 'planning', 'room stays in planning until everyone submits');
  });
});
