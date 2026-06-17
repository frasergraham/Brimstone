// Regression tests for the "in-game action panel stops responding to clicks"
// bug (operator-reported, intermittent).
//
// Root cause: leaked event listeners that survive teardown and keep firing on
// shared DOM elements.
//
//   1. MissionConductor wired a `.tut-next-btn` click listener in its
//      constructor with NO cleanup — destroy() never removed it. Replaying /
//      abandoning conductor-driven missions accumulated handlers on the shared
//      button; stale ones re-fired _onNextClick() (and spurious onComplete
//      callbacks) on later missions.
//
//   2. Several main.js teardown paths nulled `ui` WITHOUT calling
//      `ui.destroy()`, orphaning the UIController's listeners on the shared
//      canvas / plan-panel buttons. The next game's UIController then
//      double-bound every handler, so `plan-toggle-btn` ran _togglePlanPanel()
//      twice per click → net no-op → the action panel appeared "stuck".
//
// These tests pin both invariants:
//   - MissionConductor.destroy() must remove its tut-next listener.
//   - UIController.destroy() must remove the plan-panel toggle listener, so an
//     orphaned (undestroyed) controller is the only way clicks double-fire.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeElement,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';

// Install globals before any module that touches document/canvas loads.
const { fakeCanvas, _elements } = installGlobalMocks();

let UIController, GameState, MissionConductor;

before(async () => {
  const [uiMod, gameMod, condMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
    import('../../src/mission-conductor.js'),
  ]);
  UIController     = uiMod.UIController;
  GameState        = gameMod.GameState;
  MissionConductor = condMod.MissionConductor;
});

// ── Listener-tracking fake element ────────────────────────────────────────────
// Unlike the default no-op fake, this records (type, fn) pairs, honours the
// AbortSignal passed via `{ signal }` (removing the listener when aborted —
// exactly like the real DOM), and can dispatch synthetic events.
function makeTrackingEl(id = '') {
  const el = makeFakeElement(id);
  const records = [];
  el.addEventListener = (type, fn, opts) => {
    const signal = opts && opts.signal;
    if (signal && signal.aborted) return;
    const rec = { type, fn };
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
    // Copy so a handler that detaches itself mid-dispatch doesn't skip siblings.
    records.filter(r => r.type === type).slice().forEach(r => r.fn(e));
  };
  return el;
}

// ── MissionConductor leak ─────────────────────────────────────────────────────

function makeConductor(steps, config) {
  // A tooltip whose querySelector returns trackable children, so the conductor's
  // `.tut-next-btn` lookup yields a listener-recording button we can click.
  const nextBtn = makeTrackingEl('tut-next-btn');
  const titleEl = makeFakeElement('tut-title');
  const bodyEl  = makeFakeElement('tut-body');
  const tooltip = makeFakeElement('tutorial-tooltip');
  tooltip.querySelector = (sel) => {
    if (sel === '.tut-title')    return titleEl;
    if (sel === '.tut-body')     return bodyEl;
    if (sel === '.tut-next-btn') return nextBtn;
    return makeFakeElement('queried');
  };
  _elements['tutorial-tooltip'] = tooltip;

  const ui       = {};                       // _showStep only sets flag props
  const renderer = { tutorialSpotlightHex: null };
  const conductor = new MissionConductor(
    /* state    */ { entities: [] },
    /* ui       */ ui,
    /* renderer */ renderer,
    /* redraw   */ () => {},
    steps,
    config,
  );
  return { conductor, nextBtn };
}

describe('MissionConductor tut-next listener lifecycle', () => {
  test('clicking tut-next fires onComplete while the conductor is active (sanity)', () => {
    let completeCalls = 0;
    const steps = [{ id: 's0', title: 'T', body: 'B', trigger: 'complete' }];
    const { conductor, nextBtn } = makeConductor(steps, { onComplete: () => { completeCalls++; } });
    conductor.start();          // shows the complete step → Next button visible
    nextBtn.dispatch('click');
    assert.equal(completeCalls, 1, 'onComplete should fire on a live conductor');
  });

  test('destroy() removes the tut-next listener so it cannot fire after teardown', () => {
    let completeCalls = 0;
    const steps = [{ id: 's0', title: 'T', body: 'B', trigger: 'complete' }];
    const { conductor, nextBtn } = makeConductor(steps, { onComplete: () => { completeCalls++; } });
    conductor.start();
    conductor.destroy();        // <-- must detach the leaked listener
    nextBtn.dispatch('click');  // a stale click after the mission was torn down
    assert.equal(completeCalls, 0,
      'a destroyed conductor must NOT re-fire onComplete (the leak that froze the UI)');
  });
});

// ── UIController orphan double-fire ───────────────────────────────────────────

function makeUI(els) {
  const state = new GameState(true, false);
  return new UIController(fakeCanvas, state, makeFakeRenderer(), null, () => {}, null, false, els);
}

describe('UIController plan-panel toggle listener lifecycle', () => {
  test('an undestroyed orphan double-fires the toggle (stuck); destroy() restores it', () => {
    const els = createElementsBag();
    const toggleBtn = makeTrackingEl('plan-toggle-btn');
    els['plan-toggle-btn'] = toggleBtn;

    const uiA = makeUI(els);
    const uiB = makeUI(els);   // second game's controller, sharing the same DOM

    let aCalls = 0, bCalls = 0;
    uiA._togglePlanPanel = () => { aCalls++; };
    uiB._togglePlanPanel = () => { bCalls++; };

    // BUG condition: uiA was never destroyed, so its listener is still live.
    toggleBtn.dispatch('click');
    assert.equal(aCalls, 1, 'orphaned UI_A still receives the click — the leak');
    assert.equal(bCalls, 1, 'UI_B also receives it → toggle fires twice = stuck');

    // FIX: destroying the orphan removes its listener (what the main.js teardown
    // paths now do before nulling `ui`).
    aCalls = 0; bCalls = 0;
    uiA.destroy();
    toggleBtn.dispatch('click');
    assert.equal(aCalls, 0, 'destroyed UI_A no longer receives the click');
    assert.equal(bCalls, 1, 'only UI_B toggles → panel responsive again');
  });
});
