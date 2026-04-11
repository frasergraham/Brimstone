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

    ui.showInlineReplayHUD(() => {});

    assert.equal(mocks._elements['replay-hud'].style.display, 'flex');
    assert.ok(mocks._elements['replay-hud']._classList.has('replay-hud-skip-only'));
    for (const id of ['replay-back-btn', 'replay-play-btn', 'replay-pause-btn',
                      'replay-ff-btn', 'replay-vff-btn', 'replay-stop-btn']) {
      assert.equal(mocks._elements[id].style.display, 'none', `${id} should be hidden`);
    }
    // The skip button (#replay-end-btn) is still visible
    assert.equal(mocks._elements['replay-end-btn'].style.display, '');
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
  test('hides the HUD and restores button visibility', () => {
    const ui = makeUI();
    ui.showInlineReplayHUD(() => {});
    ui.hideInlineReplayHUD();

    assert.equal(mocks._elements['replay-hud'].style.display, 'none');
    assert.ok(!mocks._elements['replay-hud']._classList.has('replay-hud-skip-only'));
    for (const id of hudIds.filter(id => id !== 'replay-hud')) {
      assert.equal(mocks._elements[id].style.display, '',
        `${id} should be visible after hideInlineReplayHUD`);
    }
    // Skip button's title restored, onclick cleared
    assert.equal(mocks._elements['replay-end-btn'].title, 'Jump to end');
    assert.equal(mocks._elements['replay-end-btn'].onclick, null);
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
