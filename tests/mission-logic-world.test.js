// Tests for world↔graph linking nodes (docs/09 wishlist #1/#6): Location data
// node, Spawn Units `at` hex input, Actor OnSpawn/OnDeath, Move Unit / Despawn
// choreography, and Conversation-End events.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState } from '../src/game.js';
import { createZombie } from '../src/entities.js';
import { MissionLogicEngine, makeTestContext } from '../src/mission-logic/index.js';
import { createGameContext } from '../src/mission-logic/game-context.js';

const exec = (from, pin, to) => ({ from: { node: from, pin }, to: { node: to, pin: 'in' }, kind: 'exec' });
const data = (from, pin, to, toPin) => ({ from: { node: from, pin }, to: { node: to, pin: toPin }, kind: 'data' });
const g = (nodes, edges) => ({ version: 1, variables: [], nodes, edges });
const emitsOf = (ctx, kind) => ctx._emitted.filter((e) => e.kind === kind);

describe('mission-logic / Location + Spawn `at` input', () => {
  test('a Location node feeds Spawn Units its position', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onMissionStart' },
        { id: 'loc', type: 'location', params: { col: 7, row: 4 } },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'zombie', spawnAt: 'near_hero' }] } },
      ],
      [exec('ev', 'out', 'spawn'), data('loc', 'hex', 'spawn', 'at')],
    );
    const ctx = makeTestContext();
    new MissionLogicEngine(graph, ctx).dispatch('missionStart');
    const spawn = ctx._mutations.find((m) => m.op === 'spawn');
    assert.ok(spawn, 'a unit was spawned');
    assert.deepEqual(spawn.spec.spawnAt, { col: 7, row: 4 }, 'the wired location overrode spawnAt');
  });

  test('without a wired `at`, the unit keeps its own spawnAt', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onMissionStart' },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'zombie', spawnAt: 'map_edge' }] } },
      ],
      [exec('ev', 'out', 'spawn')],
    );
    const ctx = makeTestContext();
    new MissionLogicEngine(graph, ctx).dispatch('missionStart');
    assert.equal(ctx._mutations.find((m) => m.op === 'spawn').spec.spawnAt, 'map_edge');
  });
});

describe('mission-logic / Actor OnSpawn + OnDeath', () => {
  function build(ref) {
    return g(
      [
        { id: 'actor', type: 'onActor', params: { ref } },
        { id: 'born', type: 'storyBeat', params: { title: 'spawned' } },
        { id: 'died', type: 'storyBeat', params: { title: 'died' } },
      ],
      [exec('actor', 'onSpawn', 'born'), exec('actor', 'onDeath', 'died')],
    );
  }

  test('OnSpawn fires for a pre-placed ref-bound unit; OnDeath fires when it dies', () => {
    const state = new GameState(true, true);
    const ctx = createGameContext(state, { emit: (e) => state.logicPresentation.push(e), createEnemyFn: () => null });
    state.attachLogicEngine(new MissionLogicEngine(build('boss'), ctx));

    // Place a ref'd unit, then pump missionStart → OnSpawn.
    const boss = createZombie(0, 0, 'witch', state); boss.ref = 'boss'; state.entities.push(boss);
    state.pumpMissionLogic('missionStart');
    assert.equal(state.logicPresentation.filter((e) => e.kind === 'storyBeat' && e.title === 'spawned').length, 1);

    // Kill it (alive is derived from hp), then pump postResolution → OnDeath.
    boss.hp = 0;
    state.pumpMissionLogic('postResolution');
    assert.equal(state.logicPresentation.filter((e) => e.kind === 'storyBeat' && e.title === 'died').length, 1);
  });

  test('an unrelated unit dying does not fire the Actor node', () => {
    const state = new GameState(true, true);
    const ctx = createGameContext(state, { emit: (e) => state.logicPresentation.push(e), createEnemyFn: () => null });
    state.attachLogicEngine(new MissionLogicEngine(build('boss'), ctx));
    const other = createZombie(1, 1, 'witch', state); other.ref = 'minion'; state.entities.push(other);
    state.pumpMissionLogic('missionStart');
    other.hp = 0;
    state.pumpMissionLogic('postResolution');
    assert.equal(state.logicPresentation.filter((e) => e.kind === 'storyBeat').length, 0);
  });
});

describe('mission-logic / Move + Despawn choreography', () => {
  test('moveUnit and despawnUnit(npc) emit scriptedActions for runScriptedActions', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onConversationEnd', params: { conversationId: 'intro' } },
        { id: 'move', type: 'moveUnit', params: { npc: 'innkeeper', path: [{ col: 2, row: 5 }, { col: 2, row: 4 }] } },
        { id: 'gone', type: 'despawnUnit', params: { npc: 'innkeeper' } },
      ],
      [exec('ev', 'done', 'move'), exec('move', 'done', 'gone')],
    );
    const ctx = makeTestContext();
    const eng = new MissionLogicEngine(graph, ctx);

    eng.dispatch('conversationEnd', { id: 'other' }); // wrong id — no fire
    assert.equal(emitsOf(ctx, 'scriptedAction').length, 0);

    eng.dispatch('conversationEnd', { id: 'intro' });
    const acts = emitsOf(ctx, 'scriptedAction').map((e) => e.action);
    assert.deepEqual(acts, [
      { action: 'move', npc: 'innkeeper', path: [{ col: 2, row: 5 }, { col: 2, row: 4 }] },
      { action: 'despawn', npc: 'innkeeper' },
    ]);
  });

  test('despawnUnit without npc still removes a wired entity directly', () => {
    const graph = g(
      [
        { id: 'ev', type: 'onMissionStart' },
        { id: 'spawn', type: 'spawnUnits', params: { units: [{ type: 'zombie' }] } },
        { id: 'gone', type: 'despawnUnit', params: {} },
      ],
      [exec('ev', 'out', 'spawn'), exec('spawn', 'done', 'gone'), data('spawn', 'first', 'gone', 'target')],
    );
    const ctx = makeTestContext();
    new MissionLogicEngine(graph, ctx).dispatch('missionStart');
    assert.ok(ctx._mutations.some((m) => m.op === 'despawn'), 'direct removal via ctx.despawnUnit');
  });
});
