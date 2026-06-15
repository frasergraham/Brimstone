// Tests for the Mission Logic Graph engine + node catalog (src/mission-logic/).
// Covers: graph validation, deterministic exec traversal, the Sim/Show emission
// model, data-pin resolution (incl. live entity wires), flow nodes (Do Once,
// Branch, Sequence, Counter, For Each), and runtime-state serialization.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MissionLogicEngine, makeTestContext, validateGraph, GraphValidationError,
  emptyGraph, NodeKind, getNodeType,
} from '../src/mission-logic/index.js';

// Compact graph builder for tests.
function g(nodes, edges, variables = []) {
  return { version: 1, variables, nodes, edges };
}
const exec = (from, pin, to) => ({ from: { node: from, pin }, to: { node: to, pin: 'in' }, kind: 'exec' });
const data = (from, pin, to, toPin) => ({ from: { node: from, pin }, to: { node: to, pin: toPin }, kind: 'data' });
const emitsOfKind = (ctx, kind) => ctx._emitted.filter((e) => e.kind === kind);

describe('mission-logic / graph validation', () => {
  test('emptyGraph validates', () => {
    assert.doesNotThrow(() => validateGraph(emptyGraph()));
  });

  test('rejects wrong version', () => {
    assert.throws(() => validateGraph({ version: 2, nodes: [], edges: [] }), GraphValidationError);
  });

  test('rejects duplicate node ids', () => {
    const graph = g(
      [{ id: 'a', type: 'onMissionStart' }, { id: 'a', type: 'storyBeat' }], [],
    );
    assert.throws(() => validateGraph(graph), /duplicate node id/);
  });

  test('rejects unknown node type', () => {
    assert.throws(() => validateGraph(g([{ id: 'a', type: 'nope' }], [])), /unknown type/);
  });

  test('rejects exec edge into an event node (no exec-in)', () => {
    const graph = g(
      [{ id: 'a', type: 'storyBeat' }, { id: 'b', type: 'onMissionStart' }],
      [exec('a', 'done', 'b')],
    );
    assert.throws(() => validateGraph(graph), /no exec-in pin/);
  });

  test('rejects exec edge from a non-existent out pin', () => {
    const graph = g(
      [{ id: 'a', type: 'onMissionStart' }, { id: 'b', type: 'storyBeat' }],
      [exec('a', 'bogus', 'b')],
    );
    assert.throws(() => validateGraph(graph), /no exec-out pin/);
  });

  test('rejects two data edges driving one input', () => {
    const graph = g(
      [
        { id: 'e', type: 'onAreaEnter', params: { hexes: [] } },
        { id: 'f', type: 'filterIsFaction', params: { faction: 'hero' } },
      ],
      [data('e', 'unit', 'f', 'entity'), data('e', 'hex', 'f', 'entity')],
    );
    assert.throws(() => validateGraph(graph), /more than one edge/);
  });
});

describe('mission-logic / engine traversal', () => {
  test('onMissionStart fires a story beat (Show emission)', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'beat', type: 'storyBeat', params: { title: 'Hello', text: 'world' } },
      ],
      [exec('start', 'out', 'beat')],
    );
    const ctx = makeTestContext();
    new MissionLogicEngine(graph, ctx).dispatch('missionStart');
    const beats = emitsOfKind(ctx, 'storyBeat');
    assert.equal(beats.length, 1);
    assert.equal(beats[0].title, 'Hello');
  });

  test('onRoundStart matches only its round', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onRoundStart', params: { round: 4 } },
        { id: 'beat', type: 'storyBeat', params: { title: 'R4' } },
      ],
      [exec('ev', 'out', 'beat')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('roundStart', { round: 1, phase: 'dawn' });
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 0);
    eng.dispatch('roundStart', { round: 4, phase: 'day' });
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 1);
  });

  test("onRoundStart round:'any' fires every round", () => {
    const graph = g(
      [
        { id: 'ev', type: 'onRoundStart', params: { round: 'any' } },
        { id: 'beat', type: 'storyBeat', params: {} },
      ],
      [exec('ev', 'out', 'beat')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('roundStart', { round: 1 });
    eng.dispatch('roundStart', { round: 2 });
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 2);
  });
});

describe('mission-logic / area trigger + filter + data wire', () => {
  // The canonical example (docs/09 §5.1), trimmed: hero enters → Is Hero? →
  // Spawn NPC → Start Conversation with the spawned NPC wired in as a role.
  function buildCanonical() {
    return g(
      [
        { id: 'area', type: 'onAreaEnter', params: { hexes: [{ col: 9, row: 6 }] } },
        { id: 'filter', type: 'filterIsFaction', params: { faction: 'hero' } },
        { id: 'seq', type: 'sequence', params: { outputs: 2 } },
        { id: 'spawnNpc', type: 'spawnUnits', params: { units: [{ type: 'dave', faction: 'npc', spawnAt: { col: 7, row: 4 } }] } },
        { id: 'convo', type: 'startConversation', params: { conversationId: 'meet-dave', roleInputs: ['npc'] } },
        { id: 'despawn', type: 'despawnUnit', params: {} },
        { id: 'zombies', type: 'spawnUnits', params: { units: [{ type: 'zombie' }, { type: 'zombie' }, { type: 'zombie' }] } },
      ],
      [
        exec('area', 'onEnter', 'filter'),
        data('area', 'unit', 'filter', 'entity'),
        exec('filter', 'pass', 'seq'),
        exec('seq', 'then0', 'spawnNpc'),
        exec('seq', 'then1', 'convo'),
        data('spawnNpc', 'first', 'convo', 'npc'),
        exec('convo', 'done', 'despawn'),
        data('spawnNpc', 'first', 'despawn', 'target'),
        exec('despawn', 'done', 'zombies'),
      ],
    );
  }

  test('hero entering fires the whole chain; the spawned NPC flows into the conversation', () => {
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(buildCanonical(), ctx);
    eng.dispatch('areaEnter', { unit: { id: 'h', faction: 'hero' }, hex: { col: 9, row: 6 } });

    const convo = emitsOfKind(ctx, 'conversation');
    assert.equal(convo.length, 1);
    // The NPC role is the live entity returned by the Spawn node (data wire).
    assert.equal(convo[0].roles.npc.type, 'dave');
    // Start Conversation is LATENT: its Done branch (despawn + zombies) hasn't
    // fired yet — only the NPC spawn (upstream of the conversation) has.
    assert.equal(emitsOfKind(ctx, 'spawn').filter((s) => s.spec.type === 'zombie').length, 0);
    assert.ok(!ctx._mutations.some((m) => m.op === 'despawn'));

    // Dismiss the conversation → resume the Done branch.
    eng.resumeLatent(convo[0].nodeId);

    // Three zombies spawned after the conversation's Done.
    const spawns = emitsOfKind(ctx, 'spawn');
    assert.equal(spawns.filter((s) => s.spec.type === 'zombie').length, 3);
    // The NPC was despawned (by the live wire, not a hard-coded id).
    assert.ok(ctx._mutations.some((m) => m.op === 'despawn'));
  });

  test('a non-hero entering the area fires nothing (filter blocks)', () => {
    const ctx = makeTestContext();
    new MissionLogicEngine(buildCanonical(), ctx)
      .dispatch('areaEnter', { unit: { id: 'z', faction: 'witch' }, hex: { col: 9, row: 6 } });
    assert.equal(ctx._emitted.length, 0);
  });

  test('entering a different hex does not match the area', () => {
    const ctx = makeTestContext();
    new MissionLogicEngine(buildCanonical(), ctx)
      .dispatch('areaEnter', { unit: { id: 'h', faction: 'hero' }, hex: { col: 0, row: 0 } });
    assert.equal(ctx._emitted.length, 0);
  });
});

describe('mission-logic / location node (region as data)', () => {
  test('a multi-hex Location: `hex` is the first cell, `hexes` is the whole list', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart', params: {} },
        { id: 'loc', type: 'location', params: { label: 'Gate', hexes: [{ col: 3, row: 4 }, { col: 3, row: 5 }] } },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'zombie' }] } },
      ],
      [exec('start', 'out', 'spawn'), data('loc', 'hex', 'spawn', 'at')],
    );
    const ctx = makeTestContext();
    new MissionLogicEngine(graph, ctx).dispatch('missionStart', {});
    const spawns = emitsOfKind(ctx, 'spawn');
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].spec.spawnAt, { col: 3, row: 4 }, 'Spawn `at` reads the Location’s first hex');
  });

  test('a legacy single-hex Location ({col,row}) still resolves its `hex`', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart', params: {} },
        { id: 'loc', type: 'location', params: { col: 5, row: 6 } },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'zombie' }] } },
      ],
      [exec('start', 'out', 'spawn'), data('loc', 'hex', 'spawn', 'at')],
    );
    const ctx = makeTestContext();
    new MissionLogicEngine(graph, ctx).dispatch('missionStart', {});
    assert.deepEqual(emitsOfKind(ctx, 'spawn')[0].spec.spawnAt, { col: 5, row: 6 });
  });

  test('a Location wired into an Area node defines its trigger region (item 2)', () => {
    const graph = g(
      [
        { id: 'loc', type: 'location', params: { hexes: [{ col: 9, row: 6 }, { col: 10, row: 6 }] } },
        { id: 'area', type: 'onAreaEnter', params: { hexes: [] } }, // authored hexes empty → wire wins
        { id: 'beat', type: 'storyBeat', params: { title: 'Crossed', text: 'the line' } },
      ],
      [data('loc', 'hexes', 'area', 'area'), exec('area', 'onEnter', 'beat')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    // The watched-hex set is taken from the wired Location.
    assert.ok(eng.areaHexKeys().has('9,6') && eng.areaHexKeys().has('10,6'));
    // Entering a hex that exists ONLY in the Location (not params.hexes) fires.
    eng.dispatch('areaEnter', { unit: { faction: 'hero' }, hex: { col: 10, row: 6 } });
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 1);
  });

  test('without a wire, an Area node uses its own authored hexes', () => {
    const graph = g(
      [
        { id: 'area', type: 'onAreaEnter', params: { hexes: [{ col: 2, row: 2 }] } },
        { id: 'beat', type: 'storyBeat', params: { title: 'x', text: 'y' } },
      ],
      [exec('area', 'onEnter', 'beat')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    assert.deepEqual([...eng.areaHexKeys()], ['2,2']);
    eng.dispatch('areaEnter', { unit: { faction: 'hero' }, hex: { col: 2, row: 2 } });
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 1);
  });

  test('a Survivor source wired into an Actor node binds it by id', () => {
    const graph = g(
      [
        { id: 'surv', type: 'survivor', params: { ref: 'Samuel', label: 'Samuel', col: 3, row: 4 } },
        { id: 'act', type: 'onActor', params: { ref: '' } }, // ref comes from the wire
        { id: 'beat', type: 'storyBeat', params: { title: 'Found', text: 'Samuel is safe.' } },
      ],
      [data('surv', 'id', 'act', 'ref'), exec('act', 'onSpawn', 'beat')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    // The watched ref is taken from the wired Survivor node, not the (empty) param.
    assert.ok(eng.actorRefs().has('Samuel'));
    eng.dispatch('actorSpawn', { ref: 'Samuel', entity: { id: 'e1' } });
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 1);
    // A different unit appearing doesn't fire it.
    eng.dispatch('actorSpawn', { ref: 'Someone Else', entity: { id: 'e2' } });
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 1);
  });
});

describe('mission-logic / flow nodes', () => {
  test('Do Once fires only the first time', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onRoundStart', params: { round: 'any' } },
        { id: 'once', type: 'doOnce', params: {} },
        { id: 'beat', type: 'storyBeat', params: {} },
      ],
      [exec('ev', 'out', 'once'), exec('once', 'out', 'beat')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('roundStart', { round: 1 });
    eng.dispatch('roundStart', { round: 2 });
    eng.dispatch('roundStart', { round: 3 });
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 1);
  });

  test('Branch routes on a wired bool (Get Game State + Compare)', () => {
    // round >= 3 ? win : (nothing)
    const graph = g(
      [
        { id: 'ev', type: 'onPhase', params: { phase: 'dawn' } },
        { id: 'getRound', type: 'getGameState', params: { field: 'round' } },
        { id: 'cmp', type: 'compare', params: { op: '>=' } },
        { id: 'three', type: 'getGameState', params: { field: 'three' } },
        { id: 'br', type: 'branch', params: {} },
        { id: 'win', type: 'winMission', params: { reason: 'held to dawn' } },
      ],
      [
        exec('ev', 'out', 'br'),
        data('getRound', 'value', 'cmp', 'a'),
        data('three', 'value', 'cmp', 'b'),
        data('cmp', 'result', 'br', 'cond'),
        exec('br', 'true', 'win'),
      ],
    );
    // state.three carries the literal threshold (3) so Compare has both operands.
    const ctxLose = makeTestContext({ state: { round: 1, three: 3 } });
    new MissionLogicEngine(graph, ctxLose).dispatch('phase', { phase: 'dawn' });
    assert.equal(emitsOfKind(ctxLose, 'win').length, 0);

    const ctxWin = makeTestContext({ state: { round: 5, three: 3 } });
    new MissionLogicEngine(graph, ctxWin).dispatch('phase', { phase: 'dawn' });
    assert.equal(emitsOfKind(ctxWin, 'win').length, 1);
    assert.equal(ctxWin.getState().winner, 'hero');
  });

  test('Counter fires "reached" only at its threshold', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onRoundStart', params: { round: 'any' } },
        { id: 'cnt', type: 'counter', params: { threshold: 3 } },
        { id: 'beat', type: 'storyBeat', params: {} },
      ],
      [exec('ev', 'out', 'cnt'), exec('cnt', 'reached', 'beat')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    for (let r = 1; r <= 5; r++) eng.dispatch('roundStart', { round: r });
    // Fires at pulses 3, 4, 5 → three times.
    assert.equal(emitsOfKind(ctx, 'storyBeat').length, 3);
  });

  test('For Each spawns one wave per item in a wired list', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onMissionStart' },
        { id: 'getList', type: 'getGameState', params: { field: 'spawnSpots' } },
        { id: 'loop', type: 'forEach', params: {} },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'zombie' }] } },
      ],
      [
        exec('ev', 'out', 'loop'),
        data('getList', 'value', 'loop', 'items'),
        exec('loop', 'body', 'spawn'),
      ],
    );
    const ctx = makeTestContext({ state: { spawnSpots: [1, 2, 3, 4] } });
    new MissionLogicEngine(graph, ctx).dispatch('missionStart');
    assert.equal(emitsOfKind(ctx, 'spawn').length, 4);
  });
});

describe('mission-logic / faction win-lose', () => {
  test('Witch faction all-dead → hero wins; hero leader-dead → lose', () => {
    const graph = g(
      [
        { id: 'witch', type: 'factionEvent', params: { faction: 'witch' } },
        { id: 'win', type: 'winMission', params: { winner: 'hero', reason: 'cleared' } },
        { id: 'hero', type: 'factionEvent', params: { faction: 'hero' } },
        { id: 'lose', type: 'loseMission', params: { winner: 'witch', reason: 'fell' } },
      ],
      [exec('witch', 'onAllUnitsDead', 'win'), exec('hero', 'onLeaderDead', 'lose')],
    );
    const ctxW = makeTestContext();
    new MissionLogicEngine(graph, ctxW).dispatch('factionAllDead', { faction: 'witch' });
    assert.equal(ctxW.getState().winner, 'hero');

    const ctxL = makeTestContext();
    new MissionLogicEngine(graph, ctxL).dispatch('factionLeaderDead', { faction: 'hero' });
    assert.equal(ctxL.getState().winner, 'witch');
  });
});

describe('mission-logic / determinism + serialization', () => {
  test('identical dispatch sequence → identical emitted stream', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onKillCount', params: { faction: 'hero', count: 3 } },
        { id: 'once', type: 'doOnce', params: {} },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'wood_golem', spawnAt: 'near_hero' }] } },
      ],
      [exec('ev', 'out', 'once'), exec('once', 'out', 'spawn')],
    );
    const run = () => {
      const ctx = makeTestContext();
      const eng = new MissionLogicEngine(graph, ctx);
      eng.dispatch('killCount', { faction: 'hero', count: 3 });
      eng.dispatch('killCount', { faction: 'hero', count: 4 });
      return ctx._emitted;
    };
    assert.deepEqual(run(), run());
    // Do Once held the second pulse → exactly one spawn.
    assert.equal(run().filter((e) => e.kind === 'spawn').length, 1);
  });

  test('serialize/load preserves Do Once + counter state across engine instances', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onRoundStart', params: { round: 'any' } },
        { id: 'once', type: 'doOnce', params: {} },
        { id: 'beat', type: 'storyBeat', params: {} },
      ],
      [exec('ev', 'out', 'once'), exec('once', 'out', 'beat')],
    );
    const ctx1 = makeTestContext();
    const eng1 = new MissionLogicEngine(graph, ctx1);
    eng1.dispatch('roundStart', { round: 1 });
    assert.equal(emitsOfKind(ctx1, 'storyBeat').length, 1);
    const snap = eng1.serialize();

    // A fresh engine (e.g. after online resync) that loads the snapshot must NOT
    // re-fire the one-shot.
    const ctx2 = makeTestContext();
    const eng2 = new MissionLogicEngine(graph, ctx2);
    eng2.load(snap);
    eng2.dispatch('roundStart', { round: 2 });
    assert.equal(emitsOfKind(ctx2, 'storyBeat').length, 0);
  });
});

describe('mission-logic / node registry sanity', () => {
  test('every registered node declares a known kind', () => {
    const kinds = new Set(Object.values(NodeKind));
    for (const type of ['onMissionStart', 'spawnUnits', 'branch', 'compare', 'winMission']) {
      assert.ok(kinds.has(getNodeType(type).kind), `${type} has a valid kind`);
    }
  });
});
