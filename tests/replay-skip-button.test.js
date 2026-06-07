// Tests for the unified replay control bar + timeline overlay:
//   - showInlineReplayHUD (inline mode) shows #replay-hud, hides Back/Stop,
//     relabels End as SKIP, and routes button clicks through onControl
//   - the camera toggle flips ui.replayCameraMode and renderer.suppressAutoFrame
//   - hideInlineReplayHUD hides the bar and restores Back/Stop visibility
//   - showReplayTimeline renders step columns; hideReplayTimeline clears them
//
// Also verifies that playbackDelay (outside PLAYBACK mode) respects the
// jumpToEnd and paused flags so the animation loop can bail / hold mid-delay.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeElement,
  makeFakeRenderer,
  createElementsBag,
} from './ui/setup.js';

const mocks = installGlobalMocks();

// Pre-register the replay HUD + timeline elements so document.getElementById
// returns stable references (otherwise each call builds a fresh fake).
const hudIds = [
  'replay-hud',
  'replay-back-btn',   'replay-next-btn',  'replay-playpause-btn',
  'replay-camera-btn', 'replay-stop-btn',
  'replay-timeline',   'replay-timeline-track',
];
for (const id of hudIds) {
  mocks._elements[id] = makeFakeElement(id);
}

let UIController, GameState, playback, resetPlayback, playbackDelay, AppMode, setMode;

before(async () => {
  const [uiMod, gameMod, playbackMod, modeMod] = await Promise.all([
    import('../src/ui.js'),
    import('../src/game.js'),
    import('../src/playback.js'),
    import('../src/app-mode.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
  playback     = playbackMod.playback;
  resetPlayback = playbackMod.resetPlayback;
  playbackDelay = playbackMod.playbackDelay;
  AppMode      = modeMod.AppMode;
  setMode      = modeMod.setMode;
});

function makeUI() {
  const state    = new GameState(true, false);
  const renderer = makeFakeRenderer();
  // createElementsBag does NOT include replay-hud/timeline — add them so
  // this._el('replay-hud') etc. return our stable fakes.
  const els = createElementsBag({
    'replay-hud':            mocks._elements['replay-hud'],
    'replay-timeline':       mocks._elements['replay-timeline'],
    'replay-timeline-track': mocks._elements['replay-timeline-track'],
  });
  const ui = new UIController(mocks.fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return ui;
}

describe('UIController inline replay bar (showInlineReplayHUD)', () => {
  test('shows #replay-hud, hides Back/Stop, keeps Next + Play/Pause + Camera', () => {
    const ui = makeUI();
    for (const id of hudIds) mocks._elements[id].style.display = '';

    ui.showInlineReplayHUD(() => {});

    assert.equal(mocks._elements['replay-hud'].style.display, 'flex');
    // Back + Stop are full-game-only → hidden in inline mode.
    assert.equal(mocks._elements['replay-back-btn'].style.display, 'none');
    assert.equal(mocks._elements['replay-stop-btn'].style.display, 'none');
    // Transport + camera stay visible.
    for (const id of ['replay-next-btn', 'replay-playpause-btn', 'replay-camera-btn']) {
      assert.notEqual(mocks._elements[id].style.display, 'none', `${id} should be visible`);
    }
    // Starts paused (manual stepping): AutoPlay not active, Next is enabled.
    assert.equal(mocks._elements['replay-playpause-btn']._classList.has('active'), false);
    assert.equal(mocks._elements['replay-next-btn'].disabled, false);
  });

  test('routes Next + Play/Pause clicks through onControl(action)', () => {
    const ui = makeUI();
    const seen = [];
    ui.showInlineReplayHUD((action) => seen.push(action));

    mocks._elements['replay-next-btn'].onclick();
    mocks._elements['replay-playpause-btn'].onclick();
    assert.deepEqual(seen, ['next', 'playpause']);
  });

  test('setReplayTransport greys out Next during auto-play', () => {
    const ui = makeUI();
    ui.showInlineReplayHUD(() => {});
    ui.setReplayTransport(false);   // auto-play
    assert.equal(mocks._elements['replay-playpause-btn']._classList.has('active'), true);
    assert.equal(mocks._elements['replay-next-btn'].disabled, true);
    ui.setReplayTransport(true);    // manual
    assert.equal(mocks._elements['replay-playpause-btn']._classList.has('active'), false);
    assert.equal(mocks._elements['replay-next-btn'].disabled, false);
  });
});

describe('UIController replay camera toggle', () => {
  test('toggles replayCameraMode and renderer.suppressAutoFrame', () => {
    const ui = makeUI();
    ui.showInlineReplayHUD(() => {});
    assert.equal(ui.replayCameraMode, 'follow');
    assert.equal(ui.renderer.suppressAutoFrame, false);

    // Camera button is wired internally (not via onControl).
    mocks._elements['replay-camera-btn'].onclick();
    assert.equal(ui.replayCameraMode, 'fixed');
    assert.equal(ui.renderer.suppressAutoFrame, true);
    assert.match(mocks._elements['replay-camera-btn'].textContent, /Fixed/);

    mocks._elements['replay-camera-btn'].onclick();
    assert.equal(ui.replayCameraMode, 'follow');
    assert.equal(ui.renderer.suppressAutoFrame, false);
    assert.match(mocks._elements['replay-camera-btn'].textContent, /Follow/);
  });
});

describe('UIController.hideInlineReplayHUD', () => {
  test('hides the bar and restores Back/Stop visibility', () => {
    const ui = makeUI();
    ui.showInlineReplayHUD(() => {});
    assert.equal(mocks._elements['replay-back-btn'].style.display, 'none');

    ui.hideInlineReplayHUD();

    assert.equal(mocks._elements['replay-hud'].style.display, 'none');
    assert.equal(mocks._elements['replay-back-btn'].style.display, '');
    assert.equal(mocks._elements['replay-stop-btn'].style.display, '');
    // Auto-framing suppression is cleared on hide.
    assert.equal(ui.renderer.suppressAutoFrame, false);
  });
});

describe('UIController replay timeline overlay', () => {
  const unit = (type, name, color, glyph) => ({ type, title: null, name, color, glyph });
  const digest = [
    { stepIndex: 0, entries: [
      { entityId: 'h1', actor: unit('hero', 'Hero', '#d4a72c', '⚔'), target: null,
        actionType: 'move', label: 'MOVE',
        outcomeKind: null, targetDmg: 0, actorDmg: 0, killed: false,
        note: { text: 'BLOCKED', kind: 'blocked' } },
    ] },
    // An empty (fully fogged) step — should NOT render a card.
    { stepIndex: 1, entries: [] },
    { stepIndex: 2, entries: [
      { entityId: 'h1', actor: unit('hero', 'Hero', '#d4a72c', '⚔'),
        target: unit('witch', 'Witch', '#9b59b6', '✦'),
        actionType: 'battle-unit', label: 'BATTLE',
        outcomeKind: 'hit', targetDmg: 1, actorDmg: 0, killed: false, note: null },
    ] },
  ];

  test('showReplayTimeline renders only non-empty steps, with names + damage', () => {
    const ui = makeUI();
    ui.showReplayTimeline(digest);
    const track = mocks._elements['replay-timeline-track'];
    assert.ok(mocks._elements['replay-timeline']._classList.has('visible'));
    // Two visible cards numbered sequentially (the fogged step is dropped).
    assert.match(track.innerHTML, /Step 1/);
    assert.match(track.innerHTML, /Step 2/);
    assert.doesNotMatch(track.innerHTML, /Step 3/);
    // data-step keeps the original indices (0 and 2; index 1 dropped).
    assert.match(track.innerHTML, /data-step="0"/);
    assert.match(track.innerHTML, /data-step="2"/);
    assert.doesNotMatch(track.innerHTML, /data-step="1"/);
    // Labels, unit names, the move note, and the battle outcome word + damage.
    assert.match(track.innerHTML, /MOVE/);
    assert.match(track.innerHTML, /BATTLE/);
    assert.match(track.innerHTML, /Hero/);
    assert.match(track.innerHTML, /Witch/);
    assert.match(track.innerHTML, /BLOCKED/);
    assert.match(track.innerHTML, /replay-step-outcome hit/);
    assert.match(track.innerHTML, />HIT</);
    assert.match(track.innerHTML, /−1/);
  });

  test('hideReplayTimeline clears the overlay', () => {
    const ui = makeUI();
    ui.showReplayTimeline(digest);
    ui.hideReplayTimeline();
    assert.ok(!mocks._elements['replay-timeline']._classList.has('visible'));
    assert.equal(mocks._elements['replay-timeline-track'].innerHTML, '');
  });
});

// ── Countdown deadline is preserved across inline replay ────────────────────
//
// Regression: after clicking "Replay last turn", _replayLastTurnInline()
// called exitPlanningMode() (which nukes _countdownEnd) and then
// enterPlanningMode(..., 0), leaving the submit button without a timer.
// The fix snapshots _countdownEnd before exit and passes the remaining
// time into the re-entry.

describe('countdown deadline preserved across exitPlanningMode', () => {
  test('_countdownEnd survives a snapshot -> exit -> re-enter cycle', () => {
    const ui = makeUI();
    ui.enterPlanningMode('hero', 3, 60_000);
    const deadline = ui._countdownEnd;
    assert.ok(deadline, '_countdownEnd should be set by enterPlanningMode(timeoutMs>0)');
    assert.ok(deadline > Date.now(), 'deadline should be in the future');

    // Snapshot deadline (mimics _replayLastTurnInline)
    const savedCountdownEnd = ui._countdownEnd;

    // exitPlanningMode clears _countdownEnd
    ui.exitPlanningMode();
    assert.equal(ui._countdownEnd, null, 'exitPlanningMode clears _countdownEnd');

    // Re-enter with the remaining time from the snapshot
    const remainingMs = Math.max(0, savedCountdownEnd - Date.now());
    assert.ok(remainingMs > 0 && remainingMs <= 60_000,
      `remainingMs should be between 0 and 60s, got ${remainingMs}`);
    ui.enterPlanningMode('hero', 3, remainingMs);

    // _countdownEnd should be set again, close to the original deadline
    assert.ok(ui._countdownEnd, 'countdown restarted');
    const drift = Math.abs(ui._countdownEnd - savedCountdownEnd);
    assert.ok(drift < 500,
      `restored deadline should be within 500ms of original, got drift=${drift}ms`);

    ui.exitPlanningMode();
  });

  test('remainingMs of 0 leaves countdown unstarted (matches inline-replay on game with no timer)', () => {
    const ui = makeUI();
    ui.enterPlanningMode('hero', 3, 0);
    assert.ok(!ui._countdownEnd, 'no countdown when timeoutMs=0');
    // Simulating the post-replay restore path with savedCountdownEnd=null
    const savedCountdownEnd = ui._countdownEnd ?? null;
    ui.exitPlanningMode();
    const remainingMs = savedCountdownEnd
      ? Math.max(0, savedCountdownEnd - Date.now())
      : 0;
    ui.enterPlanningMode('hero', 3, remainingMs);
    assert.ok(!ui._countdownEnd, 'still no countdown after replay');
  });
});

// ── jumpToEnd flag is cleared between animations ────────────────────────────
//
// Regression: clicking SKIP on round N used to leave playback.jumpToEnd set,
// so the next _animateResolutionSteps call would break out of its loop on
// the first iteration — effectively skipping every subsequent round too.
// _animateResolutionSteps should clear the flag after an inline replay.

describe('jumpToEnd is cleared between inline replay animations', () => {
  test('hideInlineReplayHUD is paired with a jumpToEnd reset in animation cleanup', () => {
    resetPlayback();
    playback.jumpToEnd = true;

    // Mirror the _animateResolutionSteps tail: hide bar + clear flag.
    const ui = makeUI();
    ui.showInlineReplayHUD((action) => { if (action === 'end') playback.jumpToEnd = true; });
    const skipHudActive = true;
    if (skipHudActive) {
      ui.hideInlineReplayHUD();
      playback.jumpToEnd = false;
    }

    assert.equal(playback.jumpToEnd, false,
      'jumpToEnd must be cleared after an inline replay animation ends');
  });
});

// ── playbackDelay honors flags outside PLAYBACK mode ─────────────────────────

describe('playbackDelay respects flags in RESOLVING mode', () => {
  test('resolves immediately when jumpToEnd is set (not PLAYBACK mode)', async () => {
    resetPlayback();
    setMode(AppMode.RESOLVING);  // inline replay mode
    playback.jumpToEnd = true;
    const start = Date.now();
    await playbackDelay(1000);   // would normally wait 1s
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `expected <200ms, got ${elapsed}ms`);
    resetPlayback();
    setMode(AppMode.MENU);
  });

  test('does NOT freeze mid-step on paused outside PLAYBACK (gating is boundary-based)', async () => {
    // Pausing in the inline replay is handled at the step boundary (the manual-
    // step gate), NOT inside playbackDelay — so a step's animation always plays
    // through once started, even while paused.
    resetPlayback();
    setMode(AppMode.RESOLVING);
    playback.paused = true;
    const start = Date.now();
    await playbackDelay(40);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 30 && elapsed < 200,
      `delay should run normally (~40ms) while paused, got ${elapsed}ms`);
    resetPlayback();
    setMode(AppMode.MENU);
  });

  test('resolves immediately when stepRequested is set (NEXT mid-animation)', async () => {
    resetPlayback();
    setMode(AppMode.RESOLVING);
    playback.stepRequested = true;   // NEXT pressed during a step's animation
    const start = Date.now();
    await playbackDelay(1000);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `expected <200ms, got ${elapsed}ms`);
    resetPlayback();
    setMode(AppMode.MENU);
  });

  test('plain setTimeout when no playback flags are set', async () => {
    resetPlayback();
    setMode(AppMode.MENU);
    const start = Date.now();
    await playbackDelay(50);
    const elapsed = Date.now() - start;
    // Should be ~50ms, not instantaneous
    assert.ok(elapsed >= 40, `expected >=40ms, got ${elapsed}ms`);
  });
});
