// Phase 3 of the 3D renderer — pure-helper unit tests for the entity layer.
//
// The Babylon-touching parts (mesh creation, material binding, picking,
// camera-target animation) require a WebGL context and are not tested here.
// What we *can* lock down without a browser:
//   • standee world position is the tile centre at the documented Y offset
//   • base disc colour falls back through owner.color → faction → neutral
//   • the diff bucket (add/keep/remove) handles arrivals, deaths, and
//     position-only moves consistently
//
// These three things together cover the public contract Phase 3 exposes to
// callers: where does a unit *render*, what *colour* identifies it, and how
// does the renderer *react* to entities entering and leaving state.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEX_RADIUS_WORLD,
  hexToWorld,
  STANDEE_BASE_Y_OFFSET,
  entityStandeeWorldPosition,
  entityBaseColor,
  diffStandees,
} from '../src/renderer-3d.js';

describe('Renderer3D — entity standee world position', () => {
  test('origin tile yields a standee at world (0, baseY, 0)', () => {
    const p = entityStandeeWorldPosition(0, 0);
    assert.equal(p.x, 0);
    assert.equal(p.z, 0);
    assert.equal(p.y, STANDEE_BASE_Y_OFFSET);
  });

  test('standee X/Z match the tile centre exactly (no horizontal offset)', () => {
    const cells = [[3, 4], [7, 2], [10, 11], [0, 5]];
    for (const [col, row] of cells) {
      const tile = hexToWorld(col, row);
      const ent  = entityStandeeWorldPosition(col, row);
      assert.ok(Math.abs(tile.x - ent.x) < 1e-9, `x mismatch at (${col},${row})`);
      assert.ok(Math.abs(tile.z - ent.z) < 1e-9, `z mismatch at (${col},${row})`);
    }
  });

  test('Y offset clears the tile prism (height 0.15) so picking prefers the base', () => {
    // Tile prism is centred at y=0 with height 0.15 → top at y=0.075.
    // The base disc must sit strictly above that to win ray-pick precedence.
    assert.ok(STANDEE_BASE_Y_OFFSET > 0.075,
      `STANDEE_BASE_Y_OFFSET ${STANDEE_BASE_Y_OFFSET} must be > 0.075`);
  });

  test('respects a non-unit hex radius', () => {
    const p = entityStandeeWorldPosition(1, 0, 2);
    const t = hexToWorld(1, 0, 2);
    assert.ok(Math.abs(p.x - t.x) < 1e-9);
    assert.ok(Math.abs(p.z - t.z) < 1e-9);
    // Radius parameter does not change the Y offset (lives in world units
    // tied to the tile-prism height, which is also unit-radius scaled).
    assert.equal(p.y, STANDEE_BASE_Y_OFFSET);
    assert.equal(HEX_RADIUS_WORLD, 1);
  });
});

describe('Renderer3D — entityBaseColor (base disc owner palette)', () => {
  test('prefers the entity.color field (per-player slot colour)', () => {
    assert.equal(entityBaseColor({ color: '#abcdef', owner: 'witch' }), '#abcdef');
    assert.equal(entityBaseColor({ color: '#f07020', owner: 'hero'  }), '#f07020');
  });

  test('falls back to faction primary when no explicit color', () => {
    // Same hex values used by FACTION_THEME.{hero,witch}.primary in src/theme.js.
    assert.equal(entityBaseColor({ owner: 'hero'  }), '#d4a72c');
    assert.equal(entityBaseColor({ owner: 'witch' }), '#9b59b6');
  });

  test('neutral entities (no owner) get the neutral grey', () => {
    assert.equal(entityBaseColor({}), '#888888');
    assert.equal(entityBaseColor({ owner: null }), '#888888');
    assert.equal(entityBaseColor(null), '#888888');
  });
});

describe('Renderer3D — diffStandees', () => {
  test('classifies new entities as add, dropped ones as remove', () => {
    const existing = new Set(['e1', 'e2', 'e3']);
    const entities = [
      { id: 'e2', alive: true, col: 0, row: 0 },
      { id: 'e3', alive: true, col: 1, row: 1 },
      { id: 'e4', alive: true, col: 2, row: 2 },
    ];
    const { add, keep, remove } = diffStandees(existing, entities);
    assert.deepEqual([...add].sort(),    ['e4']);
    assert.deepEqual([...keep].sort(),   ['e2', 'e3']);
    assert.deepEqual([...remove].sort(), ['e1']);
  });

  test('dead entities are treated as removals', () => {
    const existing = new Set(['e1', 'e2']);
    const entities = [
      { id: 'e1', alive: false, col: 0, row: 0 },
      { id: 'e2', alive: true,  col: 0, row: 0 },
    ];
    const { add, keep, remove } = diffStandees(existing, entities);
    assert.deepEqual([...add],    []);
    assert.deepEqual([...keep],   ['e2']);
    assert.deepEqual([...remove], ['e1']);
  });

  test('entities missing col/row are skipped (defensive)', () => {
    const { add, keep, remove } = diffStandees(new Set(), [
      { id: 'e1', alive: true },             // no col/row
      { id: 'e2', alive: true, col: 1 },     // no row
      { id: 'e3', alive: true, col: 0, row: 0 },
    ]);
    assert.deepEqual([...add],    ['e3']);
    assert.deepEqual([...keep],   []);
    assert.deepEqual([...remove], []);
  });

  test('empty inputs produce empty buckets', () => {
    const { add, keep, remove } = diffStandees(new Set(), []);
    assert.deepEqual([...add],    []);
    assert.deepEqual([...keep],   []);
    assert.deepEqual([...remove], []);
  });

  test('accepts an array (not Set) for existing ids', () => {
    const { add, keep, remove } = diffStandees(['e1'], [
      { id: 'e1', alive: true, col: 0, row: 0 },
      { id: 'e2', alive: true, col: 1, row: 0 },
    ]);
    assert.deepEqual([...add],    ['e2']);
    assert.deepEqual([...keep],   ['e1']);
    assert.deepEqual([...remove], []);
  });
});
