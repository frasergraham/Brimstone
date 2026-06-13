// Unit tests for the shared fast / vfast combat-display helper.
//
// The helper is lifted out of src/main.js so the live game and the admin
// combat tester drive the no-modal fast presentation through one code path.
// Renderer methods are stubbed and we assert the call shape — addFlash with
// the miss text / colour / duration, then playBattleResultAnims, then the
// playbackDelay matched to the speed.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { playFastCombatDisplay } from '../src/combat-fast.js';

function _fakeRenderer() {
  const calls = [];
  return {
    addFlash(...args) { calls.push(['addFlash', ...args]); },
    calls,
  };
}

const ACTOR  = { id: 1, col: 4, row: 4, owner: 'hero',  type: 'paladin', title: null };
const TARGET = { id: 2, col: 5, row: 4, owner: 'witch', type: 'witch',   title: null };

describe('playFastCombatDisplay — miss flash', () => {
  test('paints the miss-word flash on the target hex with the shared colour / duration', async () => {
    const renderer = _fakeRenderer();
    const animCalls = [];
    const delays = [];
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: false },
      playBattleResultAnims: (...args) => animCalls.push(args),
      speed: 'fast',
      missText: 'BLOCK',
      playbackDelay: (ms) => { delays.push(ms); return Promise.resolve(); },
    });
    // addFlash: target col/row + miss word + the fixed background / duration
    // / zoom / fg colour pulled from the helper's constants.
    const flash = renderer.calls.find(c => c[0] === 'addFlash');
    assert.ok(flash, 'addFlash should be called on a miss');
    assert.equal(flash[1], TARGET.col);
    assert.equal(flash[2], TARGET.row);
    assert.equal(flash[3], 'BLOCK');
    assert.equal(flash[4], 'rgba(100,100,100,0.1)');
    assert.equal(flash[5], 1000);
    assert.equal(flash[6], 0.65);
    assert.equal(flash[7], '#888');
    // Floaters fired AFTER addFlash, BEFORE the delay.
    assert.equal(animCalls.length, 1);
    assert.deepEqual(animCalls[0], [ACTOR, TARGET, { hit: false }]);
    // fast → 400ms.
    assert.deepEqual(delays, [400]);
  });

  test('vfast uses the shorter 200ms wait', async () => {
    const renderer = _fakeRenderer();
    const delays = [];
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: true, damage: 1 },
      playBattleResultAnims: () => {},
      speed: 'vfast',
      missText: null,
      playbackDelay: (ms) => { delays.push(ms); return Promise.resolve(); },
    });
    assert.deepEqual(delays, [200]);
  });
});

describe('playFastCombatDisplay — hit path skips the miss flash', () => {
  test('result.hit=true: no addFlash, floaters + delay only', async () => {
    const renderer = _fakeRenderer();
    const animCalls = [];
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: true, damage: 2 },
      playBattleResultAnims: (...args) => animCalls.push(args),
      speed: 'fast',
      missText: 'BLOCK',  // would be ignored on a hit anyway
      playbackDelay: () => Promise.resolve(),
    });
    assert.equal(renderer.calls.length, 0, 'no addFlash on a hit');
    assert.equal(animCalls.length, 1);
  });

  test('missText=null on a miss: no addFlash, floaters still fire', async () => {
    // The live game picks the miss word only when needed so the Math.random()
    // sequence stays identical to the pre-refactor behaviour. The helper has
    // to tolerate a null missText on a miss without painting an empty flash.
    const renderer = _fakeRenderer();
    const animCalls = [];
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: false },
      playBattleResultAnims: (...args) => animCalls.push(args),
      speed: 'fast',
      missText: null,
      playbackDelay: () => Promise.resolve(),
    });
    assert.equal(renderer.calls.length, 0);
    assert.equal(animCalls.length, 1);
  });
});

describe('playFastCombatDisplay — Summary (fast) final-score readouts', () => {
  const READOUT_RENDERER = () => {
    const readouts = [];
    return {
      addCombatReadout(id, side, result, opts) { readouts.push({ id, side, result, opts }); },
      addFlash(...args) { (this.flashes ??= []).push(args); },
      readouts,
    };
  };

  test('fast spawns a summaryOnly readout over attacker AND defender', async () => {
    const renderer = READOUT_RENDERER();
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: true, damage: 1 },
      playBattleResultAnims: () => {},
      speed: 'fast', missText: null,
      playbackDelay: () => Promise.resolve(),
    });
    assert.equal(renderer.readouts.length, 2);
    assert.deepEqual(renderer.readouts.map(r => [r.id, r.side]),
      [[ACTOR.id, 'attacker'], [TARGET.id, 'defender']]);
    for (const r of renderer.readouts) {
      assert.equal(r.opts.summaryOnly, true, 'readout skips the dice stack-up');
      assert.equal(r.opts.attackerCol, ACTOR.col);
      assert.equal(r.opts.targetCol, TARGET.col);
      assert.equal(typeof r.opts.awaitContinueFn, 'function');
    }
  });

  test('fast miss: readouts shown, hex miss-flash suppressed (label covers it)', async () => {
    const renderer = READOUT_RENDERER();
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: false },
      playBattleResultAnims: () => {},
      speed: 'fast', missText: 'BLOCK',
      playbackDelay: () => Promise.resolve(),
    });
    assert.equal(renderer.readouts.length, 2);
    assert.equal(renderer.flashes ?? undefined, undefined, 'no addFlash when readouts are up');
  });

  test('vfast (Speedy) stays readout-free and keeps the miss flash', async () => {
    const renderer = READOUT_RENDERER();
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: false },
      playBattleResultAnims: () => {},
      speed: 'vfast', missText: 'BLOCK',
      playbackDelay: () => Promise.resolve(),
    });
    assert.equal(renderer.readouts.length, 0);
    assert.equal(renderer.flashes.length, 1);
  });
});

describe('playFastCombatDisplay — ordering and optional anim callback', () => {
  test('addFlash → playBattleResultAnims → playbackDelay (in that order)', async () => {
    const order = [];
    const renderer = {
      addFlash() { order.push('flash'); },
    };
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: false },
      playBattleResultAnims: () => order.push('anims'),
      speed: 'fast',
      missText: 'BLOCK',
      playbackDelay: () => { order.push('delay'); return Promise.resolve(); },
    });
    assert.deepEqual(order, ['flash', 'anims', 'delay']);
  });

  test('omitted playBattleResultAnims is tolerated', async () => {
    const renderer = _fakeRenderer();
    await playFastCombatDisplay({
      renderer, actorSnap: ACTOR, targetSnap: TARGET,
      result: { hit: true, damage: 1 },
      // no playBattleResultAnims
      speed: 'fast',
      missText: null,
      playbackDelay: () => Promise.resolve(),
    });
    // Reaches the delay without throwing.
    assert.ok(true);
  });
});
