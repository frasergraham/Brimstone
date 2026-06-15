// Tests for rich campaign unlock criteria (src/campaign/unlock.js) and their
// integration into Campaign.getNextMission / isMissionUnlocked (docs/09 §5.5).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateUnlock, unlockMissionRefs, validateUnlock } from '../src/campaign/unlock.js';
import { Campaign } from '../src/campaign/campaign.js';

const ctx = {
  isCompleted: (id) => new Set(['m1', 'm2']).has(id),
  hasItem: (id) => id === 'silver_dagger',
  level: 3,
  getFlag: (k) => ({ saw_witch: true, ending: 'dark' }[k]),
  getResource: (k) => ({ silver: 5 }[k] ?? 0),
};

describe('unlock / leaf criteria', () => {
  test('missionDone', () => {
    assert.equal(evaluateUnlock({ missionDone: 'm1' }, ctx), true);
    assert.equal(evaluateUnlock({ missionDone: 'm9' }, ctx), false);
  });
  test('hasItem', () => {
    assert.equal(evaluateUnlock({ hasItem: 'silver_dagger' }, ctx), true);
    assert.equal(evaluateUnlock({ hasItem: 'torch' }, ctx), false);
  });
  test('level ≥ N', () => {
    assert.equal(evaluateUnlock({ level: 3 }, ctx), true);
    assert.equal(evaluateUnlock({ level: 4 }, ctx), false);
  });
  test('flag truthy + equals', () => {
    assert.equal(evaluateUnlock({ flag: 'saw_witch' }, ctx), true);
    assert.equal(evaluateUnlock({ flag: 'missing' }, ctx), false);
    assert.equal(evaluateUnlock({ flag: 'ending', equals: 'dark' }, ctx), true);
    assert.equal(evaluateUnlock({ flag: 'ending', equals: 'light' }, ctx), false);
  });
  test('resource atLeast', () => {
    assert.equal(evaluateUnlock({ resource: 'silver', atLeast: 5 }, ctx), true);
    assert.equal(evaluateUnlock({ resource: 'silver', atLeast: 6 }, ctx), false);
    assert.equal(evaluateUnlock({ resource: 'silver' }, ctx), true); // default atLeast 1
  });
  test('null criterion is an open gate', () => {
    assert.equal(evaluateUnlock(null, ctx), true);
  });
  test('unknown criterion fails closed', () => {
    assert.equal(evaluateUnlock({ bogus: 1 }, ctx), false);
  });
});

describe('unlock / combinators', () => {
  test('all (AND)', () => {
    assert.equal(evaluateUnlock({ all: [{ missionDone: 'm1' }, { level: 3 }] }, ctx), true);
    assert.equal(evaluateUnlock({ all: [{ missionDone: 'm1' }, { level: 9 }] }, ctx), false);
  });
  test('any (OR)', () => {
    assert.equal(evaluateUnlock({ any: [{ missionDone: 'm9' }, { hasItem: 'silver_dagger' }] }, ctx), true);
    assert.equal(evaluateUnlock({ any: [{ missionDone: 'm9' }, { hasItem: 'torch' }] }, ctx), false);
  });
  test('not', () => {
    assert.equal(evaluateUnlock({ not: { missionDone: 'm9' } }, ctx), true);
    assert.equal(evaluateUnlock({ not: { missionDone: 'm1' } }, ctx), false);
  });
  test('array is AND sugar', () => {
    assert.equal(evaluateUnlock([{ missionDone: 'm1' }, { missionDone: 'm2' }], ctx), true);
    assert.equal(evaluateUnlock([{ missionDone: 'm1' }, { missionDone: 'm9' }], ctx), false);
  });
  test('nested', () => {
    const c = { all: [{ missionDone: 'm1' }, { any: [{ hasItem: 'torch' }, { level: 3 }] }] };
    assert.equal(evaluateUnlock(c, ctx), true);
  });
});

describe('unlock / refs + validation', () => {
  test('unlockMissionRefs collects every missionDone id', () => {
    const c = { all: [{ missionDone: 'a' }, { any: [{ missionDone: 'b' }, { not: { missionDone: 'c' } }] }] };
    assert.deepEqual([...unlockMissionRefs(c)].sort(), ['a', 'b', 'c']);
  });
  test('validateUnlock accepts well-formed criteria', () => {
    assert.doesNotThrow(() => validateUnlock({ any: [{ missionDone: 'x' }, { level: 2 }] }));
  });
  test('validateUnlock rejects an empty/unknown criterion', () => {
    assert.throws(() => validateUnlock({}), /no known key/);
    assert.throws(() => validateUnlock({ level: 'high' }), /level must be a number/);
  });
});

describe('unlock / Campaign integration', () => {
  // Build a Campaign without loading a save, set progress fields directly.
  function makeCampaign(missions, { completed = [], flags = {}, items = {}, resources = {} } = {}) {
    const c = new Campaign({ id: 'test', missions, mapBuilders: {} });
    c.completedMissions = new Set(completed);
    c.storyFlags = flags;
    c.heroStats = { hp: 1, maxHp: 1, attack: 1, defense: 1, weapon: 'sword', items };
    c.resources = { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0, ...resources };
    return c;
  }

  test('legacy requires still gates (backward compatible)', () => {
    const missions = [
      { id: 'a' },
      { id: 'b', requires: ['a'] },
    ];
    const c = makeCampaign(missions);
    assert.equal(c.isMissionUnlocked(missions[1]), false, 'b locked until a is done');
    c.completedMissions = new Set(['a']);
    assert.equal(c.isMissionUnlocked(missions[1]), true);
  });

  test('rich unlock gate is honored and AND-ed with requires', () => {
    const missions = [
      { id: 'a' },
      { id: 'secret', requires: ['a'], unlock: { any: [{ hasItem: 'key' }, { flag: 'found_path' }] } },
    ];
    const c = makeCampaign(missions, { completed: ['a'] });
    assert.equal(c.isMissionUnlocked(missions[1]), false, 'requires met but unlock not satisfied');

    const c2 = makeCampaign(missions, { completed: ['a'], items: { key: 1 } });
    assert.equal(c2.isMissionUnlocked(missions[1]), true, 'hasItem satisfies the OR');

    const c3 = makeCampaign(missions, { completed: ['a'], flags: { found_path: true } });
    assert.equal(c3.isMissionUnlocked(missions[1]), true, 'flag satisfies the OR');
  });

  test('getNextMission returns the first unlocked mission under rich criteria', () => {
    const missions = [
      { id: 'a' },
      { id: 'b', unlock: { missionDone: 'a' } },
      { id: 'c', unlock: { level: 2 } }, // level == completed count
    ];
    const c = makeCampaign(missions, { completed: ['a'] });
    // a done; b unlocked (a done); next is b.
    assert.equal(c.getNextMission(), 'b');
  });

  test('level criterion maps to missions-cleared when no hero level exists', () => {
    const missions = [{ id: 'a' }, { id: 'b' }, { id: 'gate', unlock: { level: 2 } }];
    const c = makeCampaign(missions, { completed: ['a', 'b'] });
    assert.equal(c.buildUnlockContext().level, 2);
    assert.equal(c.isMissionUnlocked(missions[2]), true);
  });
});
