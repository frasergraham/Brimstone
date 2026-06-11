// compileTurnBattlePairs — kill attribution. A unit that died this round must
// show its skull EXACTLY ONCE in the wrap-up, even if it fought several
// opponents (regression: the round-summary card double-reported one death when
// the victim was attacked by two units). The skull is credited to the battle
// whose result actually killed it, with a first-pair fallback for deaths no
// single result owns (counter-kills, splash).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { compileTurnBattlePairs } from '../src/battle-utils.js';

const RES = { ACTION_OK: 'ACTION_OK', GUARD_STRIKE: 'GUARD_STRIKE' };
const PLAN = { BATTLE_UNIT: 'BATTLE_UNIT', BATTLE_HEX: 'BATTLE_HEX' };

const typeFor = (id) => (id.startsWith('m') ? 'minion' : 'survivor');
function battle(actorId, targetId, result) {
  return {
    type: RES.ACTION_OK,
    action: { type: PLAN.BATTLE_UNIT },
    battleSnaps: {
      actorSnap:  { id: actorId,  type: typeFor(actorId),  title: actorId },
      targetSnap: { id: targetId, type: typeFor(targetId), title: targetId },
    },
    result,
  };
}
// A unit is "dead" at round end if absent from finalEntities (or present & !alive).
const survivors = (...ids) => ids.map(id => ({ id, alive: true }));
const allCells = (pairs) => pairs.flatMap(p => [p.a, p.b]);

describe('compileTurnBattlePairs — kill attribution', () => {
  test('victim killed by the SECOND of two attackers shows one skull, on that fight', () => {
    const steps = [{
      witchEvents: [
        battle('m1', 's', { damage: 1, counterDmg: 0, killed: false }), // survived
        battle('m2', 's', { damage: 1, counterDmg: 0, killed: true }),  // the kill
      ],
      heroEvents: [],
    }];
    const pairs = compileTurnBattlePairs(steps, survivors('m1', 'm2'), RES, PLAN);

    assert.equal(pairs.length, 2, 'two distinct opponents → two pairs');
    // 's' sorts after 'm…', so it's always the `b` cell.
    const byOpp = Object.fromEntries(pairs.map(p => [p.a.id, p]));
    assert.equal(byOpp.m2.b.killed, true,  'kill credited to the m2 fight');
    assert.equal(byOpp.m1.b.killed, false, 'not shown dead in the m1 fight');

    const skulls = allCells(pairs).filter(u => u.id === 's' && u.killed);
    assert.equal(skulls.length, 1, 'exactly one skull for the one death');
  });

  test('single-fight kill still shows its skull (no regression)', () => {
    const steps = [{ witchEvents: [battle('m1', 's', { damage: 2, counterDmg: 0, killed: true })], heroEvents: [] }];
    const pairs = compileTurnBattlePairs(steps, survivors('m1'), RES, PLAN);
    const skulls = allCells(pairs).filter(u => u.id === 's' && u.killed);
    assert.equal(skulls.length, 1);
  });

  test('counter-kill (no result owns the death) still shows one skull via fallback', () => {
    // m1 attacks s; s counters and kills m1. result.killed flags the TARGET (s),
    // who lived — so no result.killed names m1. m1 is dead at round end.
    const steps = [{ witchEvents: [battle('m1', 's', { damage: 0, counterDmg: 2, killed: false })], heroEvents: [] }];
    const pairs = compileTurnBattlePairs(steps, survivors('s'), RES, PLAN); // m1 absent → dead
    const skulls = allCells(pairs).filter(u => u.id === 'm1' && u.killed);
    assert.equal(skulls.length, 1, 'attacker counter-death credited to its (only) pair');
  });
});

describe('compileTurnBattlePairs — splash victims', () => {
  test('splash victims ride on the pair that blasted them, damage aggregated', () => {
    const steps = [{
      witchEvents: [],
      heroEvents: [
        battle('h', 'm1', {
          damage: 4, counterDmg: 0, killed: false,
          splashHits: [
            { id: 'm2', name: 'm2', type: 'minion', owner: 'witch', damage: 1, killed: false },
            { id: 'm3', name: 'm3', type: 'minion', owner: 'witch', damage: 1, killed: true },
          ],
        }),
      ],
    }];
    const pairs = compileTurnBattlePairs(steps, survivors('h', 'm1', 'm2'), RES, PLAN);
    assert.equal(pairs.length, 1);
    const splash = pairs[0].splash;
    assert.equal(splash.length, 2);
    const byId = Object.fromEntries(splash.map(u => [u.id, u]));
    assert.equal(byId.m2.hpLost, 1);
    assert.equal(byId.m2.killed, false);
    assert.equal(byId.m3.killed, true, 'splash kill shows its skull');
  });

  test('splash victim that died in its OWN fight is not double-skulled in the splash list', () => {
    const steps = [{
      witchEvents: [],
      heroEvents: [
        battle('h', 'm1', { damage: 3, counterDmg: 0, killed: true }),   // m1 dies in its fight
        battle('h2', 'm4', {
          damage: 1, counterDmg: 0, killed: false,
          splashHits: [{ id: 'm1', name: 'm1', type: 'minion', owner: 'witch', damage: 1, killed: false }],
        }),
      ],
    }];
    const pairs = compileTurnBattlePairs(steps, survivors('h', 'h2', 'm4'), RES, PLAN);
    const skulls = [];
    for (const p of pairs) {
      for (const u of [p.a, p.b, ...(p.splash ?? [])]) if (u.id === 'm1' && u.killed) skulls.push(u);
    }
    assert.equal(skulls.length, 1, 'exactly one skull for m1 across cells + splash');
  });

  test('pairs without splash expose an empty array', () => {
    const steps = [{ witchEvents: [battle('m1', 's', { damage: 1, killed: false })], heroEvents: [] }];
    const pairs = compileTurnBattlePairs(steps, survivors('m1', 's'), RES, PLAN);
    assert.deepEqual(pairs[0].splash, []);
  });
});
