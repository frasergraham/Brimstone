// Unit level scaling: balance.js curve helpers, applyLevel (HP), and the
// getAttack/getDefense level composition.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  hpForLevel, atkBonusForLevel, defBonusForLevel, LEVEL_HP_PER,
} from '../src/balance.js';
import {
  createZombie, createMinion, createIronGolem, createSurvivor, applyLevel,
} from '../src/entities.js';

describe('level scaling helpers (Standard curve)', () => {
  test('hpForLevel = base × (1 + 0.25·(L−1)), rounded', () => {
    assert.equal(LEVEL_HP_PER, 0.25);
    assert.equal(hpForLevel(14, 1), 14);
    assert.equal(hpForLevel(14, 2), 18);  // round(14 × 1.25)
    assert.equal(hpForLevel(14, 3), 21);  // round(14 × 1.5)
    assert.equal(hpForLevel(21, 3), 32);  // wood golem base 21 → L3, round(21 × 1.5)
  });

  test('atkBonusForLevel = +1 per level above 1', () => {
    assert.equal(atkBonusForLevel(1), 0);
    assert.equal(atkBonusForLevel(2), 1);
    assert.equal(atkBonusForLevel(3), 2);
  });

  test('defBonusForLevel = +1 every two levels', () => {
    assert.equal(defBonusForLevel(1), 0);
    assert.equal(defBonusForLevel(2), 0);
    assert.equal(defBonusForLevel(3), 1);
    assert.equal(defBonusForLevel(5), 2);
  });

  test('helpers clamp level to ≥1', () => {
    assert.equal(hpForLevel(14, 0), 14);
    assert.equal(atkBonusForLevel(0), 0);
    assert.equal(defBonusForLevel(0), 0);
  });
});

describe('applyLevel + entity composition', () => {
  test('new entities default to level 1 with base stats', () => {
    const z = createZombie(0, 0);
    assert.equal(z.level, 1);
    assert.equal(z.maxHp, 14);
    assert.equal(z.getAttack(), 2);
    assert.equal(z.getDefense(), 0);
  });

  test('applyLevel scales HP and exposes the ATK/DEF bonus via getters', () => {
    const z = createZombie(0, 0); // base 14hp atk2 def0
    applyLevel(z, 3);
    assert.equal(z.level, 3);
    assert.equal(z.maxHp, 21);          // 14 × 1.5
    assert.equal(z.hp, 21, 'spawns at full HP');
    assert.equal(z.getAttack(), 4);     // 2 + (3−1)
    assert.equal(z.getDefense(), 1);    // 0 + floor((3−1)/2)
  });

  test('matches the documented L2/L3 table for minion + iron golem', () => {
    const m = createMinion(0, 0); // base 14hp atk1 def0
    applyLevel(m, 3);
    assert.equal(m.maxHp, 21);
    assert.equal(m.getAttack(), 3); // 1 + 2
    assert.equal(m.getDefense(), 1);

    const g = createIronGolem(0, 0); // base 35hp atk3 def2
    applyLevel(g, 2);
    assert.equal(g.maxHp, 44);       // round(35 × 1.25)
    assert.equal(g.getAttack(), 4);  // 3 + 1
    assert.equal(g.getDefense(), 2); // 2 + floor(1/2)=0
  });

  test('level bonus composes ON TOP of base stats for survivors (per-character base)', () => {
    // Survivors carry roster-specific base stats; applyLevel uses that base.
    const s = createSurvivor(0, 0);
    const baseHp = s.maxHp, baseAtk = s.getAttack(), baseDef = s.getDefense();
    applyLevel(s, 2);
    assert.equal(s.maxHp, Math.round(baseHp * 1.25));
    assert.equal(s.getAttack(), baseAtk + 1);
    assert.equal(s.getDefense(), baseDef + 0);
  });

  test('applyLevel is idempotent — re-applying does not compound HP', () => {
    const z = createZombie(0, 0);
    applyLevel(z, 3);
    const hp3 = z.maxHp;
    applyLevel(z, 3);
    assert.equal(z.maxHp, hp3, 'snapshotted L1 base prevents compounding');
    applyLevel(z, 1);
    assert.equal(z.maxHp, 14, 'back to L1 base');
  });

  test('displayName carries NO level suffix at any level (pill replaces it)', () => {
    const z = createZombie(0, 0);
    assert.equal(z.displayName, 'Zombie');
    applyLevel(z, 2);
    // The old "Zombie L2" suffix is gone — the level is now a separate signal
    // (z.level) rendered as a pill badge by the visual call sites.
    assert.equal(z.displayName, 'Zombie', 'no L-suffix baked into the name');
    assert.equal(z.baseName, 'Zombie', 'baseName is the plain name alias');
    assert.equal(z.level, 2, 'level is exposed as a structured field');
    applyLevel(z, 3);
    assert.equal(z.displayName, 'Zombie', 'still no suffix at L3');
    assert.equal(z.level, 3);
  });
});
