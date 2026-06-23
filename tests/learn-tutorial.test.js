// Geometry + content validation for the standalone "Learn to Play" tutorial.
//
// The scripted path (advance → fight → fortify/guard) is only playable if every
// move is reachable and every attack is in range on the FIXED map. Rather than
// hand-derive odd-r offset coordinates, assert them against the live engine here
// and adjust src/learn/learn-config.js until green.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState } from '../src/game.js';
import { createSurvivor, createZombie, EntityType } from '../src/entities.js';
import { getReachableHexes } from '../src/actions.js';
import { hexDistance } from '../src/hex.js';
import {
  buildLearnMap, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG,
  LEARN_HERO_START, LEARN_CHAPEL, LEARN_SURVIVOR_A, LEARN_SURVIVOR_B,
  LEARN_SURVIVOR_A_ADVANCE, LEARN_SURVIVOR_B_ADVANCE, LEARN_ZOMBIES, LEARN_WITCH_APPROACH,
} from '../src/learn/learn-config.js';

// Build the live starting board exactly as the launcher does.
function buildBoard() {
  const map = buildLearnMap();
  const state = new GameState(false, false, 'tutorial', null, map);
  state.fogOfWar = 'partial';

  const a = createSurvivor(LEARN_SURVIVOR_A.col, LEARN_SURVIVOR_A.row, null, state);
  a.owner = 'hero';
  const b = createSurvivor(LEARN_SURVIVOR_B.col, LEARN_SURVIVOR_B.row, null, state);
  b.owner = 'hero';
  b.equipWeapon('bow');
  state.entities.push(a, b);

  const zombies = LEARN_ZOMBIES.map(z => {
    const e = createZombie(z.start.col, z.start.row, 'witch', state);
    e.hp = 1; e.maxHp = 1;
    state.entities.push(e);
    return e;
  });

  return { state, hero: state.hero, witch: state.witch, survA: a, survB: b, zombies };
}

const reaches = (state, actor, hex) =>
  getReachableHexes(state, actor, 1).some(h => h.col === hex.col && h.row === hex.row);

test('learn map: hero and townsfolk reach their round-0 destinations', () => {
  const { state, hero, survA, survB } = buildBoard();
  assert.ok(reaches(state, hero, LEARN_CHAPEL), 'hero should reach the chapel in one move');
  assert.ok(reaches(state, survA, LEARN_SURVIVOR_A_ADVANCE), 'melee townsperson should reach the hero\'s chapel hex');
  assert.ok(reaches(state, survB, LEARN_SURVIVOR_B_ADVANCE), 'archer should reach the flank hex');
});

test('learn map: the chapel is a building (FORTIFY needs one) holding the node', () => {
  const { state } = buildBoard();
  const t = state.tiles.get(`${LEARN_CHAPEL.col},${LEARN_CHAPEL.row}`);
  assert.ok(t?.building, 'chapel hex must be a building so the party can fortify it');
  const node = state.witchObjectives[0];
  assert.ok(node.hexes.some(h => h.col === LEARN_CHAPEL.col && h.row === LEARN_CHAPEL.row),
    'the chapel hex should be part of the power node');
});

test('learn map: zombies advance into view and into combat range', () => {
  const { state, zombies } = buildBoard();
  for (let i = 0; i < zombies.length; i++) {
    assert.ok(reaches(state, zombies[i], LEARN_ZOMBIES[i].advance),
      `zombie ${i} should reach its advance hex`);
  }
  // Round 1: hero melee-attacks Z1 from the chapel; archer shoots Z2 from the flank.
  const z1 = LEARN_ZOMBIES[0].advance, z2 = LEARN_ZOMBIES[1].advance;
  assert.equal(hexDistance(LEARN_CHAPEL.col, LEARN_CHAPEL.row, z1.col, z1.row), 1,
    'Z1 must end adjacent to the chapel for the hero\'s melee strike');
  const bowRange = 3;
  assert.ok(hexDistance(LEARN_SURVIVOR_B_ADVANCE.col, LEARN_SURVIVOR_B_ADVANCE.row, z2.col, z2.row) <= bowRange,
    'Z2 must end within bow range of the archer');
});

test('learn map: the Witch makes her two-step approach into the guard trap', () => {
  const { state, witch } = buildBoard();
  assert.ok(witch, 'a Witch leader must exist for the free-play handoff');
  assert.ok(reaches(state, witch, LEARN_WITCH_APPROACH[0]), 'witch reaches her round-1 emergence hex');
  // Move her there, then check the round-2 step is reachable from the new spot.
  witch.col = LEARN_WITCH_APPROACH[0].col; witch.row = LEARN_WITCH_APPROACH[0].row;
  assert.ok(reaches(state, witch, LEARN_WITCH_APPROACH[1]), 'witch reaches the guard-trap hex');
  assert.equal(hexDistance(LEARN_CHAPEL.col, LEARN_CHAPEL.row, LEARN_WITCH_APPROACH[1].col, LEARN_WITCH_APPROACH[1].row), 1,
    'the witch\'s final hex must be adjacent to the chapel so the guard fires');
});

test('learn steps: action-gated steps carry a spotlight arrow and a click allowlist', () => {
  const ACTION_GATED = new Set(['action_queued', 'entity_selected']);
  for (const step of LEARN_STEPS) {
    assert.ok(step.id && step.title && step.body, `step ${step.id} needs id/title/body`);
    // No color emoji in player-facing copy (matches the project-wide guard).
    assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(step.title + step.body),
      `step ${step.id} must not contain color emoji`);
    const t = step.trigger;
    if (t && typeof t === 'object' && ACTION_GATED.has(t.type)) {
      assert.ok(step.spotlight, `gated step ${step.id} needs a spotlight`);
      assert.ok(step.spotlight.arrow, `gated step ${step.id} needs a directional arrow`);
      assert.ok(Array.isArray(step.allowHexes), `gated step ${step.id} needs an allowHexes list`);
    }
  }
});

test('learn config: round-step map points at real steps and ends in a handoff', () => {
  const ids = new Set(LEARN_STEPS.map(s => s.id));
  for (const id of Object.values(LEARN_CONDUCTOR_CONFIG.roundStepMap)) {
    assert.ok(ids.has(id), `roundStepMap references unknown step ${id}`);
  }
  assert.ok(LEARN_STEPS.some(s => s.trigger === 'handoff'), 'a handoff step must release control to free play');
  assert.equal(LEARN_CONDUCTOR_CONFIG.maxPlanningRounds, 3);
});
