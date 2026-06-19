// Campaign opt-out for the two ambient per-side spawn mechanics:
//   1. Hero node-survivor spawning ("the node calls to the living") — a survivor
//      emerges next to a Power Node the hero holds during NIGHT.
//   2. Witch graveyard zombie support troop — a free zombie rises at the end of
//      every full day-cycle (8 rounds).
//
// A campaign mission disables either (or both via `ambientSpawns:false`); the
// flags reach GameState as `disableNodeSurvivorSpawn` / `disableWitchSupport`.
// Default false ⇒ both mechanics run as normal for non-campaign play.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { BuildingType } from '../src/tiles.js';
import { GRAVEYARD_SPAWN_INTERVAL, getFaction } from '../src/factions.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

// Construct a normal procedural standard game, then set the ambient-toggle
// flags by assignment — passing them via the constructor's 5th arg would skip
// map generation (mapDataOverride implies a fully prebuilt map). This mirrors
// how GameState reads `mapDataOverride?.disable*` at construction; here we set
// the same fields directly after the procedural map is built.
function newGame(flags = {}) {
  const state = new GameState(true, true, 'standard');
  state.disableScoring = true; // keep endRound side effects minimal
  if (flags.disableWitchSupport) state.disableWitchSupport = true;
  if (flags.disableNodeSurvivorSpawn) state.disableNodeSurvivorSpawn = true;
  return state;
}

function graveyardTile(state) {
  for (const [, t] of state.tiles) {
    if (t.building === BuildingType.GRAVEYARD) return t;
  }
  return null;
}

function witchZombies(state) {
  return state.entities.filter(
    e => e.alive && e.owner === 'witch' && e.type === EntityType.ZOMBIE
  );
}

function survivors(state) {
  return state.entities.filter(e => e.alive && e.type === EntityType.SURVIVOR);
}

// Stand the hero leader on a Power Node and force NIGHT so the node-survivor
// spawn path runs. The spawn has a 33% random gate, so we drive many rounds and
// assert at least one emerged (default) / zero emerged (disabled).
function runNodeSpawnTrials(state, rounds = 200) {
  const hero = state.hero;
  const node = state.witchObjectives[0];
  assert.ok(hero && node, 'test setup: need a hero leader and a node');
  const heroFaction = getFaction('hero');
  let spawnedTotal = 0;
  for (let i = 0; i < rounds; i++) {
    // Seat the hero on the node hex and clear any survivors from prior trials so
    // each iteration measures only the spawns produced this round.
    hero.col = node.hexes[0].col;
    hero.row = node.hexes[0].row;
    state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
    state.phase = Phase.NIGHT;
    heroFaction.applyEndOfRoundEffects(state);
    spawnedTotal += survivors(state).length;
  }
  return spawnedTotal;
}

describe('disableWitchSupport — campaign opt-out for the graveyard zombie troop', () => {
  test('default: a zombie still rises at cycle end', () => {
    const state = newGame();
    assert.ok(graveyardTile(state), 'standard map must have a graveyard');
    state.round = GRAVEYARD_SPAWN_INTERVAL;
    const before = witchZombies(state).length;
    state.endRound();
    assert.equal(witchZombies(state).length, before + 1, 'default behavior unchanged');
  });

  test('flag set: no zombie support troop spawns', () => {
    const state = newGame({ disableWitchSupport: true });
    assert.ok(graveyardTile(state), 'standard map must have a graveyard');
    state.round = GRAVEYARD_SPAWN_INTERVAL;
    const before = witchZombies(state).length;
    state.endRound();
    assert.equal(witchZombies(state).length, before, 'support troop must be suppressed');
  });

  test('flag set across multiple cycles: never spawns', () => {
    const state = newGame({ disableWitchSupport: true });
    for (let cycle = 1; cycle <= 5; cycle++) {
      state.round = GRAVEYARD_SPAWN_INTERVAL * cycle;
      state.endRound();
    }
    assert.equal(witchZombies(state).length, 0, 'no support zombies over 5 cycles');
  });
});

describe('disableNodeSurvivorSpawn — campaign opt-out for the node "call to the living"', () => {
  test('default: survivors emerge at a held node over many night rounds', () => {
    const state = newGame();
    const total = runNodeSpawnTrials(state, 120);
    assert.ok(total > 0, `expected at least one node-survivor spawn, got ${total}`);
  });

  test('flag set: zero survivors emerge at the node', () => {
    const state = newGame({ disableNodeSurvivorSpawn: true });
    const total = runNodeSpawnTrials(state, 120);
    assert.equal(total, 0, 'node survivor spawning must be fully suppressed');
  });

  test('flag set: nodeSpawnedSurvivors stays empty', () => {
    const state = newGame({ disableNodeSurvivorSpawn: true });
    const hero = state.hero;
    const node = state.witchObjectives[0];
    hero.col = node.hexes[0].col;
    hero.row = node.hexes[0].row;
    state.phase = Phase.NIGHT;
    getFaction('hero').applyEndOfRoundEffects(state);
    assert.equal(state.nodeSpawnedSurvivors.length, 0);
  });
});

describe('ambient-toggle flags survive serialization (online parity)', () => {
  test('both flags round-trip through state-sync', () => {
    const state = newGame({ disableWitchSupport: true, disableNodeSurvivorSpawn: true });
    const restored = deserializeState(serializeState(state));
    assert.equal(restored.disableWitchSupport, true);
    assert.equal(restored.disableNodeSurvivorSpawn, true);
  });

  test('defaults round-trip as false when unset', () => {
    const state = newGame();
    const restored = deserializeState(serializeState(state));
    assert.equal(restored.disableWitchSupport, false);
    assert.equal(restored.disableNodeSurvivorSpawn, false);
  });
});
