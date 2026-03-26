// Tests for isBattleSignificant (exported from src/main.js)
// and related speed-mode classification logic.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isBattleSignificant } from '../src/battle-utils.js';
import { EntityType } from '../src/entities.js';

function snap(type, owner) {
  return { type, owner, name: type, col: 0, row: 0 };
}

// ── Hero / Witch involvement ───────────────────────────────────────────────

describe('isBattleSignificant — hero/witch combatant', () => {
  test('hero as attacker → significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.HERO, 'hero'), snap(EntityType.MINION, 'witch'), {}, null),
      true,
    );
  });

  test('witch as attacker → significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.WITCH, 'witch'), snap(EntityType.SURVIVOR, 'hero'), {}, null),
      true,
    );
  });

  test('hero as defender → significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.MINION, 'witch'), snap(EntityType.HERO, 'hero'), {}, null),
      true,
    );
  });

  test('witch as defender → significant', () => {
    assert.equal(
      isBattleSignificant(snap(EntityType.ZOMBIE, 'witch'), snap(EntityType.WITCH, 'witch'), {}, null),
      true,
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
        { killed: true },
        null,
      ),
      true,
    );
  });

  test('zombie vs minion, no kill → not significant when no human faction', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.ZOMBIE, 'witch'),
        snap(EntityType.MINION, 'witch'),
        { killed: false },
        null,
      ),
      false,
    );
  });
});

// ── Human faction defender ─────────────────────────────────────────────────

describe('isBattleSignificant — human faction defender', () => {
  test("enemy attacks human's survivor → significant", () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.ZOMBIE, 'witch'),
        snap(EntityType.SURVIVOR, 'hero'),
        { killed: false },
        'hero',
      ),
      true,
    );
  });

  test("human attacks enemy minion → not significant (attacker is human but not hero/witch)", () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.SURVIVOR, 'hero'),
        snap(EntityType.MINION, 'witch'),
        { killed: false },
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
        { killed: false },
        null,
      ),
      false,
    );
  });

  test('wood golem vs survivor, no kill, attacking human faction → significant', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.WOOD_GOLEM, 'witch'),
        snap(EntityType.SURVIVOR, 'hero'),
        { killed: false },
        'hero',
      ),
      true,
    );
  });

  test('iron golem vs iron golem, no kill, no human faction → not significant', () => {
    assert.equal(
      isBattleSignificant(
        snap(EntityType.IRON_GOLEM, 'witch'),
        snap(EntityType.IRON_GOLEM, 'hero'),
        { killed: false },
        null,
      ),
      false,
    );
  });

  test('null/undefined result → only type/faction criteria apply', () => {
    // No result.killed but hero is involved → still significant
    assert.equal(
      isBattleSignificant(snap(EntityType.HERO, 'hero'), snap(EntityType.MINION, 'witch'), null, null),
      true,
    );
    // No result at all, minor units → not significant
    assert.equal(
      isBattleSignificant(snap(EntityType.SURVIVOR, 'hero'), snap(EntityType.ZOMBIE, 'witch'), null, null),
      false,
    );
  });
});
