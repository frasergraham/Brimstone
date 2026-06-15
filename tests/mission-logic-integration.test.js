// End-to-end integration of the Mission Logic Graph with a REAL GameState:
// the GameState-backed WorldContext (game-context.js), the pump points wired into
// game.js (missionStart / roundStart / postResolution + endRound), and the
// state-sync serialization of `logicState`. Exercises the real entity factory and
// the real victory delegate — not stubs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState } from '../src/game.js';
import { createZombie } from '../src/entities.js';
import { MissionLogicEngine } from '../src/mission-logic/engine.js';
import { createGameContext } from '../src/mission-logic/game-context.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

// A minimal createEnemyFn like main.js's _createEnemyEntity (without the DOM).
const createEnemyFn = (type, col, row, state) => createZombie(col, row, 'witch', state);

function attach(state, graph) {
  const ctx = createGameContext(state, {
    createEnemyFn,
    emit: (e) => state.logicPresentation.push(e),
    random: () => 0.5, // deterministic
  });
  const engine = new MissionLogicEngine(graph, ctx);
  state.attachLogicEngine(engine);
  return engine;
}

const exec = (from, pin, to) => ({ from: { node: from, pin }, to: { node: to, pin: 'in' }, kind: 'exec' });

describe('mission-logic / integration with GameState', () => {
  test('missionStart queues a story beat; non-logic state is a no-op', () => {
    const plain = new GameState(true, true);
    assert.equal(plain.logicEngine, null);
    assert.deepEqual(plain.pumpMissionLogic('missionStart'), []); // inert without an engine

    const state = new GameState(true, true);
    attach(state, {
      version: 1, variables: [],
      nodes: [
        { id: 'start', type: 'onMissionStart' },
        { id: 'beat', type: 'storyBeat', params: { title: 'Awakening', text: 'It begins.' } },
      ],
      edges: [exec('start', 'out', 'beat')],
    });
    const queued = state.pumpMissionLogic('missionStart');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].kind, 'storyBeat');
    assert.equal(queued[0].title, 'Awakening');
  });

  test('roundStart spawns a unit through the real entity factory + spawn path', () => {
    const state = new GameState(true, true);
    attach(state, {
      version: 1, variables: [],
      nodes: [
        { id: 'ev', type: 'onRoundStart', params: { round: 'any' } },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'zombie', spawnAt: { col: 0, row: 0 } }] } },
      ],
      edges: [exec('ev', 'out', 'spawn')],
    });
    const before = state.entities.length;
    const queued = state.pumpMissionLogic('roundStart');
    assert.equal(state.entities.length, before + 1, 'a zombie was actually added to the live state');
    const z = state.entities[state.entities.length - 1];
    assert.equal(z.type, 'zombie');
    assert.equal(z.owner, 'witch');
    assert.ok(queued.some(e => e.kind === 'spawn'));
  });

  test('postResolution faction-death drives a win through the real victory path', () => {
    const state = new GameState(true, true);
    attach(state, {
      version: 1, variables: [],
      nodes: [
        { id: 'witch', type: 'factionEvent', params: { faction: 'witch' } },
        { id: 'win', type: 'winMission', params: { winner: 'hero', reason: 'The grove is silent.' } },
      ],
      edges: [exec('witch', 'onAllUnitsDead', 'win')],
    });
    // Eliminate the witch faction (alive is a derived getter — kill via hp).
    for (const e of state.entities) if (e.owner === 'witch') e.hp = 0;
    assert.equal(state.factionEliminated('witch'), true);
    state.pumpMissionLogic('postResolution');
    assert.equal(state.winner, 'hero');
    assert.equal(state.winReason, 'The grove is silent.');
  });

  test('endRound runs the postResolution pump inline (spawn pre-empts checkVictory)', () => {
    const state = new GameState(true, true);
    // A kill-triggered golem-style wave: spawns once the hero has ≥1 kill.
    attach(state, {
      version: 1, variables: [],
      nodes: [
        { id: 'ev', type: 'onKillCount', params: { faction: 'hero', count: 1 } },
        { id: 'once', type: 'doOnce', params: {} },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'zombie', spawnAt: { col: 0, row: 0 } }] } },
      ],
      edges: [exec('ev', 'out', 'once'), exec('once', 'out', 'spawn')],
    });
    state.heroKills = 2;
    const before = state.entities.length;
    state.endRound(); // fires postResolution internally
    assert.equal(state.entities.length, before + 1, 'endRound pumped the logic spawn');
    // Idempotent via Do Once: a second endRound spawns nothing more.
    const mid = state.entities.length;
    state.endRound();
    assert.equal(state.entities.length, mid, 'Do Once held the second pulse');
  });

  test('logicState round-trips through state-sync serialize/deserialize', () => {
    const state = new GameState(true, true);
    const graph = {
      version: 1, variables: [],
      nodes: [
        { id: 'ev', type: 'onRoundStart', params: { round: 'any' } },
        { id: 'once', type: 'doOnce', params: {} },
        { id: 'beat', type: 'storyBeat', params: { title: 'once' } },
      ],
      edges: [exec('ev', 'out', 'once'), exec('once', 'out', 'beat')],
    };
    const engine = attach(state, graph);
    state.pumpMissionLogic('roundStart'); // fires the one-shot
    assert.ok(engine.serialize().firedOnce.length >= 1);

    const snap = serializeState(state);
    assert.ok(snap.logicState, 'serializeState carries logicState');

    const restored = deserializeState(snap);
    assert.deepEqual(restored._restoredLogicState, snap.logicState,
      'deserializeState stashes logicState for the mission loader');

    // A fresh engine loading the restored state must NOT re-fire the one-shot.
    const ctx2 = createGameContext(restored, { createEnemyFn, emit: (e) => restored.logicPresentation.push(e) });
    const engine2 = new MissionLogicEngine(graph, ctx2);
    engine2.load(restored._restoredLogicState);
    restored.attachLogicEngine(engine2);
    const queued = restored.pumpMissionLogic('roundStart');
    assert.equal(queued.filter(e => e.kind === 'storyBeat').length, 0,
      'restored one-shot did not re-fire');
  });
});
