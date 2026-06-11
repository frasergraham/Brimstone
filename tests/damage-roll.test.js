// Unit tests for the weapon-damage roller (normalizeDamage / rollDamage) and
// the per-weapon damage table lookup (getWeaponDamage).
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeDamage, rollDamage } from '../src/entities.js';
import { getWeaponDamage } from '../src/items.js';
import { DEFAULT_ATTACK_DAMAGE } from '../src/balance.js';

describe('normalizeDamage', () => {
  test('a plain number becomes a flat spec', () => {
    assert.deepEqual(normalizeDamage(5), { count: 0, sides: 0, flat: 5 });
  });

  test('an object spec is normalized with defaults', () => {
    assert.deepEqual(normalizeDamage({ count: 2, sides: 6 }), { count: 2, sides: 6, flat: 0 });
    assert.deepEqual(normalizeDamage({ count: 1, sides: 12, flat: 1 }), { count: 1, sides: 12, flat: 1 });
  });

  test('null/undefined degrade to a 1-damage floor via rollDamage', () => {
    assert.deepEqual(normalizeDamage(undefined), { count: 0, sides: 0, flat: 0 });
  });
});

describe('rollDamage', () => {
  // Deterministic roll fn: always returns the max face.
  const maxRoll = (sides) => sides;
  // Deterministic roll fn: always returns 1.
  const minRoll = () => 1;

  test('fixed damage ignores dice', () => {
    assert.equal(rollDamage(7, maxRoll), 7);
    assert.equal(rollDamage({ count: 0, sides: 0, flat: 4 }, maxRoll), 4);
  });

  test('dice roll sums count × roll + flat', () => {
    assert.equal(rollDamage({ count: 2, sides: 6 }, maxRoll), 12);   // 6+6
    assert.equal(rollDamage({ count: 2, sides: 6 }, minRoll), 2);    // 1+1
    assert.equal(rollDamage({ count: 1, sides: 12, flat: 1 }, maxRoll), 13); // 12+1
  });

  test('result is bounded by the dice range', () => {
    const spec = { count: 2, sides: 6, flat: 0 };
    for (let i = 0; i < 200; i++) {
      const d = rollDamage(spec, (s) => Math.ceil(Math.random() * s));
      assert.ok(d >= 2 && d <= 12, `2D6 should be in [2,12], got ${d}`);
    }
  });

  test('never drops below 1', () => {
    assert.equal(rollDamage(0, minRoll), 1);
    assert.equal(rollDamage({ count: 0, sides: 0, flat: -5 }, minRoll), 1);
  });
});

describe('getWeaponDamage', () => {
  test('unarmed / unknown falls back to DEFAULT_ATTACK_DAMAGE (2D6)', () => {
    assert.equal(getWeaponDamage(null), DEFAULT_ATTACK_DAMAGE);
    assert.equal(getWeaponDamage('not-a-weapon'), DEFAULT_ATTACK_DAMAGE);
    assert.deepEqual(DEFAULT_ATTACK_DAMAGE, { count: 2, sides: 6, flat: 0 });
  });

  test('known weapons return their own dice spec', () => {
    assert.deepEqual(getWeaponDamage('sword'),  { count: 2, sides: 6 });
    assert.deepEqual(getWeaponDamage('musket'), { count: 2, sides: 8 });
    assert.deepEqual(getWeaponDamage('axe'),    { count: 1, sides: 12, flat: 1 });
  });

  test('premium-tier weapons carry their heavier dice specs', () => {
    assert.deepEqual(getWeaponDamage('greatsword'), { count: 3, sides: 6 });            // 3D6
    assert.deepEqual(getWeaponDamage('warhammer'),  { count: 1, sides: 12, flat: 4 });  // 1D12+4
    assert.deepEqual(getWeaponDamage('longrifle'),  { count: 2, sides: 8, flat: 2 });   // 2D8+2
  });
});
