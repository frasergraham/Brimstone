// Autoplay story-beat gate (src/story-beat-cinematic.js + showStoryModal).
//
// Bug: when resolution is auto-advancing — AI-vs-AI autoplay, or the replay
// "AutoPlay" toggle leaving playback un-paused — authored story beats were
// either skipped (pre-planning beats never reached) or flashed past (the mid-
// replay beat card's NEXT-gate is a no-op while un-paused, and the AI-vs-AI
// branch held only 1100ms). The fix holds each beat for a readable minimum
// dwell, auto-advancing once it elapses (or sooner if the operator dismisses).
//
// These tests pin the gate: the dwell branch decision, the Continue countdown
// gate, and showStoryModal's auto-dismiss wiring — all with injected timers so
// no real 4s wait is incurred.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';

import {
  STORY_BEAT_MIN_DWELL_MS,
  STORY_BEAT_MAX_DWELL_MS,
  storyBeatHoldMs,
  runStoryBeatGate,
} from '../../src/story-beat-cinematic.js';

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

// ── Test doubles (mirror the established G1 countdown-test helpers) ────────────

function makeButton(initialLabel = 'Continue', hidden = false) {
  const listeners = {};
  return {
    textContent: initialLabel,
    hidden,
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    removeEventListener(name, fn) {
      const arr = listeners[name];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    _fire(name) { for (const fn of [...(listeners[name] || [])]) fn(); },
    _count(name) { return (listeners[name] || []).length; },
  };
}

function fakeInterval() {
  const handles = new Map();
  let nextId = 1;
  return {
    setIntervalFn: (fn) => { const id = nextId++; handles.set(id, fn); return id; },
    clearIntervalFn: (id) => { handles.delete(id); },
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    tick(n = 1) { for (let i = 0; i < n; i++) for (const fn of [...handles.values()]) fn(); },
    size() { return handles.size; },
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

// ── storyBeatHoldMs — the mid-replay branch decision ──────────────────────────

describe('storyBeatHoldMs', () => {
  test('AI-vs-AI autoplay always holds for the min dwell', () => {
    assert.equal(storyBeatHoldMs({ autoplay: true, paused: true }), STORY_BEAT_MIN_DWELL_MS);
    assert.equal(storyBeatHoldMs({ autoplay: true, paused: false }), STORY_BEAT_MIN_DWELL_MS);
  });

  test('replay AutoPlay (un-paused) holds for the min dwell', () => {
    // The pre-fix bug: un-paused + not autoplay fell through the NEXT-gate with
    // no wait, so the beat card flashed past. Now it holds.
    assert.equal(storyBeatHoldMs({ autoplay: false, paused: false }), STORY_BEAT_MIN_DWELL_MS);
  });

  test('manual stepping (paused) does NOT hold — gates on NEXT instead', () => {
    assert.equal(storyBeatHoldMs({ autoplay: false, paused: true }), 0);
  });

  test('min dwell is overridable', () => {
    assert.equal(storyBeatHoldMs({ autoplay: true, paused: true, minDwellMs: 9000 }), 9000);
  });

  test('default dwell is a readable 4s+', () => {
    assert.ok(STORY_BEAT_MIN_DWELL_MS >= 4000, 'beats stay up long enough to read');
  });

  // Text-length scaling — long beats need more reading time than the 4s floor.
  // Mirrors conversation-player's conversationReadingMs(): a short beat sits at
  // the floor, longer beats add per-character time, all capped at a ceiling so a
  // ridiculously long beat can't hang autoplay forever.
  test('short text holds for the min dwell floor (no extra reading time)', () => {
    const hold = storyBeatHoldMs({ autoplay: true, paused: false, text: 'Hi.' });
    assert.equal(hold, STORY_BEAT_MIN_DWELL_MS, 'short beat = floor');
  });

  test('long text scales the hold above the floor', () => {
    const longText = 'A'.repeat(300);   // ~300 chars > the floor's char budget
    const hold = storyBeatHoldMs({ autoplay: true, paused: false, text: longText });
    assert.ok(hold > STORY_BEAT_MIN_DWELL_MS,
      `long beat (~300 chars) should hold > floor; got ${hold}`);
  });

  test('absurdly long text is capped at the max dwell ceiling', () => {
    const insane = 'B'.repeat(10_000);
    const hold = storyBeatHoldMs({ autoplay: true, paused: false, text: insane });
    assert.ok(hold <= STORY_BEAT_MAX_DWELL_MS,
      `unbounded reading time would hang autoplay; got ${hold}`);
    assert.equal(hold, STORY_BEAT_MAX_DWELL_MS, 'pinned to the ceiling');
  });

  test('manual stepping (paused) ignores text length — still gates on NEXT', () => {
    const longText = 'C'.repeat(500);
    assert.equal(
      storyBeatHoldMs({ autoplay: false, paused: true, text: longText }), 0,
      'paused human play uses the manual NEXT gate, not a timed hold',
    );
  });

  test('title is included in reading time when present', () => {
    // A long title + short text still earns extra reading time.
    const title = 'D'.repeat(200);
    const text  = 'short.';
    const hold = storyBeatHoldMs({ autoplay: true, paused: false, title, text });
    assert.ok(hold > STORY_BEAT_MIN_DWELL_MS,
      `title length should count; got ${hold}`);
  });

  test('max dwell ceiling is sensible (10s window)', () => {
    assert.ok(STORY_BEAT_MAX_DWELL_MS >= 8000 && STORY_BEAT_MAX_DWELL_MS <= 20000,
      `ceiling should be a reasonable max-read time; got ${STORY_BEAT_MAX_DWELL_MS}`);
  });
});

// ── runStoryBeatGate — the Continue countdown gate ────────────────────────────

describe('runStoryBeatGate', () => {
  test('holds until the countdown elapses, then auto-advances', async () => {
    const btn = makeButton();
    const iv = fakeInterval();
    let resolved = false;
    const gate = runStoryBeatGate(btn, {
      minDwellMs: 4000,
      countdownOpts: iv,
    }).then(() => { resolved = true; });

    await flush();
    // 4000ms → 4 ticks. Not resolved before the countdown drains.
    iv.tick(3);
    await flush();
    assert.equal(resolved, false, 'beat still held mid-countdown');

    iv.tick(1);   // reaches 0 → auto-click
    await gate;
    assert.equal(resolved, true, 'auto-advanced once the dwell elapsed');
  });

  test('an operator Continue click advances sooner', async () => {
    const btn = makeButton();
    const iv = fakeInterval();
    let resolved = false;
    const gate = runStoryBeatGate(btn, { minDwellMs: 4000, countdownOpts: iv })
      .then(() => { resolved = true; });

    await flush();
    iv.tick(1);   // 1s in
    await flush();
    assert.equal(resolved, false);

    btn._fire('click');   // operator dismisses
    await gate;
    assert.equal(resolved, true, 'click resolved the gate before the countdown');
    // Click handler detached; countdown cancelled (label restored, no leak).
    assert.equal(btn._count('click'), 0, 'click listener detached on finish');
    assert.equal(iv.size(), 0, 'countdown interval cleared on finish');
  });

  test('with no button, falls back to a plain dwell via delayFn', async () => {
    let delayedMs = null;
    await runStoryBeatGate(null, {
      minDwellMs: 4000,
      delayFn: (ms) => { delayedMs = ms; return Promise.resolve(); },
    });
    assert.equal(delayedMs, 4000, 'no-button gate is a plain min-dwell delay');
  });

  test('resolves exactly once even if click and countdown race', async () => {
    const btn = makeButton();
    const iv = fakeInterval();
    let count = 0;
    const gate = runStoryBeatGate(btn, { minDwellMs: 4000, countdownOpts: iv })
      .then(() => { count += 1; });
    await flush();
    btn._fire('click');
    iv.tick(10);   // would auto-click too, but gate is already settled
    await gate;
    await flush();
    assert.equal(count, 1, 'single resolution');
  });
});

// ── showStoryModal auto-dismiss — the pre-planning autoplay path ──────────────

describe('showStoryModal autoDismiss (autoplay)', () => {
  function makeUI(continueBtn) {
    const state    = new GameState(true, true);   // AI-vs-AI
    const renderer = makeFakeRenderer();
    const storyModal = createElementsBag()['game-screen'];   // a trackable fake
    const els = createElementsBag({
      'story-modal': storyModal,
      'story-modal-continue': continueBtn,
    });
    const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, true, els);
    return { ui, storyModal };
  }

  test('shows the modal, holds for the dwell, then auto-dismisses', async () => {
    const btn = makeButton();
    const iv = fakeInterval();
    const { ui, storyModal } = makeUI(btn);

    let done = false;
    const p = ui.showStoryModal('A Voice in the Dark', 'The hollow stirs…', {
      autoDismissMs: 4000,
      gateOpts: { countdownOpts: iv },
    }).then(() => { done = true; });

    await flush();
    assert.ok(storyModal.classList.contains('visible'), 'beat card is shown');
    iv.tick(3);
    await flush();
    assert.equal(done, false, 'still readable mid-dwell');
    assert.ok(storyModal.classList.contains('visible'), 'card stays up during the dwell');

    iv.tick(1);   // dwell elapses → auto-dismiss
    await p;
    assert.equal(done, true, 'resolved after the dwell');
    assert.ok(!storyModal.classList.contains('visible'), 'card hidden after auto-dismiss');
  });

  test('without autoDismiss, gates on a manual Continue click (human path)', async () => {
    const btn = makeButton();
    const { ui, storyModal } = makeUI(btn);

    let done = false;
    const p = ui.showStoryModal('Prologue', 'Caleb’s Hollow.').then(() => { done = true; });
    await flush();
    assert.ok(storyModal.classList.contains('visible'));
    assert.equal(done, false, 'waits for the player');

    btn._fire('click');
    await p;
    assert.equal(done, true);
    assert.ok(!storyModal.classList.contains('visible'));
  });
});
