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
import { triggerSurvivorEncounter } from '../src/survivor-discovery.js';
import { hexKey } from '../src/hex.js';
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

  test('discovering a PINNED hidden survivor fires its On Actor (OnSpawn) — e.g. a conversation', () => {
    const state = new GameState(true, true);
    state.maxDiscoverableSurvivors = null; // unlimited finds
    const PIN = 'Pinned One';
    attach(state, {
      version: 1, variables: [],
      nodes: [
        { id: 'act', type: 'onActor', params: { ref: PIN } },
        { id: 'beat', type: 'storyBeat', params: { title: 'Reunited', text: 'Found at last.' } },
      ],
      edges: [{ from: { node: 'act', pin: 'onSpawn' }, to: { node: 'beat', pin: 'in' }, kind: 'exec' }],
    });
    // Pin a hidden survivor onto the hero's tile, then discover it.
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.hiddenSurvivor = true; t.hiddenSurvivorId = PIN;
    state.pumpMissionLogic('roundStart'); // baseline the actor-spawn tracking
    triggerSurvivorEncounter(state, hero, hero.col, hero.row);
    // The discovered survivor carries its pin as a logic ref so the Actor node binds.
    assert.ok(state.entities.some((e) => e.ref === PIN), 'pinned survivor got its ref');
    const fired = state.pumpMissionLogic('postResolution');
    assert.ok(fired.some((e) => e.kind === 'storyBeat' && e.title === 'Reunited'),
      'On Actor OnSpawn fired the wired beat/conversation on discovery');
  });

  test('Survivor → On Actor → Start Conversation: discovery emits a conversation with the wired participant bound', () => {
    const state = new GameState(true, true);
    state.maxDiscoverableSurvivors = null;
    const PIN = 'Goodwife Hale';
    // The exact wiring an author builds in the editor: a Survivor source node
    // feeds On Actor's `ref`; On Actor's OnSpawn drives Start Conversation; its
    // `entity` output is wired into the conversation's `survivor` role pin.
    attach(state, {
      version: 1, variables: [],
      nodes: [
        { id: 'surv', type: 'survivor', params: { ref: PIN, col: state.hero.col, row: state.hero.row } },
        { id: 'act', type: 'onActor', params: {} },
        { id: 'conv', type: 'startConversation', params: { conversationId: 'ch1m2-survivor', roleInputs: ['survivor'] } },
      ],
      edges: [
        { from: { node: 'surv', pin: 'id' }, to: { node: 'act', pin: 'ref' }, kind: 'data' },
        { from: { node: 'act', pin: 'onSpawn' }, to: { node: 'conv', pin: 'in' }, kind: 'exec' },
        { from: { node: 'act', pin: 'entity' }, to: { node: 'conv', pin: 'survivor' }, kind: 'data' },
      ],
    });
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.hiddenSurvivor = true; t.hiddenSurvivorId = PIN;
    state.pumpMissionLogic('roundStart');
    triggerSurvivorEncounter(state, hero, hero.col, hero.row);
    const fired = state.pumpMissionLogic('postResolution');
    const conv = fired.find((e) => e.kind === 'conversation');
    assert.ok(conv, 'a conversation event was emitted on discovery');
    assert.equal(conv.id, 'ch1m2-survivor');
    const discovered = state.entities.find((e) => e.ref === PIN);
    assert.ok(discovered, 'the survivor was materialised');
    assert.equal(conv.roles.survivor, discovered,
      'the wired `survivor` role carries the live discovered entity (not just a string)');
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

  // Mission 2's win/lose are objectiveOutcome nodes wired to onRoundStart, so the
  // mission is DECIDED during the round-start pump (at planning time), not in
  // endRound's checkVictory. The offline loop must surface that gameOver instead
  // of entering planning — see _finishDecidedMissionBeforePlanning in main.js.
  // (Regression: reaching dusk on M2 soft-locked the player in planning mode.)
  describe('outcome decided at the round-start pump (Mission 2 phase-gated win/lose)', () => {
    const M2_CYCLE = { phases: ['dawn', 'day', 'day', 'day', 'day', 'day', 'dusk'], loop: false };
    function m2State(graphNode) {
      const state = new GameState(true, true);
      state.cycleConfig = M2_CYCLE;
      attach(state, {
        version: 1, variables: [],
        nodes: [{ id: 'r', type: 'onRoundStart', params: { round: 'any' } }, graphNode],
        edges: [exec('r', 'out', graphNode.id)],
      });
      state.round = 7; state.phase = 'dusk'; // the cycle's final phase (idx 6)
      return state;
    }

    test('dusk WITHOUT enough survivors decides a loss at round start', () => {
      const state = m2State({
        id: 'lose', type: 'objectiveOutcome', params: {
          side: 'lose',
          spec: { type: 'phase_without_survivors', phase: 'dusk', survivors: 2 },
          reason: 'Night fell before you found enough survivors.',
        },
      });
      assert.equal(state.gameOver, false, 'not over before the pump');
      state.pumpMissionLogic('roundStart');
      assert.equal(state.gameOver, true, 'the loss is decided at the round-start pump');
      assert.equal(state.winner, 'witch');
      assert.equal(state.winReason, 'Night fell before you found enough survivors.');
    });

    test('dusk WITH enough survivors decides a win at round start (phase fallback)', () => {
      const state = m2State({
        id: 'win', type: 'objectiveOutcome', params: {
          side: 'win',
          spec: { type: 'gather_and_survive', survivors: 2, kills: 4, phaseFallback: 'dusk' },
          reason: 'The survivors are safe.',
        },
      });
      // Two rescued survivors standing (hero-faction, non-NPC).
      state.entities.push(
        { id: 's1', type: 'survivor', owner: 'hero', isNpc: false, hp: 3, alive: true, col: 1, row: 1 },
        { id: 's2', type: 'survivor', owner: 'hero', isNpc: false, hp: 3, alive: true, col: 2, row: 2 },
      );
      state.pumpMissionLogic('roundStart');
      assert.equal(state.gameOver, true, 'the win is decided at the round-start pump');
      assert.equal(state.winner, 'hero');
      assert.equal(state.winReason, 'The survivors are safe.');
    });
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
