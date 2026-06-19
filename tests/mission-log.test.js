// Tests for the Mission Log — the live, logic-graph-driven objective checklist
// (src/mission-logic/ setObjective / updateObjective / completeObjective nodes +
// the engine's authoritative `objectives` state). Covers the Sim mutation model
// (push / advance / complete), the SHOW toast emission, ordering, and the online
// serialize/deserialize round-trip that keeps the to-do list across a resync.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MissionLogicEngine, makeTestContext,
} from '../src/mission-logic/index.js';

function g(nodes, edges, variables = []) {
  return { version: 1, variables, nodes, edges };
}
const exec = (from, pin, to) => ({ from: { node: from, pin }, to: { node: to, pin: 'in' }, kind: 'exec' });
const data = (from, pin, to, toPin) => ({ from: { node: from, pin }, to: { node: to, pin: toPin }, kind: 'data' });
const logsOf = (ctx) => ctx._emitted.filter((e) => e.kind === 'objectiveLog');

describe('mission-log / setObjective (push onto the log)', () => {
  test('pushes a new objective with a numeric target and a toast', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'zk', label: 'Kill three zombies', target: 3 } },
      ],
      [exec('start', 'out', 'set')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');

    const objs = eng.objectives();
    assert.equal(objs.length, 1);
    assert.deepEqual(objs[0], { id: 'zk', label: 'Kill three zombies', target: 3, current: 0, completed: false });

    // A toast fired describing the addition, carrying the whole list snapshot.
    const logs = logsOf(ctx);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].change, 'added');
    assert.equal(logs[0].objective.id, 'zk');
    assert.equal(logs[0].objectives.length, 1);
  });

  test('a target-less objective is a plain checkbox (target null)', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'golem', label: 'Defeat the Wood Golem' } },
      ],
      [exec('start', 'out', 'set')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');
    assert.equal(eng.objectives()[0].target, null);
    assert.equal(eng.objectives()[0].completed, false);
  });

  test('redefining the same id updates in place (keeps order, no duplicate)', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'a', type: 'setObjective', params: { id: 'one', label: 'First' } },
        { id: 'b', type: 'setObjective', params: { id: 'two', label: 'Second' } },
        { id: 'c', type: 'setObjective', params: { id: 'one', label: 'First (renamed)', target: 2 } },
      ],
      [exec('start', 'out', 'a'), exec('a', 'done', 'b'), exec('b', 'done', 'c')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');
    const objs = eng.objectives();
    assert.equal(objs.length, 2, 'no duplicate id');
    assert.equal(objs[0].id, 'one', 'order preserved (redefine in place)');
    assert.equal(objs[0].label, 'First (renamed)');
    assert.equal(objs[0].target, 2);
  });

  test('an unconfigured node (no id) is a safe no-op', () => {
    const graph = g(
      [{ id: 'start', type: 'onMissionStart' }, { id: 'set', type: 'setObjective', params: {} }],
      [exec('start', 'out', 'set')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');
    assert.equal(eng.objectives().length, 0);
    assert.equal(logsOf(ctx).length, 0);
  });
});

describe('mission-log / updateObjective (advance progress)', () => {
  function progressGraph(updateParams = {}) {
    return g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'zk', label: 'Kill three zombies', target: 3 } },
        { id: 'ev', type: 'onKillCount', params: { faction: 'hero', count: 1 } },
        { id: 'upd', type: 'updateObjective', params: { id: 'zk', ...updateParams } },
      ],
      [exec('start', 'out', 'set'), exec('ev', 'out', 'upd')],
    );
  }

  test('default delta +1 advances 0→1→2→3 and auto-completes at the target', () => {
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(progressGraph(), ctx);
    eng.dispatch('missionStart');
    eng.dispatch('killCount', { faction: 'hero', count: 1 });
    assert.equal(eng.objectives()[0].current, 1);
    assert.equal(eng.objectives()[0].completed, false);

    eng.dispatch('killCount', { faction: 'hero', count: 2 });
    assert.equal(eng.objectives()[0].current, 2);

    eng.dispatch('killCount', { faction: 'hero', count: 3 });
    assert.equal(eng.objectives()[0].current, 3);
    assert.equal(eng.objectives()[0].completed, true, 'reaching target auto-completes');

    const logs = logsOf(ctx);
    // 1 added + 3 updates; the last is a completion.
    assert.equal(logs.filter((l) => l.change === 'progress').length, 2);
    assert.equal(logs.filter((l) => l.change === 'completed').length, 1);
  });

  test('an absolute `set` jumps current to that value', () => {
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(progressGraph({ set: 2 }), ctx);
    eng.dispatch('missionStart');
    eng.dispatch('killCount', { faction: 'hero', count: 1 });
    assert.equal(eng.objectives()[0].current, 2);
  });

  test('current is clamped to target (a kill counter can over-shoot)', () => {
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(progressGraph({ set: 99 }), ctx);
    eng.dispatch('missionStart');
    eng.dispatch('killCount', { faction: 'hero', count: 1 });
    assert.equal(eng.objectives()[0].current, 3, 'clamped to target');
    assert.equal(eng.objectives()[0].completed, true);
  });

  test('updating an already-completed objective is a no-op (no regress / re-toast)', () => {
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(progressGraph({ set: 3 }), ctx);
    eng.dispatch('missionStart');
    eng.dispatch('killCount', { faction: 'hero', count: 1 }); // → completed
    const before = logsOf(ctx).length;
    eng.dispatch('killCount', { faction: 'hero', count: 2 }); // ignored
    assert.equal(logsOf(ctx).length, before, 'no extra toast after completion');
    assert.equal(eng.objectives()[0].current, 3);
  });

  test('re-driving the same absolute count is idempotent (no regress, no toast)', () => {
    // A cumulative onKillCount(>=1) event re-fires on a round with no new kills;
    // setting the objective to the same value must NOT emit a duplicate toast.
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(progressGraph({ set: 1 }), ctx);
    eng.dispatch('missionStart');
    eng.dispatch('killCount', { faction: 'hero', count: 1 }); // 0 → 1, one toast
    const after = logsOf(ctx).length;
    eng.dispatch('killCount', { faction: 'hero', count: 2 }); // set 1 again → no-op
    assert.equal(eng.objectives()[0].current, 1);
    assert.equal(logsOf(ctx).length, after, 'no duplicate toast when the count is unchanged');
  });

  test('updating an unknown id is a safe no-op', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'upd', type: 'updateObjective', params: { id: 'ghost' } },
      ],
      [exec('start', 'out', 'upd')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');
    assert.equal(eng.objectives().length, 0);
    assert.equal(logsOf(ctx).length, 0);
  });
});

describe('mission-log / completeObjective (mark done)', () => {
  test('marks a target-less objective complete and emits a completion toast', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'golem', label: 'Defeat the Wood Golem' } },
        { id: 'ev', type: 'factionEvent', params: { faction: 'witch' } },
        { id: 'done', type: 'completeObjective', params: { id: 'golem' } },
      ],
      [exec('start', 'out', 'set'), exec('ev', 'onAllUnitsDead', 'done')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');
    assert.equal(eng.objectives()[0].completed, false);
    eng.dispatch('factionAllDead', { faction: 'witch' });
    assert.equal(eng.objectives()[0].completed, true);
    assert.equal(logsOf(ctx).filter((l) => l.change === 'completed').length, 1);
  });

  test('completing a counted objective snaps current to target', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'zk', label: 'Kill three zombies', target: 3 } },
        { id: 'done', type: 'completeObjective', params: { id: 'zk' } },
      ],
      [exec('start', 'out', 'set'), exec('set', 'done', 'done')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');
    assert.equal(eng.objectives()[0].current, 3);
    assert.equal(eng.objectives()[0].completed, true);
  });
});

describe('mission-log / the Ch1M1 demonstration shape', () => {
  // Kill three zombies (0/3 → 3/3 strikethrough), then a NEW objective
  // "Defeat the Wood Golem" is pushed when the golem appears.
  function ch1m1Graph() {
    return g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'setKill', type: 'setObjective', params: { id: 'kill3', label: 'Kill three zombies', target: 3 } },

        { id: 'k1', type: 'onKillCount', params: { faction: 'hero', count: 1 } },
        { id: 'u1', type: 'updateObjective', params: { id: 'kill3', set: 1 } },
        { id: 'k2', type: 'onKillCount', params: { faction: 'hero', count: 2 } },
        { id: 'u2', type: 'updateObjective', params: { id: 'kill3', set: 2 } },
        { id: 'k3', type: 'onKillCount', params: { faction: 'hero', count: 3 } },
        { id: 'once', type: 'doOnce' },
        { id: 'seq', type: 'sequence', params: { outputs: 3 } },
        { id: 'u3', type: 'updateObjective', params: { id: 'kill3', set: 3 } },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'wood_golem', spawnAt: 'near_hero' }] } },
        { id: 'beat', type: 'storyBeat', params: { title: 'Something Rises', text: 'The corpses knit into a golem.' } },
        { id: 'setGolem', type: 'setObjective', params: { id: 'golem', label: 'Defeat the Wood Golem' } },
      ],
      [
        exec('start', 'out', 'setKill'),
        exec('k1', 'out', 'u1'),
        exec('k2', 'out', 'u2'),
        exec('k3', 'out', 'once'),
        exec('once', 'out', 'seq'),
        exec('seq', 'then0', 'u3'),
        exec('seq', 'then1', 'spawn'),
        // The golem's Done pin fires the story beat — Sim (spawn) before Show (beat).
        exec('spawn', 'done', 'beat'),
        exec('seq', 'then2', 'setGolem'),
      ],
    );
  }

  test('progresses to 3/3, completes, then pushes the golem objective', () => {
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(ch1m1Graph(), ctx);
    eng.dispatch('missionStart');
    assert.equal(eng.objectives().length, 1);
    assert.equal(eng.objectives()[0].current, 0);

    eng.dispatch('killCount', { faction: 'hero', count: 1 });
    assert.equal(eng.objectives()[0].current, 1);
    eng.dispatch('killCount', { faction: 'hero', count: 2 });
    assert.equal(eng.objectives()[0].current, 2);
    eng.dispatch('killCount', { faction: 'hero', count: 3 });

    const objs = eng.objectives();
    assert.equal(objs[0].current, 3);
    assert.equal(objs[0].completed, true, 'kill3 struck through at 3/3');
    assert.equal(objs.length, 2, 'golem objective pushed');
    assert.equal(objs[1].id, 'golem');
    assert.equal(objs[1].completed, false);

    // The golem actually spawned (Sim ran), and exactly one golem-add toast fired.
    assert.equal(ctx._emitted.filter((e) => e.kind === 'spawn').length, 1);
    assert.equal(logsOf(ctx).filter((l) => l.change === 'added' && l.objective.id === 'golem').length, 1);

    // A story beat (Show) accompanies the golem's appearance, AND it fires
    // AFTER the spawn (Sim) — the corpses rise, then the narration plays.
    const beats = ctx._emitted.filter((e) => e.kind === 'storyBeat');
    assert.equal(beats.length, 1, 'exactly one golem story beat');
    assert.equal(beats[0].title, 'Something Rises');
    const spawnIdx = ctx._emitted.findIndex((e) => e.kind === 'spawn');
    const beatIdx = ctx._emitted.findIndex((e) => e.kind === 'storyBeat');
    assert.ok(spawnIdx >= 0 && spawnIdx < beatIdx, 'Sim spawn emitted before the Show beat');
  });

  test('the kill→golem chain fires once even if kills keep coming (Do Once)', () => {
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(ch1m1Graph(), ctx);
    eng.dispatch('missionStart');
    eng.dispatch('killCount', { faction: 'hero', count: 3 });
    eng.dispatch('killCount', { faction: 'hero', count: 4 });
    eng.dispatch('killCount', { faction: 'hero', count: 5 });
    // Exactly one golem objective + one golem spawn + one story beat despite
    // repeated >=3 pulses (Do Once gates the whole chain).
    assert.equal(eng.objectives().filter((o) => o.id === 'golem').length, 1);
    assert.equal(ctx._emitted.filter((e) => e.kind === 'spawn').length, 1);
    assert.equal(ctx._emitted.filter((e) => e.kind === 'storyBeat').length, 1);
  });
});

describe('mission-log / online serialize ↔ deserialize round-trip', () => {
  test('the objective list survives a fresh engine that loads the snapshot', () => {
    // The update node uses the default +1 delta so each kill advances by one.
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'zk', label: 'Kill three zombies', target: 3 } },
        { id: 'ev', type: 'onKillCount', params: { faction: 'hero', count: 1 } },
        { id: 'upd', type: 'updateObjective', params: { id: 'zk' } },
      ],
      [exec('start', 'out', 'set'), exec('ev', 'out', 'upd')],
    );
    const ctx1 = makeTestContext();
    const eng1 = new MissionLogicEngine(graph, ctx1);
    eng1.dispatch('missionStart');
    eng1.dispatch('killCount', { faction: 'hero', count: 1 }); // 0 → 1
    eng1.dispatch('killCount', { faction: 'hero', count: 2 }); // 1 → 2
    assert.equal(eng1.objectives()[0].current, 2);

    const snap = eng1.serialize();
    assert.ok(Array.isArray(snap.objectives), 'objectives serialize alongside firedOnce/counters');
    assert.equal(snap.objectives[0].current, 2);

    // A fresh engine (online resync / save-resume) loads it and keeps the progress.
    const ctx2 = makeTestContext();
    const eng2 = new MissionLogicEngine(graph, ctx2);
    eng2.load(snap);
    assert.deepEqual(eng2.objectives(), [
      { id: 'zk', label: 'Kill three zombies', target: 3, current: 2, completed: false },
    ]);

    // The restored engine continues correctly: one more kill → 3/3 completed.
    eng2.dispatch('killCount', { faction: 'hero', count: 3 }); // 2 → 3
    assert.equal(eng2.objectives()[0].current, 3);
    assert.equal(eng2.objectives()[0].completed, true);
  });

  test('serialize returns a deep copy — later mutation does not poison the snapshot', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'zk', label: 'x', target: 3 } },
      ],
      [exec('start', 'out', 'set')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');
    const snap = eng.serialize();
    eng.state.objectives[0].current = 99; // mutate live state after snapshot
    assert.equal(snap.objectives[0].current, 0, 'snapshot is an independent copy');
  });

  test('objectives() returns a copy — callers cannot mutate engine state', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'zk', label: 'x', target: 3 } },
      ],
      [exec('start', 'out', 'set')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);
    eng.dispatch('missionStart');
    const view = eng.objectives();
    view[0].current = 42;
    assert.equal(eng.objectives()[0].current, 0, 'engine state untouched by caller mutation');
  });
});

describe('mission-log / determinism', () => {
  test('identical dispatch sequence → identical emitted stream + state', () => {
    const graph = g(
      [
        { id: 'start', type: 'onMissionStart' },
        { id: 'set', type: 'setObjective', params: { id: 'zk', label: 'Kill three zombies', target: 3 } },
        { id: 'ev', type: 'onKillCount', params: { faction: 'hero', count: 1 } },
        { id: 'upd', type: 'updateObjective', params: { id: 'zk' } },
      ],
      [exec('start', 'out', 'set'), exec('ev', 'out', 'upd')],
    );
    const run = () => {
      const ctx = makeTestContext();
      const eng = new MissionLogicEngine(graph, ctx);
      eng.dispatch('missionStart');
      eng.dispatch('killCount', { faction: 'hero', count: 1 });
      eng.dispatch('killCount', { faction: 'hero', count: 2 });
      return { emitted: ctx._emitted, objectives: eng.objectives() };
    };
    assert.deepEqual(run(), run());
  });
});
