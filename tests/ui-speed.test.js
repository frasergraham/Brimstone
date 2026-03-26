// Tests for isBattleSignificant (exported from src/battle-utils.js)
// and related speed-mode classification logic.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isBattleSignificant } from '../src/battle-utils.js';
import { EntityType } from '../src/entities.js';

function snap(type, owner) {
  return { type, owner, name: type, col: 0, row: 0 };
}

// ── Hero / Witch with damage ───────────────────────────────────────────────

describe('isBattleSignificant — hero/witch combatant with damage', () => {
  test('hero attacks and deals damage → significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.HERO, 'hero'), snap(EntityType.MINION, 'witch'), { damage: 1 }, null),
      true,
    );
  });

  test('witch attacks and deals damage → significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.WITCH, 'witch'), snap(EntityType.SURVIVOR, 'hero'), { damage: 2 }, null),
      true,
    );
  });

  test('hero as defender takes damage → significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.MINION, 'witch'), snap(EntityType.HERO, 'hero'), { damage: 1 }, null),
      true,
    );
  });

  test('counter damage on witch attacker → significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.WITCH, 'witch'), snap(EntityType.SURVIVOR, 'hero'), { damage: 0, counterDmg: 1 }, null),
      true,
    );
  });
});

// ── Hero / Witch with no damage (misses) ──────────────────────────────────

describe('isBattleSignificant — hero/witch combatant, no damage', () => {
  test('hero attacks but misses → NOT significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.HERO, 'hero'), snap(EntityType.MINION, 'witch'), { damage: 0, counterDmg: 0 }, null),
      false,
    );
  });

  test('witch attacks but misses → NOT significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.WITCH, 'witch'), snap(EntityType.SURVIVOR, 'hero'), { damage: 0, counterDmg: 0 }, null),
      false,
    );
  });

  test('minion attacks hero but misses → NOT significant (hero takes no damage)', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.MINION, 'witch'), snap(EntityType.HERO, 'hero'), { damage: 0, counterDmg: 0 }, null),
      false,
    );
  });
});

// ── Kill outcome ───────────────────────────────────────────────────────────

describe('isBattleSignificant — kill outcome', () => {
  test('minion kills survivor → significant', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.MINION, 'witch'),
        snap(EntityType.SURVIVOR, 'hero'),
        { killed: true, damage: 2 },
        null,
      ),
      true,
    );
  });

  test('kill flag alone is sufficient even with zero explicit damage field', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.ZOMBIE, 'witch'),
        snap(EntityType.MINION, 'witch'),
        { killed: true },
        null,
      ),
      true,
    );
  });

  test('zombie vs minion, no kill, no damage → not significant', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.ZOMBIE, 'witch'),
        snap(EntityType.MINION, 'witch'),
        { killed: false, damage: 0, counterDmg: 0 },
        null,
      ),
      false,
    );
  });
});

// ── Human faction defender ─────────────────────────────────────────────────

describe('isBattleSignificant — human faction defender', () => {
  test("enemy attacks human's survivor (miss) → significant", () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.ZOMBIE, 'witch'),
        snap(EntityType.SURVIVOR, 'hero'),
        { killed: false, damage: 0, counterDmg: 0 },
        'hero',
      ),
      true,
    );
  });

  test("human's survivor attacks enemy minion (miss) → not significant", () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.SURVIVOR, 'hero'),
        snap(EntityType.MINION, 'witch'),
        { killed: false, damage: 0, counterDmg: 0 },
        'hero',
      ),
      false,
    );
  });
});

// ── Cannon-fodder skirmishes ───────────────────────────────────────────────

describe('isBattleSignificant — minor skirmishes', () => {
  test('minion vs zombie, no kill, null humanFaction → not significant', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.MINION, 'witch'),
        snap(EntityType.ZOMBIE, 'witch'),
        { killed: false, damage: 0, counterDmg: 0 },
        null,
      ),
      false,
    );
  });

  test('wood golem vs survivor, damage dealt, attacking human faction → significant', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.WOOD_GOLEM, 'witch'),
        snap(EntityType.SURVIVOR, 'hero'),
        { killed: false, damage: 1 },
        'hero',
      ),
      true,
    );
  });

  test('iron golem vs iron golem, no kill, no damage, no human faction → not significant', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.IRON_GOLEM, 'witch'),
        snap(EntityType.IRON_GOLEM, 'hero'),
        { killed: false, damage: 0, counterDmg: 0 },
        null,
      ),
      false,
    );
  });

  test('null result → only kill/faction criteria apply (no damage assumed)', () => {
    // Hero involved but null result → no damage known → not significant
    assert.equal(
      isBattleSignificant(snap(EntityType.HERO, 'hero'), snap(EntityType.MINION, 'witch'), null, null),
      false,
    );
    // Minor units, null result → not significant
    assert.equal(
      isBattleSignificant(snap(EntityType.SURVIVOR, 'hero'), snap(EntityType.ZOMBIE, 'witch'), null, null),
      false,
    );
  });
});
