// Task 5: the five Chapter-1 "battle for the nodes" villages gate The Long
// Watch (M6) via anyOf-3, and M6's witch budget scales down as more villages
// are won (5 − wins). Runs against the REGISTERED mission defs so JSON drift is
// caught, not a hand-built fixture.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Campaign, effectiveAiBudgetBonus } from '../src/campaign/campaign.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';
import { buildMissionMap } from '../src/campaign/mission-map.js';

const VILLAGES = [
  'village_marsh_end', 'village_thornwick', 'village_gallows_ferry',
  'village_ashford_mill', 'village_blackfen',
];

const camp = getCampaignById('calebs_hollow_prologue');
const missions = camp.missions;
const byId = Object.fromEntries(missions.map(m => [m.id, m]));

function withCompleted(completed) {
  const c = new Campaign({ id: 'calebs_hollow_prologue', missions, mapBuilders: {} });
  c.completedMissions = new Set(completed);
  c.heroStats = { items: {} };
  c.resources = {};
  c.storyFlags = {};
  return c;
}

describe('Chapter 1 villages — registration + gating', () => {
  test('all five villages are registered between dark_ritual and long_watch', () => {
    const order = missions.map(m => m.id);
    const di = order.indexOf('dark_ritual');
    const li = order.indexOf('long_watch');
    for (const v of VILLAGES) {
      const vi = order.indexOf(v);
      assert.ok(vi > di && vi < li, `${v} sits between dark_ritual and long_watch`);
    }
  });

  test('each village requires dark_ritual (locked before, available after)', () => {
    const before = withCompleted([]);
    const after  = withCompleted(['dark_ritual']);
    for (const v of VILLAGES) {
      assert.equal(before.isMissionUnlocked(byId[v]), false, `${v} locked before dark_ritual`);
      assert.equal(after.isMissionUnlocked(byId[v]), true, `${v} available after dark_ritual`);
    }
  });

  test('villages are procedural vs-AI missions with scoring + a witch', () => {
    for (const v of VILLAGES) {
      const m = byId[v];
      assert.equal(m.map.mode, 'procedural');
      assert.equal(m.hasWitch, true);
      assert.notEqual(m.disableScoring, true, 'scoring stays on — it is how you win');
      assert.ok(m.nodeScoreThreshold >= 3, 'has a points goal');
      // Deterministic, in-bounds procedural map.
      const map = buildMissionMap(m.map);
      assert.ok(map.tiles.size > 0 && map.heroStart && map.witchStart);
      assert.equal(map.witchObjectives.length, m.map.nodeCount, 'node count honoured');
    }
  });
});

describe('long_watch (M6) unlock + dynamic difficulty', () => {
  const lw = byId['long_watch'];

  test('locked at 0–2 village wins, unlocked at 3+', () => {
    assert.equal(withCompleted(['dark_ritual']).isMissionUnlocked(lw), false);
    assert.equal(withCompleted(['dark_ritual', ...VILLAGES.slice(0, 2)]).isMissionUnlocked(lw), false);
    assert.equal(withCompleted(['dark_ritual', ...VILLAGES.slice(0, 3)]).isMissionUnlocked(lw), true);
    assert.equal(withCompleted(['dark_ritual', ...VILLAGES]).isMissionUnlocked(lw), true);
  });

  test('witch budget bonus = 5 − villages won (3→+2, 4→+1, 5→+0)', () => {
    assert.equal(effectiveAiBudgetBonus(lw, withCompleted(VILLAGES.slice(0, 3))), 2);
    assert.equal(effectiveAiBudgetBonus(lw, withCompleted(VILLAGES.slice(0, 4))), 1);
    assert.equal(effectiveAiBudgetBonus(lw, withCompleted(VILLAGES)), 0);
  });

  test('budget bonus clamps at 0 and never goes negative', () => {
    // (Unreachable in play — M6 is gated at 3 wins — but the resolver must clamp.)
    const sixth = [...VILLAGES, 'dark_ritual'];
    assert.equal(effectiveAiBudgetBonus(lw, withCompleted(sixth)), 0);
  });
});

describe('effectiveAiBudgetBonus — static + edge forms', () => {
  test('static integer passes through; null/absent → 0', () => {
    assert.equal(effectiveAiBudgetBonus({ aiBudgetBonus: 2 }, null), 2);
    assert.equal(effectiveAiBudgetBonus({ aiBudgetBonus: 0 }, null), 0);
    assert.equal(effectiveAiBudgetBonus({}, null), 0);
    assert.equal(effectiveAiBudgetBonus({ aiBudgetBonus: null }, null), 0);
  });
  test('missing_wins with a null campaign counts zero wins → full target', () => {
    assert.equal(
      effectiveAiBudgetBonus({ aiBudgetBonus: { type: 'missing_wins', of: ['a', 'b'], target: 2 } }, null),
      2,
    );
  });
});
