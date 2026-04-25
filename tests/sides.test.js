// Tests for the Side abstraction (src/sides.js).
//
// Sides are the level at which the day/night phase cycle, scoring, and
// team allocation operate. Each Faction belongs to exactly one Side.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Side,
  allSides,
  getSideMeta,
  sideName,
  getOpposingSide,
  isFavorablePhaseForSide,
} from '../src/sides.js';
import { Phase } from '../src/game.js';

// ── Enum ────────────────────────────────────────────────────────────────────

describe('Side enum', () => {
  test('exposes day and night ids', () => {
    assert.equal(Side.DAY, 'day');
    assert.equal(Side.NIGHT, 'night');
  });

  test('is frozen', () => {
    assert.throws(() => { Side.NEW = 'new'; }, /Cannot|read only|extensible/);
  });
});

// ── Registry helpers ───────────────────────────────────────────────────────

describe('Side registry', () => {
  test('allSides returns day and night in that order', () => {
    assert.deepEqual(allSides(), ['day', 'night']);
  });

  test('getSideMeta returns metadata for known sides', () => {
    const day = getSideMeta('day');
    assert.ok(day);
    assert.equal(day.id, 'day');
    assert.equal(day.name, 'Day');
  });

  test('getSideMeta returns null for unknown side', () => {
    assert.equal(getSideMeta('twilight'), null);
  });

  test('sideName returns display name', () => {
    assert.equal(sideName('day'),   'Day');
    assert.equal(sideName('night'), 'Night');
  });

  test('sideName falls back to the id for unknown sides', () => {
    assert.equal(sideName('twilight'), 'twilight');
  });
});

// ── Opposing side ──────────────────────────────────────────────────────────

describe('getOpposingSide', () => {
  test('day opposes night', () => {
    assert.equal(getOpposingSide('day'),   'night');
    assert.equal(getOpposingSide('night'), 'day');
  });

  test('throws on unknown side', () => {
    assert.throws(() => getOpposingSide('twilight'), /Unknown side/);
  });
});

// ── Phase favourability ────────────────────────────────────────────────────

describe('isFavorablePhaseForSide', () => {
  test('day side is favoured at dawn and day', () => {
    assert.equal(isFavorablePhaseForSide('day', Phase.DAWN), true);
    assert.equal(isFavorablePhaseForSide('day', Phase.DAY),  true);
    assert.equal(isFavorablePhaseForSide('day', Phase.DUSK), false);
    assert.equal(isFavorablePhaseForSide('day', Phase.NIGHT),false);
  });

  test('night side is favoured only at night', () => {
    assert.equal(isFavorablePhaseForSide('night', Phase.NIGHT),true);
    assert.equal(isFavorablePhaseForSide('night', Phase.DAY),  false);
    assert.equal(isFavorablePhaseForSide('night', Phase.DAWN), false);
    assert.equal(isFavorablePhaseForSide('night', Phase.DUSK), false);
  });

  test('returns false for unknown side', () => {
    assert.equal(isFavorablePhaseForSide('twilight', Phase.DAY), false);
  });
});
