// Tests for the keyboard-shortcut routing core and the debug command console.
//
// Both `resolveKeyAction` and `executeConsoleCommand` are pure (no DOM), so
// these run without the browser mocks the rest of tests/ui needs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveKeyAction,
  executeConsoleCommand,
  formatSeedLine,
  COMMANDS,
  SHORTCUTS,
} from '../../src/keybindings.js';
import {
  isAllyLungeEnabled,
  setAllyLungeEnabled,
  toggleAllyLunge,
} from '../../src/debug-flags.js';

// Build a synthetic keydown-like object.
function ev(key, mods = {}) {
  return { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

describe('resolveKeyAction — console + help', () => {
  test('Backtick toggles the console from any mode', () => {
    assert.deepEqual(resolveKeyAction(ev('`'), { appMode: 'MENU' }), { id: 'console-toggle' });
    assert.deepEqual(resolveKeyAction(ev('`'), { appMode: 'PLANNING' }), { id: 'console-toggle' });
  });

  test('Escape deselects in-game, no-ops in the menu', () => {
    assert.deepEqual(resolveKeyAction(ev('Escape'), { appMode: 'PLANNING' }), { id: 'deselect' });
    assert.equal(resolveKeyAction(ev('Escape'), { appMode: 'MENU' }), null);
  });

  test('H shows help only while in a game', () => {
    assert.deepEqual(resolveKeyAction(ev('h'), { appMode: 'PLANNING' }), { id: 'help-show' });
    assert.deepEqual(resolveKeyAction(ev('H'), { appMode: 'PLAYBACK' }), { id: 'help-show' });
    assert.equal(resolveKeyAction(ev('h'), { appMode: 'MENU' }), null);
  });
});

describe('resolveKeyAction — modifiers are respected', () => {
  test('Ctrl/Cmd/Alt combos are never intercepted', () => {
    assert.equal(resolveKeyAction(ev('f', { ctrlKey: true }), { appMode: 'PLANNING' }), null);
    assert.equal(resolveKeyAction(ev('m', { metaKey: true }), { appMode: 'PLANNING' }), null);
    assert.equal(resolveKeyAction(ev('ArrowUp', { altKey: true }), { appMode: 'PLANNING' }), null);
  });
});

describe('resolveKeyAction — arrows pan / rotate / zoom', () => {
  test('plain arrows pan with screen deltas', () => {
    assert.deepEqual(resolveKeyAction(ev('ArrowLeft'),  { appMode: 'PLANNING' }), { id: 'pan', dx: -1, dy: 0 });
    assert.deepEqual(resolveKeyAction(ev('ArrowRight'), { appMode: 'PLANNING' }), { id: 'pan', dx: 1, dy: 0 });
    assert.deepEqual(resolveKeyAction(ev('ArrowUp'),    { appMode: 'PLANNING' }), { id: 'pan', dx: 0, dy: -1 });
    assert.deepEqual(resolveKeyAction(ev('ArrowDown'),  { appMode: 'PLANNING' }), { id: 'pan', dx: 0, dy: 1 });
  });

  test('Shift + left/right rotate, Shift + up/down zoom', () => {
    assert.deepEqual(resolveKeyAction(ev('ArrowLeft',  { shiftKey: true }), { appMode: 'PLAYBACK' }), { id: 'rotate', dir: -1 });
    assert.deepEqual(resolveKeyAction(ev('ArrowRight', { shiftKey: true }), { appMode: 'PLAYBACK' }), { id: 'rotate', dir: 1 });
    assert.deepEqual(resolveKeyAction(ev('ArrowUp',    { shiftKey: true }), { appMode: 'PLAYBACK' }), { id: 'zoom', dir: 1 });
    assert.deepEqual(resolveKeyAction(ev('ArrowDown',  { shiftKey: true }), { appMode: 'PLAYBACK' }), { id: 'zoom', dir: -1 });
  });

  test('arrows do nothing in the menu', () => {
    assert.equal(resolveKeyAction(ev('ArrowLeft'), { appMode: 'MENU' }), null);
  });
});

describe('resolveKeyAction — unit + plan controls', () => {
  test('Tab / Shift+Tab cycle units only while planning', () => {
    assert.deepEqual(resolveKeyAction(ev('Tab'), { appMode: 'PLANNING' }), { id: 'cycle-unit', dir: 1 });
    assert.deepEqual(resolveKeyAction(ev('Tab', { shiftKey: true }), { appMode: 'PLANNING' }), { id: 'cycle-unit', dir: -1 });
    assert.equal(resolveKeyAction(ev('Tab'), { appMode: 'PLAYBACK' }), null);
  });

  test('Tab / Shift+Tab scrub turn cards while the summary review is up', () => {
    // reviewActive = the wrap-up review (scrub arrows visible). Tab moves
    // right through the cards, Shift+Tab left — same as clicking ◀ ▶.
    assert.deepEqual(resolveKeyAction(ev('Tab'), { appMode: 'SUMMARY', reviewActive: true }), { id: 'review-scrub', dir: 1 });
    assert.deepEqual(resolveKeyAction(ev('Tab', { shiftKey: true }), { appMode: 'SUMMARY', reviewActive: true }), { id: 'review-scrub', dir: -1 });
    // Review takes precedence over unit cycling regardless of mode.
    assert.deepEqual(resolveKeyAction(ev('Tab'), { appMode: 'PLAYBACK', reviewActive: true }), { id: 'review-scrub', dir: 1 });
    // No review up → unchanged behaviour.
    assert.equal(resolveKeyAction(ev('Tab'), { appMode: 'SUMMARY' }), null);
  });

  test('F focuses and M fits, in any in-game mode', () => {
    assert.deepEqual(resolveKeyAction(ev('f'), { appMode: 'RESOLVING' }), { id: 'focus-unit' });
    assert.deepEqual(resolveKeyAction(ev('M'), { appMode: 'SPECTATING' }), { id: 'fit-map' });
    assert.equal(resolveKeyAction(ev('f'), { appMode: 'MENU' }), null);
  });

  test('X clears actions only while planning', () => {
    assert.deepEqual(resolveKeyAction(ev('x'), { appMode: 'PLANNING' }), { id: 'clear-unit' });
    assert.equal(resolveKeyAction(ev('x'), { appMode: 'SUMMARY' }), null);
  });

  test('Space and Enter both advance — replay step bar OR round summary', () => {
    // One shared 'advance' action: the executor clicks whichever affordance is
    // on screen (combat Continue, summary Continue, replay NEXT). Keys off
    // replayActive (covers full PLAYBACK and the inline RESOLVING replay) or
    // the SUMMARY mode.
    for (const key of [' ', 'Enter']) {
      assert.deepEqual(resolveKeyAction(ev(key), { appMode: 'PLAYBACK', replayActive: true }), { id: 'advance' });
      assert.deepEqual(resolveKeyAction(ev(key), { appMode: 'RESOLVING', replayActive: true }), { id: 'advance' });
      assert.deepEqual(resolveKeyAction(ev(key), { appMode: 'SUMMARY' }), { id: 'advance' });
      // Plain Space/Enter while planning does nothing (avoids accidental submits).
      assert.equal(resolveKeyAction(ev(key), { appMode: 'PLANNING' }), null);
    }
    assert.equal(resolveKeyAction(ev(' '), { appMode: 'PLAYBACK', replayActive: false }), null);
  });

  test('Shift+Enter submits the plan, planning only', () => {
    assert.deepEqual(resolveKeyAction(ev('Enter', { shiftKey: true }), { appMode: 'PLANNING' }), { id: 'submit-plan' });
    // Shift+Enter outside planning does nothing — not even advance.
    assert.equal(resolveKeyAction(ev('Enter', { shiftKey: true }), { appMode: 'SUMMARY' }), null);
  });

  test('P toggles replay auto-play only while a replay step bar is on screen', () => {
    // replayActive covers BOTH the full-game replay (PLAYBACK) and the inline
    // round-end resolution replay (RESOLVING) — the executor clicks the same
    // #replay-playpause-btn for either.
    for (const key of ['p', 'P']) {
      assert.deepEqual(resolveKeyAction(ev(key), { appMode: 'PLAYBACK', replayActive: true }), { id: 'replay-playpause' });
      assert.deepEqual(resolveKeyAction(ev(key), { appMode: 'RESOLVING', replayActive: true }), { id: 'replay-playpause' });
    }
    // Inert when no replay bar is up — must not hijack P during planning or the
    // static round-summary review.
    assert.equal(resolveKeyAction(ev('p'), { appMode: 'PLAYBACK', replayActive: false }), null);
    assert.equal(resolveKeyAction(ev('p'), { appMode: 'PLANNING' }), null);
    assert.equal(resolveKeyAction(ev('p'), { appMode: 'SUMMARY' }), null);
    // Shift+P is not bound (leaves the chord free).
    assert.equal(resolveKeyAction(ev('P', { shiftKey: true }), { appMode: 'PLAYBACK', replayActive: true }), null);
  });
});

describe('executeConsoleCommand', () => {
  function makeCtx() {
    const calls = [];
    const renderer = {
      _toggleInspector:    () => calls.push('inspector'),
      _toggleBorderForest: () => calls.push('forest'),
      _cycleFogDebugMode:  () => calls.push('fog'),
      _toggleFpsCounter:   () => { calls.push('fps'); return 'FPS counter shown'; },
    };
    return { renderer, calls };
  }

  test('dispatches /inspector, /forest, /fog to the renderer', () => {
    const { renderer, calls } = makeCtx();
    assert.equal(executeConsoleCommand('/inspector', { renderer }).ok, true);
    assert.equal(executeConsoleCommand('/forest', { renderer }).ok, true);
    assert.equal(executeConsoleCommand('/fog', { renderer }).ok, true);
    assert.deepEqual(calls, ['inspector', 'forest', 'fog']);
  });

  test('/fps toggles the FPS counter and echoes the renderer status', () => {
    const { renderer, calls } = makeCtx();
    const res = executeConsoleCommand('/fps', { renderer });
    assert.equal(res.ok, true);
    assert.equal(res.message, 'FPS counter shown');
    assert.deepEqual(calls, ['fps']);
  });

  test('/help lists the fps command', () => {
    const res = executeConsoleCommand('/help', {});
    assert.equal(res.ok, true);
    assert.match(res.message, /\/fps/);
  });

  test('leading slash is optional and names are case-insensitive', () => {
    const { renderer, calls } = makeCtx();
    executeConsoleCommand('INSPECTOR', { renderer });
    assert.deepEqual(calls, ['inspector']);
  });

  test('blank input is a no-op', () => {
    const { renderer, calls } = makeCtx();
    const res = executeConsoleCommand('   ', { renderer });
    assert.equal(res.ok, false);
    assert.deepEqual(calls, []);
  });

  test('unknown command reports an error and runs nothing', () => {
    const { renderer, calls } = makeCtx();
    const res = executeConsoleCommand('/nope', { renderer });
    assert.equal(res.ok, false);
    assert.match(res.message, /Unknown command/);
    assert.deepEqual(calls, []);
  });

  test('/help lists every registered command', () => {
    const res = executeConsoleCommand('/help', {});
    assert.equal(res.ok, true);
    for (const name of Object.keys(COMMANDS)) {
      assert.match(res.message, new RegExp(`/${name}`));
    }
  });

  test('/aiassist parses modes and delegates to ui.setAIAssistMode', () => {
    const calls = [];
    const ui = {
      setAIAssistMode: (mode) => {
        calls.push(mode);
        const autorun = mode === 'auto';
        return { enabled: autorun || (!!mode && mode !== 'off'), autorun };
      },
    };
    // Default → manual on.
    let res = executeConsoleCommand('/aiassist', { ui });
    assert.equal(res.ok, true);
    assert.match(res.message, /AI-assist ON/);
    // auto → autorun.
    res = executeConsoleCommand('/aiassist auto', { ui });
    assert.match(res.message, /Autorun ON/);
    // off → disabled.
    res = executeConsoleCommand('/aiassist off', { ui });
    assert.match(res.message, /off/i);
    assert.deepEqual(calls, [true, 'auto', false]);
  });

  test('/aiassist without a loaded game reports unavailable', () => {
    const res = executeConsoleCommand('/aiassist', { ui: null });
    assert.equal(res.ok, true);
    assert.match(res.message, /start a mission first/i);
  });

  test('errors thrown by a command are caught', () => {
    const renderer = { _toggleInspector: () => { throw new Error('boom'); } };
    const res = executeConsoleCommand('/inspector', { renderer });
    assert.equal(res.ok, false);
    assert.match(res.message, /boom/);
  });
});

describe('formatSeedLine + /seed command', () => {
  test('formats a live state seed + size with dimensions', () => {
    const line = formatSeedLine({ mapSeed: 12345, mapSize: 'standard' });
    assert.equal(line, '🌱 seed: 12345 · size: standard (14×14)');
  });

  test('reflects the actual map size dimensions (skirmish 10×10)', () => {
    const line = formatSeedLine({ mapSeed: 7, mapSize: 'skirmish' });
    assert.match(line, /size: skirmish \(10×10\)/);
    assert.match(line, /seed: 7/);
  });

  test('a pre-built (override) map has no numeric seed', () => {
    const line = formatSeedLine({ mapSeed: null, mapSize: 'standard' });
    assert.match(line, /n\/a \(pre-built map\)/);
    assert.match(line, /size: standard/);
  });

  test('unknown map size falls back to ?×? rather than throwing', () => {
    const line = formatSeedLine({ mapSeed: 1, mapSize: 'nonsense' });
    assert.match(line, /size: nonsense \(\?×\?\)/);
  });

  test('no active game is handled gracefully', () => {
    assert.match(formatSeedLine(null), /No active game/);
    assert.match(formatSeedLine(undefined), /No active game/);
  });

  test('/seed reads ui.state and echoes the seed line', () => {
    const res = executeConsoleCommand('/seed', { ui: { state: { mapSeed: 999, mapSize: 'standard' } } });
    assert.equal(res.ok, true);
    assert.match(res.message, /seed: 999/);
    assert.match(res.message, /standard \(14×14\)/);
  });

  test('/seed without a loaded game reports no active game', () => {
    const res = executeConsoleCommand('/seed', { ui: null });
    assert.equal(res.ok, true);
    assert.match(res.message, /No active game/);
  });
});

describe('ally-lunge debug flag + /lunge command', () => {
  test('the flag defaults to OFF (lunge disabled)', () => {
    // First lunge test in the file — the flag is still at its module default.
    assert.equal(isAllyLungeEnabled(), false);
  });

  test('setAllyLungeEnabled / toggleAllyLunge return the new state', () => {
    assert.equal(setAllyLungeEnabled(false), false);
    assert.equal(isAllyLungeEnabled(), false);
    assert.equal(toggleAllyLunge(), true);
    assert.equal(isAllyLungeEnabled(), true);
    assert.equal(toggleAllyLunge(), false);
    assert.equal(isAllyLungeEnabled(), false);
    // Restore the default so test order can't leak into other suites.
    setAllyLungeEnabled(false);
  });

  test('/lunge flips the flag and reports the new state', () => {
    setAllyLungeEnabled(true);
    let res = executeConsoleCommand('/lunge', {});
    assert.equal(res.ok, true);
    assert.match(res.message, /OFF/);
    assert.equal(isAllyLungeEnabled(), false);

    res = executeConsoleCommand('/lunge', {});
    assert.equal(res.ok, true);
    assert.match(res.message, /ON/);
    assert.equal(isAllyLungeEnabled(), true);
  });
});

describe('SHORTCUTS metadata', () => {
  test('is a non-empty frozen list of {keys,label}', () => {
    assert.ok(SHORTCUTS.length > 0);
    assert.throws(() => { SHORTCUTS.push({}); }, TypeError);
    for (const s of SHORTCUTS) {
      assert.equal(typeof s.keys, 'string');
      assert.equal(typeof s.label, 'string');
    }
  });
});
