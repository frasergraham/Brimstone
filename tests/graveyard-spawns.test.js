// Witch graveyard passive spawns — design pass June 2026.
//
// The hero's income (survivor recruitment) compounds while every witch unit
// costs an action to summon. To soften the snowball, graveyards raise a free
// witch-owned zombie at the end of every full day-cycle (8 rounds), capped so
// the swarm can't grow unbounded:
//   - cadence: end of rounds 8, 16, 24, … (one spawn per graveyard per cycle)
//   - cap: at most GRAVEYARD_ZOMBIE_CAP witch zombies alive at once
//   - owned by the witch side (nearest alive night-side leader's ownerId)
//   - standard games only — battle mode and campaign missions keep their own
//     tuned economies

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, GameMode } from '../src/game.js';
import { EntityType, createZombie, createHero } from '../src/entities.js';
import { BuildingType } from '../src/tiles.js';
import { GRAVEYARD_SPAWN_INTERVAL, GRAVEYARD_ZOMBIE_CAP } from '../src/factions.js';
import { hexKey } from '../src/hex.js';

function newGame() {
  // Seeds vary — standard maps always place exactly one graveyard.
  const state = new GameState(true, true, 'standard');
  state.disableScoring = true;  // keep endRound side effects minimal
  return state;
}

function graveyardTile(state) {
  for (const [, t] of state.tiles) {
    if (t.building === BuildingType.GRAVEYARD) return t;
  }
  return null;
}

function witchZombies(state) {
  return state.entities.filter(e => e.alive && e.owner === 'witch' && e.type === EntityType.ZOMBIE);
}

describe('graveyard passive zombie spawns', () => {
  test('a zombie rises at the end of each full cycle', () => {
    const state = newGame();
    const grave = graveyardTile(state);
    assert.ok(grave, 'standard map must have a graveyard');

    state.round = GRAVEYARD_SPAWN_INTERVAL;  // end of the first full cycle
    const before = witchZombies(state).length;
    state.endRound();
    const after = witchZombies(state);
    assert.equal(after.length, before + 1, 'one zombie should rise at cycle end');

    const z = after[after.length - 1];
    assert.equal(z.owner, 'witch');
    assert.equal(z.type, EntityType.ZOMBIE);
    const dist = Math.abs(z.col - grave.col) + Math.abs(z.row - grave.row);
    assert.ok(dist <= 2, 'zombie should rise at (or adjacent to) the graveyard');
  });

  test('no spawn on rounds that are not a cycle end', () => {
    const state = newGame();
    state.round = GRAVEYARD_SPAWN_INTERVAL + 1;
    const before = witchZombies(state).length;
    state.endRound();
    assert.equal(witchZombies(state).length, before);
  });

  test('spawned zombie is owned by the witch player', () => {
    const state = newGame();
    const witchLeader = state.witch;
    assert.ok(witchLeader?.ownerId, 'test setup: witch leader must have an ownerId');

    state.round = GRAVEYARD_SPAWN_INTERVAL;
    state.endRound();
    const z = witchZombies(state).at(-1);
    assert.equal(z.ownerId, witchLeader.ownerId);
  });

  test('cap: no spawn while the witch already has the max zombies', () => {
    const state = newGame();
    const grave = graveyardTile(state);
    for (let i = 0; i < GRAVEYARD_ZOMBIE_CAP; i++) {
      state.entities.push(createZombie(grave.col, grave.row, state.witch?.ownerId, state));
    }
    state.round = GRAVEYARD_SPAWN_INTERVAL;
    const before = witchZombies(state).length;
    state.endRound();
    assert.equal(witchZombies(state).length, before, 'cap must block the spawn');
  });

  test('occupied graveyard: zombie rises on an adjacent hex instead', () => {
    const state = newGame();
    const grave = graveyardTile(state);
    // A hero-side unit camps the graveyard entrance
    state.entities.push(createHero(grave.col, grave.row, 'blocker-player', state));

    state.round = GRAVEYARD_SPAWN_INTERVAL;
    const before = witchZombies(state).length;
    state.endRound();
    const after = witchZombies(state);
    assert.equal(after.length, before + 1, 'spawn should relocate, not vanish');
    const z = after.at(-1);
    assert.ok(!(z.col === grave.col && z.row === grave.row),
      'zombie must not share the hex with the enemy blocker');
  });

  test('battle mode and campaign missions are exempt', () => {
    const battle = newGame();
    battle.gameMode = GameMode.BATTLE;
    battle.round = GRAVEYARD_SPAWN_INTERVAL;
    const b = witchZombies(battle).length;
    battle.endRound();
    assert.equal(witchZombies(battle).length, b, 'battle mode keeps its own economy');

    const campaign = newGame();
    campaign.victoryDelegate = () => null;  // campaign marker
    campaign.round = GRAVEYARD_SPAWN_INTERVAL;
    const c = witchZombies(campaign).length;
    campaign.endRound();
    assert.equal(witchZombies(campaign).length, c, 'campaign missions keep their tuned difficulty');
  });

  test('no spawn when the night side has no leader', () => {
    const state = newGame();
    state.entities = state.entities.filter(e => e.owner !== 'witch');
    state.witch = null;
    state.round = GRAVEYARD_SPAWN_INTERVAL;
    state.endRound();
    assert.equal(witchZombies(state).length, 0);
  });
});
