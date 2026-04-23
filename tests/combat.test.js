// Unit coverage for the advantage/disadvantage dice-pool math.
//
// resolveCombat builds separate attack and defense dice pools. Each side's net
// advantage = (advantage sources) − (disadvantage sources). Positive net rolls
// 1+net d6 and picks the highest; negative rolls 1+|net| d6 and picks the
// lowest; zero rolls a single d6. Total per side capped at ADVANTAGE_CAP (4).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Entity, createHero, createWitch, createMinion,
  ADVANTAGE_CAP, BEST_OF_K_EV, WORST_OF_K_EV, expectedDieValue,
} from '../src/entities.js';

function withRNG(sequence, fn) {
  let idx = 0;
  const orig = Math.random;
  Math.random = () => sequence[idx++ % sequence.length];
  try { return fn(); }
  finally { Math.random = orig; }
}

// Math.ceil(x * 6): 0.001→1, 0.5→3, 0.999→6

describe('advantage dice pool', () => {
  test('neutral (no advantage) rolls a single d6 per side', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    const r = withRNG([0.5, 0.5], () => Entity.resolveCombat(hero, witch));
    assert.equal(r.atkPool.length, 1);
    assert.equal(r.defPool.length, 1);
    assert.equal(r.atkAdvantage, 0);
    assert.equal(r.defAdvantage, 0);
  });

  test('advantage 2 picks the highest of three dice', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    // atk pool: [1, 1, 6] → picks 6; def pool: [3]
    const r = withRNG([0.001, 0.001, 0.999, 0.5],
      () => Entity.resolveCombat(hero, witch, { atkAdvantageDice: 2 }));
    assert.equal(r.atkPool.length, 3);
    assert.equal(r.atkBaseDie, 6);
    assert.equal(r.atkAdvantage, 2);
  });

  test('disadvantage 2 picks the lowest of three dice', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    // def pool: [6, 6, 1] → picks 1 (disadvantage) via defAdvantageDice negated
    const r = withRNG([0.5, 0.999, 0.999, 0.001],
      () => Entity.resolveCombat(hero, witch, { defDisadvantageDice: 2 }));
    assert.equal(r.defPool.length, 3);
    assert.equal(r.defBaseDie, 1);
    assert.equal(r.defAdvantage, -2);
  });
});

describe('net advantage/disadvantage', () => {
  test('advantage 2 + disadvantage 1 nets to advantage 1 (pool of 2)', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    const r = withRNG([0.001, 0.999, 0.5],
      () => Entity.resolveCombat(hero, witch,
        { atkAdvantageDice: 2, atkDisadvantageDice: 1 }));
    assert.equal(r.atkAdvantage, 1);
    assert.equal(r.atkPool.length, 2);
    assert.equal(r.atkBaseDie, 6);
  });

  test('advantage and disadvantage cancel to plain d6', () => {
    const hero = createHero(0, 0);
    const minion = createMinion(0, 0);
    const r = withRNG([0.5, 0.5],
      () => Entity.resolveCombat(hero, minion,
        { atkAdvantageDice: 2, atkDisadvantageDice: 2 }));
    assert.equal(r.atkAdvantage, 0);
    assert.equal(r.atkPool.length, 1);
  });
});

describe('advantage cap', () => {
  test(`cap is ${ADVANTAGE_CAP} total dice per side`, () => {
    assert.equal(ADVANTAGE_CAP, 4);
  });

  test('sources beyond the cap do not grow the pool', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    // 8 advantage sources → clamped to 4 → pool of 5
    const r = withRNG(Array(9).fill(0.5),
      () => Entity.resolveCombat(hero, witch,
        { atkAdvantageDice: 8 }));
    assert.equal(r.atkAdvantage, ADVANTAGE_CAP);
    assert.equal(r.atkPool.length, 1 + ADVANTAGE_CAP);
  });
});

describe('expected value lookup', () => {
  test('BEST_OF_K_EV covers advantage K ∈ {0,1,2,3,4}', () => {
    assert.equal(BEST_OF_K_EV.length, 5);
    assert.equal(WORST_OF_K_EV.length, 5);
    assert.equal(BEST_OF_K_EV[0], 3.5);
    assert.equal(WORST_OF_K_EV[0], 3.5);
    // Symmetry: E[best-of-K] + E[worst-of-K] = 7 for any K
    for (let k = 0; k <= 4; k++) {
      assert.ok(Math.abs(BEST_OF_K_EV[k] + WORST_OF_K_EV[k] - 7) < 1e-4,
        `K=${k}: best + worst should equal 7, got ${BEST_OF_K_EV[k] + WORST_OF_K_EV[k]}`);
    }
  });

  test('expectedDieValue returns correct lookup for each net advantage', () => {
    assert.equal(expectedDieValue(0), 3.5);
    assert.equal(expectedDieValue(1), BEST_OF_K_EV[1]);
    assert.equal(expectedDieValue(4), BEST_OF_K_EV[4]);
    assert.equal(expectedDieValue(-1), WORST_OF_K_EV[1]);
    assert.equal(expectedDieValue(-4), WORST_OF_K_EV[4]);
  });

  test('expectedDieValue clamps beyond the cap', () => {
    assert.equal(expectedDieValue(10), BEST_OF_K_EV[ADVANTAGE_CAP]);
    assert.equal(expectedDieValue(-10), WORST_OF_K_EV[ADVANTAGE_CAP]);
  });

  test('Monte-Carlo best-of-(1+K) matches the lookup within 0.05', () => {
    // Quick sanity check that the lookup values actually match d6 statistics.
    const N = 20000;
    for (let k = 1; k <= 4; k++) {
      const pool = 1 + k;
      let sum = 0;
      for (let i = 0; i < N; i++) {
        let best = 0;
        for (let j = 0; j < pool; j++) {
          const d = 1 + Math.floor(Math.random() * 6);
          if (d > best) best = d;
        }
        sum += best;
      }
      const mean = sum / N;
      assert.ok(Math.abs(mean - BEST_OF_K_EV[k]) < 0.05,
        `K=${k}: MC mean ${mean.toFixed(3)} vs lookup ${BEST_OF_K_EV[k]}`);
    }
  });
});
