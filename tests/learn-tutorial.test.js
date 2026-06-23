// Geometry, content + sightline validation for the "Learn to Play" tutorial.
//
// The scripted path (advance → fight → fortify/guard) is only playable if every
// move is reachable, every attack is in range, and the Witch's forces are hidden
// at the start. Rather than hand-derive odd-r offset coordinates and line-of-sight,
// assert them against the live engine here and adjust src/learn/learn-config.js
// until green.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState } from '../src/game.js';
import { getReachableHexes, computeLineOfSight, hasLineOfSight } from '../src/actions.js';
import { hexDistance, hexKey } from '../src/hex.js';
import { isBuildingFootprint } from '../src/tiles.js';
import {
  buildLearnMap, placeLearnUnits, LEARN_STEPS, LEARN_CONDUCTOR_CONFIG,
  LEARN_HERO_START, LEARN_CHURCH, LEARN_BRIDGE, LEARN_SOLDIER, LEARN_ISAAC,
  LEARN_ISAAC_VANTAGE, LEARN_ZOMBIES, LEARN_WITCH_APPROACH,
} from '../src/learn/learn-config.js';

// Build the live starting board exactly as the launcher does.
function buildBoard() {
  const map = buildLearnMap();
  const state = new GameState(false, false, 'tutorial', null, map);
  state.fogOfWar = 'partial';
  const { soldier, isaac, zombies } = placeLearnUnits(state);
  return { state, hero: state.hero, witch: state.witch, soldier, isaac, zombies };
}

const reaches = (state, actor, hex, range = 1) =>
  getReachableHexes(state, actor, range).some(h => h.col === hex.col && h.row === hex.row);

test('learn map: nobody starts on the bridge', () => {
  for (const u of [LEARN_HERO_START, LEARN_SOLDIER, LEARN_ISAAC]) {
    assert.ok(!(u.col === LEARN_BRIDGE.col && u.row === LEARN_BRIDGE.row),
      'no friendly unit may start on the bridge');
  }
});

test('learn map: the hero advances across the bridge in TWO moves', () => {
  const { state, hero } = buildBoard();
  assert.ok(!reaches(state, hero, LEARN_CHURCH, 1), 'church should NOT be reachable in one move');
  assert.ok(reaches(state, hero, LEARN_BRIDGE, 1), 'the bridge is the first-move waypoint');
  // From the bridge, the church is one more move.
  hero.col = LEARN_BRIDGE.col; hero.row = LEARN_BRIDGE.row;
  assert.ok(reaches(state, hero, LEARN_CHURCH, 1), 'church reachable from the bridge in the second move');
});

test('learn map: the soldier needs TWO move actions to reach the hero\'s tile', () => {
  const { state, soldier } = buildBoard();
  assert.ok(!reaches(state, soldier, LEARN_CHURCH, 1), 'church should NOT be reachable in one move');
  assert.ok(reaches(state, soldier, LEARN_BRIDGE, 1), 'soldier reaches the bridge on the first move');
  soldier.col = LEARN_BRIDGE.col; soldier.row = LEARN_BRIDGE.row;
  assert.ok(reaches(state, soldier, LEARN_CHURCH, 1), 'soldier reaches the church on the second move');
});

test('learn map: Isaac reaches the northern clearing in one move and sees across', () => {
  const { state, isaac } = buildBoard();
  assert.ok(reaches(state, isaac, LEARN_ISAAC_VANTAGE, 1), 'Isaac reaches his vantage in one move');
  // From the vantage, clear line of sight to where the far zombie advances.
  const z2 = LEARN_ZOMBIES[1].advance;
  assert.ok(hasLineOfSight(state, LEARN_ISAAC_VANTAGE.col, LEARN_ISAAC_VANTAGE.row, z2.col, z2.row),
    'Isaac\'s vantage must see across the river to the far zombie');
});

test('learn map: the Witch\'s forces are ALL hidden at the start', () => {
  const { state, witch, zombies } = buildBoard();
  const visible = computeLineOfSight(state, 'hero');
  for (const z of zombies) {
    assert.ok(!visible.has(hexKey(z.col, z.row)), `zombie at ${z.col},${z.row} must be hidden at start`);
  }
  assert.ok(!visible.has(hexKey(witch.col, witch.row)), 'the Witch must be hidden at start');
});

test('learn map: buildings sit on a hex with an adjacent impassable footprint', () => {
  const { state } = buildBoard();
  for (const b of [LEARN_HERO_START, LEARN_CHURCH, { col: 7, row: 2 }]) {
    const t = state.tiles.get(hexKey(b.col, b.row));
    assert.ok(t?.building, `expected a building at ${b.col},${b.row}`);
    assert.ok(t.footprintHexes?.length === 1, `building at ${b.col},${b.row} needs a footprint hex`);
    const fp = state.tiles.get(t.footprintHexes[0]);
    assert.ok(isBuildingFootprint(fp), 'the footprint hex must be an impassable wall');
  }
});

test('learn map: zombies advance into combat range', () => {
  const { state, zombies } = buildBoard();
  for (let i = 0; i < zombies.length; i++) {
    assert.ok(reaches(state, zombies[i], LEARN_ZOMBIES[i].advance, 1),
      `zombie ${i} should reach its advance hex`);
  }
  const z1 = LEARN_ZOMBIES[0].advance, z2 = LEARN_ZOMBIES[1].advance;
  assert.equal(hexDistance(LEARN_CHURCH.col, LEARN_CHURCH.row, z1.col, z1.row), 1,
    'Z1 must end adjacent to the church for the hero\'s melee strike');
  assert.ok(hexDistance(LEARN_ISAAC_VANTAGE.col, LEARN_ISAAC_VANTAGE.row, z2.col, z2.row) <= 3,
    'Z2 must end within bow range of Isaac\'s vantage');
});

test('learn map: the Witch makes her two-step approach into the guard trap', () => {
  const { state, witch } = buildBoard();
  assert.ok(witch, 'a Witch leader must exist for the free-play handoff');
  assert.ok(reaches(state, witch, LEARN_WITCH_APPROACH[0], 1), 'witch reaches her round-1 emergence hex');
  witch.col = LEARN_WITCH_APPROACH[0].col; witch.row = LEARN_WITCH_APPROACH[0].row;
  assert.ok(reaches(state, witch, LEARN_WITCH_APPROACH[1], 1), 'witch reaches the guard-trap hex');
  assert.equal(hexDistance(LEARN_CHURCH.col, LEARN_CHURCH.row, LEARN_WITCH_APPROACH[1].col, LEARN_WITCH_APPROACH[1].row), 1,
    'the witch\'s final hex must be adjacent to the church so the guard fires');
});

test('learn steps: action-gated steps carry a spotlight arrow and a click allowlist', () => {
  const ACTION_GATED = new Set(['action_queued', 'entity_selected']);
  for (const step of LEARN_STEPS) {
    assert.ok(step.id && step.title && step.body, `step ${step.id} needs id/title/body`);
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

test('learn steps: copy refers to the hero/leader and Isaac, never "Paladin" or "Chapel"', () => {
  for (const step of LEARN_STEPS) {
    const text = `${step.title} ${step.body}`;
    assert.ok(!/paladin/i.test(text), `step ${step.id} must not say "Paladin"`);
    assert.ok(!/chapel/i.test(text), `step ${step.id} must say "church", not "chapel"`);
  }
});

test('learn config: scripted MOVE plans use toCol/toRow (resolver field), so the enemy actually moves', () => {
  const { state, zombies } = buildBoard();
  const provider = LEARN_CONDUCTOR_CONFIG.witchPlanProvider;
  // Round 0: both zombies advance to their advance hexes.
  const r0 = provider(0, state);
  assert.equal(r0.length, zombies.length, 'round 0 should move every zombie');
  for (const a of r0) {
    assert.equal(a.type, 'move');
    assert.ok(Number.isInteger(a.toCol) && Number.isInteger(a.toRow), 'MOVE must carry toCol/toRow');
    assert.equal(a.targetCol, undefined, 'MOVE must NOT use targetCol (that is for BATTLE)');
  }
  const dests = r0.map(a => `${a.toCol},${a.toRow}`).sort();
  assert.deepEqual(dests, LEARN_ZOMBIES.map(z => `${z.advance.col},${z.advance.row}`).sort());
  // Round 2: the witch advances (MOVE toCol/toRow) and strikes (BATTLE targetCol/targetRow).
  state.hero.col = LEARN_CHURCH.col; state.hero.row = LEARN_CHURCH.row;
  const r2 = provider(2, state);
  const move = r2.find(a => a.type === 'move');
  assert.ok(move && Number.isInteger(move.toCol), 'witch MOVE must carry toCol');
  const battle = r2.find(a => a.type === 'battle-unit');
  assert.ok(battle && Number.isInteger(battle.targetCol), 'witch BATTLE must carry targetCol');
});

test('learn config: round-step map points at real steps and ends in a handoff', () => {
  const ids = new Set(LEARN_STEPS.map(s => s.id));
  for (const id of Object.values(LEARN_CONDUCTOR_CONFIG.roundStepMap)) {
    assert.ok(ids.has(id), `roundStepMap references unknown step ${id}`);
  }
  assert.ok(LEARN_STEPS.some(s => s.trigger === 'handoff'), 'a handoff step must release control to free play');
  assert.equal(LEARN_CONDUCTOR_CONFIG.maxPlanningRounds, 3);
});
