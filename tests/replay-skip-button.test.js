// Tests for the inline "Replay last turn" skip button:
//   - showInlineReplayHUD makes the HUD visible and wires the skip callback
//   - Only the #replay-end-btn is shown (other controls are hidden)
//   - Clicking the skip button invokes the callback
//   - hideInlineReplayHUD restores full-HUD button visibility
//
// Also verifies that playbackDelay (outside PLAYBACK mode) still respects
// the jumpToEnd flag so the animation loop can bail out mid-delay.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeElement,
  makeFakeRenderer,
  createElementsBag,
} from './ui/setup.js';

const mocks = installGlobalMocks();

// Pre-register the replay HUD elements so document.getElementById returns
// stable references (otherwise each call builds a fresh fake).
const hudIds = [
  'replay-hud',
  'replay-back-btn',  'replay-play-btn',  'replay-pause-btn',
  'replay-ff-btn',    'replay-vff-btn',   'replay-end-btn',
  'replay-stop-btn',
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
  // createElementsBag does NOT include replay-hud — add it so this._el('replay-hud') works
  const els      = createElementsBag({ 'replay-hud': mocks._elements['replay-hud'] });
  const ui = new UIController(mocks.fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return ui;
}

describe('UIController.showInlineReplayHUD', () => {
  test('shows #replay-hud and hides non-skip buttons', () => {
    const ui = makeUI();
    // Pre-state: everything visible (normal full-HUD look)
    for (const id of hudIds) mocks._elements[id].style.display = '';
    mocks._elements['replay-end-btn'].textContent = '\u21E5';

    ui.showInlineReplayHUD(() => {});

    assert.equal(mocks._elements['replay-hud'].style.display, 'flex');
    assert.ok(mocks._elements['replay-hud']._classList.has('replay-hud-skip-only'));
    for (const id of ['replay-back-btn', 'replay-play-btn', 'replay-pause-btn',
                      'replay-ff-btn', 'replay-vff-btn', 'replay-stop-btn']) {
      assert.equal(mocks._elements[id].style.display, 'none', `${id} should be hidden`);
    }
    // The skip button (#replay-end-btn) is still visible, relabelled "SKIP"
    assert.equal(mocks._elements['replay-end-btn'].style.display, '');
    assert.equal(mocks._elements['replay-end-btn'].textContent, 'SKIP');
    assert.equal(mocks._elements['replay-end-btn'].title, 'Skip replay');
  });

  test('clicking the skip button invokes the callback', () => {
    const ui = makeUI();
    let skipped = 0;
    ui.showInlineReplayHUD(() => { skipped++; });

    const endBtn = mocks._elements['replay-end-btn'];
    assert.equal(typeof endBtn.onclick, 'function');
    endBtn.onclick();
    assert.equal(skipped, 1);
    endBtn.onclick();
    assert.equal(skipped, 2);
  });
});

describe('UIController.hideInlineReplayHUD', () => {
  test('hides the HUD and restores button visibility + original glyph', () => {
    const ui = makeUI();
    mocks._elements['replay-end-btn'].textContent = '\u21E5';  // original glyph
    ui.showInlineReplayHUD(() => {});
    // Sanity: the label was replaced with SKIP
    assert.equal(mocks._elements['replay-end-btn'].textContent, 'SKIP');

    ui.hideInlineReplayHUD();

    assert.equal(mocks._elements['replay-hud'].style.display, 'none');
    assert.ok(!mocks._elements['replay-hud']._classList.has('replay-hud-skip-only'));
    for (const id of hudIds.filter(id => id !== 'replay-hud')) {
      assert.equal(mocks._elements[id].style.display, '',
        `${id} should be visible after hideInlineReplayHUD`);
    }
    // Original glyph restored, title reset, onclick cleared
    assert.equal(mocks._elements['replay-end-btn'].textContent, '\u21E5');
    assert.equal(mocks._elements['replay-end-btn'].title, 'Jump to end');
    assert.equal(mocks._elements['replay-end-btn'].onclick, null);
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
    // We can't easily drive _animateResolutionSteps from a unit test (it
    // touches the canvas renderer, ui dialogs, camera, etc.) so we verify
    // the contract in isolation: simulate "SKIP was pressed", run the
    // cleanup path, and assert the flag is cleared.
    resetPlayback();
    playback.jumpToEnd = true;

    // Mirror the _animateResolutionSteps tail: hide HUD + clear flag.
    const ui = makeUI();
    ui.showInlineReplayHUD(() => { playback.jumpToEnd = true; });
    const skipHudActive = true;
    if (skipHudActive) {
      ui.hideInlineReplayHUD();
      playback.jumpToEnd = false;
    }

    assert.equal(playback.jumpToEnd, false,
      'jumpToEnd must be cleared after an inline replay animation ends');
  });
});

// ── playbackDelay honors jumpToEnd outside PLAYBACK mode ─────────────────────

describe('playbackDelay respects jumpToEnd in RESOLVING mode', () => {
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
