// Tests for the Campaign Progression editor model (src/tools/campaign-progression.js):
// DAG construction from requires + unlock refs, layered layout, summaries, edits.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProgressionModel, gateSummary, rewardSummary, addPrereq, removePrereq, nodeToMissionPatch,
} from '../src/tools/campaign-progression.js';
import { stubMission } from '../src/tools/campaign-progression-ui.js';
import { loadMissionJSON } from '../src/campaign/json-mission.js';

const MISSIONS = [
  { id: 'tutorial', title: 'Tutorial', chapter: 0 },
  { id: 'prologue', title: 'The Awakening', chapter: 1, requires: ['tutorial'] },
  { id: 'gather', title: 'Gathering', chapter: 1, requires: ['prologue'], rewards: { food: 2 } },
  { id: 'secret', title: 'Secret', chapter: 1, unlock: { any: [{ missionDone: 'gather' }, { hasItem: 'key' }] } },
];

describe('campaign-progression / model', () => {
  test('edges come from requires AND unlock missionDone refs', () => {
    const { edges } = buildProgressionModel(MISSIONS);
    const has = (from, to) => edges.some((e) => e.from === from && e.to === to);
    assert.ok(has('tutorial', 'prologue'));
    assert.ok(has('prologue', 'gather'));
    assert.ok(has('gather', 'secret'), 'unlock.any.missionDone draws an edge');
  });

  test('edges to unknown missions are dropped', () => {
    const { edges } = buildProgressionModel([{ id: 'a', requires: ['ghost'] }]);
    assert.equal(edges.length, 0);
  });

  test('layout puts roots in column 0 and pushes dependents right', () => {
    const { nodes } = buildProgressionModel(MISSIONS);
    const col = (id) => nodes.find((n) => n.id === id).col;
    assert.equal(col('tutorial'), 0);
    assert.equal(col('prologue'), 1);
    assert.equal(col('gather'), 2);
    assert.ok(col('secret') > col('gather'));
  });

  test('no duplicate edges when requires + unlock reference the same prereq', () => {
    const { edges } = buildProgressionModel([
      { id: 'a' },
      { id: 'b', requires: ['a'], unlock: { missionDone: 'a' } },
    ]);
    assert.equal(edges.filter((e) => e.from === 'a' && e.to === 'b').length, 1);
  });
});

describe('campaign-progression / summaries', () => {
  test('gateSummary describes requires + unlock', () => {
    const { nodes } = buildProgressionModel(MISSIONS);
    assert.match(gateSummary(nodes.find((n) => n.id === 'secret')), /done:gather|item:key/);
    assert.equal(gateSummary(nodes.find((n) => n.id === 'tutorial')), 'available from start');
  });

  test('rewardSummary lists non-empty rewards', () => {
    assert.equal(rewardSummary({ food: 2, silver: 0 }), 'food:2');
    assert.equal(rewardSummary({}), 'none');
  });
});

describe('campaign-progression / new mission stub', () => {
  test('stubMission is a valid, logic-graph-driven mission that builds a map', () => {
    const m = stubMission('the_crossroads', 'The Crossroads', 2);
    assert.equal(m.id, 'the_crossroads');
    assert.equal(m.objectives, undefined, 'logic-driven — no legacy objectives');
    assert.ok(m.logic.nodes.some((n) => n.type === 'comment'), 'starts with a guidance comment');
    const def = loadMissionJSON(m); // throws if invalid
    const map = def.mapBuilderFn();
    assert.equal(map.tiles.size, 100, '10×10 grass grid');
    assert.deepEqual(map.heroStart, { col: 2, row: 7 });
  });
});

describe('campaign-progression / edits', () => {
  test('addPrereq / removePrereq mutate requires idempotently', () => {
    const node = { id: 'x', requires: [] };
    addPrereq(node, 'a'); addPrereq(node, 'a');
    assert.deepEqual(node.requires, ['a']);
    removePrereq(node, 'a');
    assert.deepEqual(node.requires, []);
  });

  test('nodeToMissionPatch emits requires/unlock only when present', () => {
    const bare = nodeToMissionPatch({ requires: [], unlock: null, rewards: { food: 1 } });
    assert.equal(bare.requires, undefined);
    assert.equal(bare.unlock, undefined);
    assert.deepEqual(bare.rewards, { food: 1 });

    const full = nodeToMissionPatch({ requires: ['a'], unlock: { level: 2 }, rewards: {} });
    assert.deepEqual(full.requires, ['a']);
    assert.deepEqual(full.unlock, { level: 2 });
  });
});
