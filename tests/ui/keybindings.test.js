// Tests for the keyboard-shortcut routing core and the debug command console.
//
// Both `resolveKeyAction` and `executeConsoleCommand` are pure (no DOM), so
// these run without the browser mocks the rest of tests/ui needs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveKeyAction,
  executeConsoleCommand,
  deriveMode,
  COMMANDS,
  SHORTCUTS,
} from '../../src/keybindings.js';

// Build a synthetic keydown-like object.
function ev(key, mods = {}) {
  return { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

describe('resolveKeyAction — console + help', () => {
  test('Escape toggles the console from any mode', () => {
    assert.deepEqual(resolveKeyAction(ev('Escape'), { appMode: 'MENU' }), { id: 'console-toggle' });
    assert.deepEqual(resolveKeyAction(ev('Escape'), { appMode: 'PLANNING' }), { id: 'console-toggle' });
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

  test('F focuses and M fits, in any in-game mode', () => {
    assert.deepEqual(resolveKeyAction(ev('f'), { appMode: 'RESOLVING' }), { id: 'focus-unit' });
    assert.deepEqual(resolveKeyAction(ev('M'), { appMode: 'SPECTATING' }), { id: 'fit-map' });
    assert.equal(resolveKeyAction(ev('f'), { appMode: 'MENU' }), null);
  });

  test('X clears actions only while planning', () => {
    assert.deepEqual(resolveKeyAction(ev('x'), { appMode: 'PLANNING' }), { id: 'clear-unit' });
    assert.equal(resolveKeyAction(ev('x'), { appMode: 'SUMMARY' }), null);
  });

  test('Space advances replay only in playback', () => {
    assert.deepEqual(resolveKeyAction(ev(' '), { appMode: 'PLAYBACK' }), { id: 'replay-next' });
    assert.equal(resolveKeyAction(ev(' '), { appMode: 'PLANNING' }), null);
  });

  test('Enter submits (Shift, planning) or continues (plain, summary)', () => {
    assert.deepEqual(resolveKeyAction(ev('Enter', { shiftKey: true }), { appMode: 'PLANNING' }), { id: 'submit-plan' });
    assert.deepEqual(resolveKeyAction(ev('Enter'), { appMode: 'SUMMARY' }), { id: 'summary-continue' });
    // Plain Enter while planning is not a submit (avoids accidental submits).
    assert.equal(resolveKeyAction(ev('Enter'), { appMode: 'PLANNING' }), null);
    // Shift+Enter outside planning does nothing.
    assert.equal(resolveKeyAction(ev('Enter', { shiftKey: true }), { appMode: 'SUMMARY' }), null);
  });
});

describe('executeConsoleCommand', () => {
  function makeCtx() {
    const calls = [];
    const renderer = {
      _toggleInspector:    () => calls.push('inspector'),
      _toggleBorderForest: () => calls.push('forest'),
      _cycleFogDebugMode:  () => calls.push('fog'),
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

  test('errors thrown by a command are caught', () => {
    const renderer = { _toggleInspector: () => { throw new Error('boom'); } };
    const res = executeConsoleCommand('/inspector', { renderer });
    assert.equal(res.ok, false);
    assert.match(res.message, /boom/);
  });
});

describe('deriveMode — robust to the offline AppMode gap', () => {
  test('planning flags win regardless of stale appMode', () => {
    // Offline round 1: appMode is still MENU but the UI is in planning.
    assert.equal(deriveMode({ planMode: true, appMode: 'MENU' }), 'PLANNING');
    // Offline later rounds: appMode stuck at RESOLVING, but planning again.
    assert.equal(deriveMode({ planMode: true, appMode: 'RESOLVING' }), 'PLANNING');
    assert.equal(deriveMode({ planMode: true, planSubmitted: true, appMode: 'MENU' }), 'SUBMITTED');
  });

  test('summary and replay are detected without appMode help', () => {
    assert.equal(deriveMode({ summaryVisible: true, appMode: 'RESOLVING' }), 'SUMMARY');
    assert.equal(deriveMode({ replayActive: true, appMode: 'MENU' }), 'PLAYBACK');
    // Summary takes precedence over a lingering replay bar.
    assert.equal(deriveMode({ summaryVisible: true, replayActive: true }), 'SUMMARY');
  });

  test('falls back to appMode, then MENU', () => {
    assert.equal(deriveMode({ appMode: 'RESOLVING' }), 'RESOLVING');
    assert.equal(deriveMode({ appMode: 'SPECTATING' }), 'SPECTATING');
    assert.equal(deriveMode({}), 'MENU');
    assert.equal(deriveMode(), 'MENU');
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
