// Regression test for the scrollable-turn-cards listener-leak bug.
//
// `_bindTurnCardScrollDetection` attaches wheel + touchmove listeners on the
// (persistent) #replay-timeline element. They MUST share the UIController-wide
// AbortController (`_eventsAC`) so `destroy()` removes them — otherwise an
// orphaned controller keeps firing on shared replay DOM in the next game.
// This pins down the same invariant as tests/ui/action-panel-stuck.test.js
// for the new listeners.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeElement,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';

const { fakeCanvas, _elements } = installGlobalMocks();

let UIController, GameState;

before(async () => {
  const [uiMod, gameMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
});

// Listener-tracking fake element. Records (type, fn) pairs, honours the
// AbortSignal passed via `{ signal }` (removes the listener when aborted —
// exactly like the real DOM), and can dispatch synthetic events.
function makeTrackingEl(id = '') {
  const el = makeFakeElement(id);
  const records = [];
  el.addEventListener = (type, fn, opts) => {
    const signal = opts && opts.signal;
    if (signal && signal.aborted) return;
    const rec = { type, fn, opts };
    records.push(rec);
    if (signal) {
      signal.addEventListener('abort', () => {
        const i = records.indexOf(rec);
        if (i >= 0) records.splice(i, 1);
      }, { once: true });
    }
  };
  el.removeEventListener = (type, fn) => {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].type === type && records[i].fn === fn) records.splice(i, 1);
    }
  };
  el._records = records;
  el.dispatch = (type) => {
    const e = { preventDefault() {}, stopPropagation() {} };
    records.filter(r => r.type === type).slice().forEach(r => r.fn(e));
  };
  return el;
}

function makeUI(timelineEl) {
  const state = new GameState(true, false);
  const els = createElementsBag({ 'replay-timeline': timelineEl });
  return new UIController(fakeCanvas, state, makeFakeRenderer(), null, () => {}, null, false, els);
}

describe('turn-card scroll-detection listener lifecycle', () => {
  test('wheel + touchmove listeners bind with the UIController AbortSignal', () => {
    const wrap = makeTrackingEl('replay-timeline');
    const ui   = makeUI(wrap);
    ui._bindTurnCardScrollDetection();

    const types = wrap._records.map(r => r.type).sort();
    assert.deepEqual(types, ['scroll', 'touchmove', 'wheel'],
      'wheel + touchmove (user-scroll detection) + capture-phase scroll (fade masks) are bound; keydown is dropped (non-focusable element)');

    // Every binding must pass { signal: <_eventsAC.signal> } so destroy() drops it.
    for (const rec of wrap._records) {
      assert.ok(rec.opts && rec.opts.signal,
        `${rec.type} listener must pass an AbortSignal in its options`);
      assert.equal(rec.opts.signal, ui._eventsAC.signal,
        `${rec.type} listener must use UIController._eventsAC.signal — not a fresh one`);
    }
  });

  test('destroy() removes the wheel/touchmove listeners — no orphan firing', () => {
    const wrap = makeTrackingEl('replay-timeline');
    const ui   = makeUI(wrap);
    ui._bindTurnCardScrollDetection();

    // Sanity: a wheel before destroy notifies the auto-scroll controller.
    let scrollCalls = 0;
    ui._turnCardAutoScroll = { notifyUserScroll: () => { scrollCalls++; }, isSuspended: () => false };
    wrap.dispatch('wheel');
    assert.equal(scrollCalls, 1, 'wheel notifies the auto-scroll controller while UI is live');

    // After destroy, the listener must be gone — no orphan fires.
    ui.destroy();
    assert.equal(wrap._records.length, 0,
      'destroy() must abort all scroll listeners on the shared replay-timeline');
    scrollCalls = 0;
    wrap.dispatch('wheel');
    assert.equal(scrollCalls, 0,
      'a destroyed UIController must not notify on a wheel — the leak that broke the action panel');
  });

  test('two UIControllers sharing replay-timeline: destroying the orphan stops its scroll listener', () => {
    const wrap = makeTrackingEl('replay-timeline');
    const uiA  = makeUI(wrap);
    const uiB  = makeUI(wrap);
    uiA._bindTurnCardScrollDetection();
    uiB._bindTurnCardScrollDetection();

    let aCalls = 0, bCalls = 0;
    uiA._turnCardAutoScroll = { notifyUserScroll: () => { aCalls++; }, isSuspended: () => false };
    uiB._turnCardAutoScroll = { notifyUserScroll: () => { bCalls++; }, isSuspended: () => false };

    // Orphan condition: uiA was never destroyed → both controllers handle the wheel.
    wrap.dispatch('wheel');
    assert.equal(aCalls, 1, 'orphaned UI_A still receives the wheel — the leak');
    assert.equal(bCalls, 1, 'UI_B receives it too');

    // Fix: destroying the orphan removes only its listeners; UI_B keeps firing.
    aCalls = 0; bCalls = 0;
    uiA.destroy();
    wrap.dispatch('wheel');
    assert.equal(aCalls, 0, 'destroyed UI_A no longer notifies its auto-scroll');
    assert.equal(bCalls, 1, 'UI_B still notifies — only the orphan is detached');
  });
});
