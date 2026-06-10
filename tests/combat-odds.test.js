// Tests for the combat odds preview:
//   - Entity.computeCombatOdds matches Entity.resolveCombat EXACTLY, proven
//     by enumerating every possible dice combination via forced dice
//   - probabilities are coherent (hit+miss=1, crush⊆hit, counter⊆miss)
//   - the advantage cap applies to odds just like to live rolls
//   - actions.computeCombatOdds reflects the live battle context
//     (gang-up, fortification, ranged rules) without mutating state

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Entity, createHero, createWitch, createMinion, ADVANTAGE_CAP } from '../src/entities.js';
import { computeCombatOdds, computeBattleContext } from '../src/actions.js';
import { hexKey } from '../src/hex.js';
import { Phase } from '../src/game.js';
import { TileType } from '../src/tiles.js';

const EPS = 1e-9;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTinyState(phase = Phase.DAY) {
  const state = {
    phase,
    entities: [],
    tiles: new Map(),
    exploredHexes: { hero: new Set(), witch: new Set() },
    fogOfWar: 'none',
    inventory: { hero: {}, witch: {} },
  };
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      state.tiles.set(hexKey(col, row), {
        col, row, type: TileType.GRASS, building: null, fortifyLevel: 0, explored: true,
      });
    }
  }
  return state;
}

/**
 * Enumerate every dice combination for the pools implied by `options`,
 * resolve each via Entity.resolveCombat with forced dice, and accumulate
 * exact outcome probabilities using executeBattle's outcome rules.
 */
function enumerateOutcomes(attacker, defender, options, ranged = false) {
  // Derive pool sizes the same way resolveCombat does.
  const { atkNet, defNet } = Entity._combatNets(attacker, defender, options);
  const ka = 1 + Math.abs(atkNet);
  const kd = 1 + Math.abs(defNet);
  const n  = ka + kd;
  const total = Math.pow(6, n);

  let hit = 0, crush = 0, counter = 0;
  const dice = new Array(n).fill(1);
  for (let i = 0; i < total; i++) {
    // Decode i as a base-6 dice vector
    let x = i;
    for (let d = 0; d < n; d++) { dice[d] = (x % 6) + 1; x = Math.floor(x / 6); }

    const fakeState = {
      queue: [...dice],
      nextDie() { return this.queue.shift(); },
    };
    const r = Entity.resolveCombat(attacker, defender, { ...options, state: fakeState });
    if (r.hit) {
      hit++;
      if (!ranged && r.attackRoll >= 2 * r.defenseRoll) crush++;
    } else if (!ranged && r.defenseRoll >= 2 * r.attackRoll) {
      counter++;
    }
  }
  return { hit: hit / total, crush: crush / total, counter: counter / total };
}

function assertOddsMatch(odds, expected, label) {
  assert.ok(Math.abs(odds.hit - expected.hit) < EPS,
    `${label}: hit ${odds.hit} != enumerated ${expected.hit}`);
  assert.ok(Math.abs(odds.crush - expected.crush) < EPS,
    `${label}: crush ${odds.crush} != enumerated ${expected.crush}`);
  assert.ok(Math.abs(odds.counter - expected.counter) < EPS,
    `${label}: counter ${odds.counter} != enumerated ${expected.counter}`);
}

// ── Entity.computeCombatOdds — exact parity with resolveCombat ───────────────

describe('Entity.computeCombatOdds exact enumeration parity', () => {
  const scenarios = [
    { label: 'plain melee, no modifiers', options: {} },
    { label: 'gang-up +2 advantage with flat bonus',
      options: { atkAdvantageDice: 2, extraAtkBonus: 2 } },
    { label: 'defender advantage + fortification',
      options: { defAdvantageDice: 1, extraDefBonus: 2 } },
    { label: 'attacker disadvantage (point-blank ranged)',
      options: { atkDisadvantageDice: 1 }, ranged: true },
    { label: 'fatigued defender',
      options: { fatiguePenalty: 2 } },
    { label: 'both sides modified',
      options: { atkAdvantageDice: 1, defAdvantageDice: 2, extraAtkBonus: 1, extraDefBonus: 1 } },
  ];

  for (const { label, options, ranged = false } of scenarios) {
    test(label, () => {
      const hero  = createHero(3, 3, null);
      const minion = createMinion(3, 4, null);
      const enumerated = enumerateOutcomes(hero, minion, options, ranged);
      const odds = Entity.computeCombatOdds(hero, minion, { ...options, ranged });
      assertOddsMatch(odds, enumerated, label);
    });
  }

  test('probabilities are coherent', () => {
    const hero = createHero(3, 3, null);
    const witch = createWitch(3, 4, null);
    const odds = Entity.computeCombatOdds(hero, witch, { atkAdvantageDice: 1 });
    assert.ok(Math.abs(odds.hit + odds.miss - 1) < EPS, 'hit + miss must equal 1');
    assert.ok(odds.crush <= odds.hit + EPS, 'crush is a subset of hit');
    assert.ok(odds.counter <= odds.miss + EPS, 'counter is a subset of miss');
    for (const v of Object.values(odds)) assert.ok(v >= -EPS && v <= 1 + EPS);
  });

  test('advantage cap applies to odds', () => {
    const hero = createHero(3, 3, null);
    const minion = createMinion(3, 4, null);
    const capped = Entity.computeCombatOdds(hero, minion, { atkAdvantageDice: ADVANTAGE_CAP });
    const over   = Entity.computeCombatOdds(hero, minion, { atkAdvantageDice: ADVANTAGE_CAP + 5 });
    assert.deepEqual(over, capped, 'advantage beyond the cap must not change odds');
  });

  test('ranged flag removes crush and counter outcomes', () => {
    const hero = createHero(3, 3, null);
    const minion = createMinion(3, 4, null);
    const odds = Entity.computeCombatOdds(hero, minion, { ranged: true });
    assert.equal(odds.crush, 0);
    assert.equal(odds.counter, 0);
  });
});

// ── actions.computeCombatOdds — situational context integration ─────────────

describe('actions.computeCombatOdds battle context', () => {
  test('matches Entity odds fed with computeBattleContext options', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, null);
    const minion = createMinion(3, 4, null);
    state.entities.push(hero, minion);

    const ctx = computeBattleContext(state, hero, minion);
    const expected = Entity.computeCombatOdds(hero, minion,
      { ...ctx.combatOptions, ranged: ctx.isRanged });
    assert.deepEqual(computeCombatOdds(state, hero, minion), expected);
  });

  test('gang-up ally increases hit odds', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, null);
    const minion = createMinion(3, 4, null);
    state.entities.push(hero, minion);
    const solo = computeCombatOdds(state, hero, minion);

    const ally = createHero(2, 4, null);  // adjacent to the target
    state.entities.push(ally);
    const ganged = computeCombatOdds(state, hero, minion);
    assert.ok(ganged.hit > solo.hit,
      `gang-up should raise hit odds (${solo.hit} → ${ganged.hit})`);
  });

  test('defender fortification lowers hit odds for hero defenders', () => {
    const state = makeTinyState();
    const witch = createWitch(3, 3, null);
    const hero = createHero(3, 4, null);
    state.entities.push(witch, hero);
    const open = computeCombatOdds(state, witch, hero);

    state.tiles.get(hexKey(3, 4)).fortifyLevel = 3;
    const fortified = computeCombatOdds(state, witch, hero);
    assert.ok(fortified.hit < open.hit,
      `fortification should lower hit odds (${open.hit} → ${fortified.hit})`);
  });

  test('ranged attack has no crush or counter and ignores gang-up', () => {
    const state = makeTinyState();
    const hero = createHero(3, 1, null);
    hero.equipWeapon('bow');
    const minion = createMinion(3, 4, null);
    const ally = createHero(2, 4, null);  // adjacent to target — melee-only bonus
    state.entities.push(hero, minion, ally);

    const odds = computeCombatOdds(state, hero, minion);
    assert.equal(odds.crush, 0, 'ranged attacks cannot crush');
    assert.equal(odds.counter, 0, 'ranged attacks cannot be countered');

    const ctx = computeBattleContext(state, hero, minion);
    assert.equal(ctx.atkAdvantageDice, 0, 'ranged ignores attacker gang-up');
    assert.equal(ctx.atkGangupFlat, 0, 'ranged ignores attacker gang-up flat');
  });

  test('does not mutate state or entities', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, null);
    const minion = createMinion(3, 4, null);
    state.entities.push(hero, minion);
    const heroBefore = JSON.stringify(hero);
    const minionBefore = JSON.stringify(minion);
    const countBefore = state.entities.length;

    computeCombatOdds(state, hero, minion);

    assert.equal(JSON.stringify(hero), heroBefore, 'attacker must be untouched');
    assert.equal(JSON.stringify(minion), minionBefore, 'defender must be untouched');
    assert.equal(state.entities.length, countBefore);
  });
});
