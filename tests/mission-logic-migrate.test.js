// Tests for legacy → logic-graph migration (src/mission-logic/migrate.js).
// Verifies a hand-built mission's scripted fields convert to the expected node
// clusters, and that EVERY shipped mission JSON converts to a validate-clean graph.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { missionToGraph, validateGraph, MissionLogicEngine, makeTestContext }
  from '../src/mission-logic/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const missionsDir = join(here, '..', 'src', 'campaign', 'missions');

const nodeTypes = (graph) => graph.nodes.map((n) => n.type);
const countType = (graph, type) => graph.nodes.filter((n) => n.type === type).length;

describe('mission-logic / migration shapes', () => {
  test('a round story trigger → onRoundStart → storyBeat', () => {
    const graph = missionToGraph({
      storyTriggers: [{ type: 'round', round: 4, title: 'The Witching Hour', text: '…' }],
    });
    assert.ok(nodeTypes(graph).includes('onRoundStart'));
    assert.ok(nodeTypes(graph).includes('storyBeat'));
    assert.equal(countType(graph, 'doOnce'), 0, 'no flag → no Do Once');
  });

  test('a flag-gated trigger inserts a Do Once', () => {
    const graph = missionToGraph({
      storyTriggers: [{ type: 'round', round: 4, title: 'x', flag: 'witching_hour' }],
    });
    assert.equal(countType(graph, 'doOnce'), 1);
  });

  test('an area trigger inserts a hero filter + carries the entered unit as data', () => {
    const graph = missionToGraph({
      storyTriggers: [{ type: 'area', hexes: [{ col: 9, row: 6 }], conversation: 'witch_flees' }],
    });
    assert.ok(nodeTypes(graph).includes('onAreaEnter'));
    assert.ok(nodeTypes(graph).includes('filterIsFaction'));
    assert.ok(nodeTypes(graph).includes('startConversation'));
    // The area's `unit` output must feed the filter's `entity` input.
    const area = graph.nodes.find((n) => n.type === 'onAreaEnter');
    const filter = graph.nodes.find((n) => n.type === 'filterIsFaction');
    assert.ok(graph.edges.some((e) =>
      e.kind === 'data' && e.from.node === area.id && e.from.pin === 'unit'
      && e.to.node === filter.id && e.to.pin === 'entity'));
  });

  test('a hero_kills wave → onKillCount → doOnce → spawnUnits', () => {
    const graph = missionToGraph({
      waves: [{ trigger: 'hero_kills', count: 3, units: [{ type: 'wood_golem', spawnAt: 'near_hero' }] }],
    });
    assert.deepEqual(
      nodeTypes(graph).sort(),
      ['doOnce', 'onKillCount', 'spawnUnits'].sort(),
    );
    const kc = graph.nodes.find((n) => n.type === 'onKillCount');
    assert.equal(kc.params.count, 3);
    assert.equal(kc.params.faction, 'hero');
  });

  test('a round wave → onRoundStart → spawnUnits (no Do Once)', () => {
    const graph = missionToGraph({
      waves: [{ round: 1, units: [{ type: 'zombie', spawnAt: { col: 1, row: 4 } }] }],
    });
    assert.ok(nodeTypes(graph).includes('onRoundStart'));
    assert.ok(nodeTypes(graph).includes('spawnUnits'));
    assert.equal(countType(graph, 'doOnce'), 0);
  });

  test('objectives migrate: eliminate_all → faction-event win; hero_killed dropped; others polled', () => {
    const graph = missionToGraph({
      objectives: {
        win: { type: 'eliminate_all', reason: 'cleared' },
        lose: [{ type: 'hero_killed' }, { type: 'rounds_exceeded', rounds: 10 }],
      },
    });
    // eliminate_all → Faction Event (witch).onAllUnitsDead → Win Mission.
    assert.equal(countType(graph, 'winMission'), 1);
    const fe = graph.nodes.find((n) => n.type === 'factionEvent' && n.params.faction === 'witch');
    assert.ok(graph.edges.some((e) => e.from.node === fe.id && e.from.pin === 'onAllUnitsDead'));
    // hero_killed is inherent → NOT migrated; rounds_exceeded → one polled objectiveOutcome.
    assert.equal(countType(graph, 'objectiveOutcome'), 1);
    assert.equal(graph.nodes.find((n) => n.type === 'objectiveOutcome').params.spec.type, 'rounds_exceeded');
  });

  test('a polled objective delegates to ctx.evaluateObjective and declares the outcome', () => {
    const graph = missionToGraph({ objectives: { win: { type: 'survive_rounds', rounds: 5, reason: 'held' } } });
    const ctx = makeTestContext({ objectives: (spec) => spec.type === 'survive_rounds' });
    new MissionLogicEngine(graph, ctx).dispatch('roundStart', { round: 6 });
    assert.equal(ctx.getState().winner, 'hero');
    assert.equal(ctx.getState().winReason, 'held');
  });
});

describe('mission-logic / every shipped mission migrates to a clean graph', () => {
  const files = readdirSync(missionsDir).filter((f) => f.endsWith('.json'));

  test('there are mission JSON files to check', () => {
    assert.ok(files.length > 0, `expected mission JSON in ${missionsDir}`);
  });

  for (const file of files) {
    test(`${file} → validate-clean graph`, () => {
      const mission = JSON.parse(readFileSync(join(missionsDir, file), 'utf8'));
      const graph = missionToGraph(mission); // throws if it produces an invalid graph
      assert.doesNotThrow(() => validateGraph(graph));
    });
  }
});
