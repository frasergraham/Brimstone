// Pure-helper tests for the 3D renderer's tile top-face texture path
// (see "Tile top-face textures" banner in src/renderer-3d.js).
//
// We don't instantiate the renderer here — Babylon needs a WebGL context that
// node-test doesn't have. These tests cover the pure mapping from a tile to
// the sprite id used for its textured top, plus the constants the renderer's
// material cache is keyed on.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TERRAIN_VARIANT_COUNTS,
  TERRAIN_DISC_RADIUS_MUL,
  TERRAIN_DISC_Y_OFFSET,
  terrainSpriteIdFor,
} from '../src/renderer-3d.js';
import { TileType } from '../src/tiles.js';

describe('Renderer3D — terrainSpriteIdFor', () => {
  test('grass tile picks a grass_N variant', () => {
    const id = terrainSpriteIdFor({ type: TileType.GRASS }, 0, 0);
    assert.match(id, /^grass_[1-5]$/);
  });

  test('forest tile picks a forest_N variant', () => {
    const id = terrainSpriteIdFor({ type: TileType.FOREST }, 1, 2);
    assert.match(id, /^forest_[1-5]$/);
  });

  test('dirt tile picks a dirt_N variant', () => {
    const id = terrainSpriteIdFor({ type: TileType.DIRT }, 3, 4);
    assert.match(id, /^dirt_[1-5]$/);
  });

  test('building tile uses a dirt base variant (matches 2D renderer)', () => {
    const id = terrainSpriteIdFor({ type: TileType.BUILDING, building: 'inn' }, 5, 6);
    assert.match(id, /^dirt_[1-5]$/);
  });

  test('road / river / bridge tiles use a grass underlay sprite', () => {
    // Item 2: ROAD/RIVER/BRIDGE tiles render with grass underneath; the
    // bezier network tube provides the path visual on top. Top-disc texture
    // therefore needs to be a grass variant so the underlay reads correctly.
    assert.match(terrainSpriteIdFor({ type: TileType.ROAD   }, 0, 0), /^grass_[1-5]$/);
    assert.match(terrainSpriteIdFor({ type: TileType.RIVER  }, 0, 0), /^grass_[1-5]$/);
    assert.match(terrainSpriteIdFor({ type: TileType.BRIDGE }, 0, 0), /^grass_[1-5]$/);
  });

  test('unknown tile type returns null', () => {
    assert.equal(terrainSpriteIdFor({ type: 'lava' }, 0, 0), null);
  });

  test('null / undefined tile returns null safely', () => {
    assert.equal(terrainSpriteIdFor(null, 0, 0), null);
    assert.equal(terrainSpriteIdFor(undefined, 0, 0), null);
  });

  test('same hex deterministically picks the same variant across calls', () => {
    const a = terrainSpriteIdFor({ type: TileType.GRASS }, 7, 11);
    const b = terrainSpriteIdFor({ type: TileType.GRASS }, 7, 11);
    assert.equal(a, b);
  });

  test('different hexes vary across the variant pool', () => {
    const ids = new Set();
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < 6; r++) {
        ids.add(terrainSpriteIdFor({ type: TileType.GRASS }, c, r));
      }
    }
    // A pool of 5 variants should produce more than one distinct id across
    // 36 hexes — otherwise the hash collapsed to a single bucket.
    assert.ok(ids.size > 1, `expected >1 distinct variants, got ${ids.size}`);
  });

  test('negative coordinates do not throw or return out-of-range ids', () => {
    // The hash includes col*row, which can go negative; the result must still
    // be one of grass_1..grass_5 — never grass_0 or grass_-1.
    for (let c = -3; c <= 0; c++) {
      for (let r = -3; r <= 0; r++) {
        const id = terrainSpriteIdFor({ type: TileType.GRASS }, c, r);
        assert.match(id, /^grass_[1-5]$/, `bad id at (${c},${r}): ${id}`);
      }
    }
  });
});

describe('Renderer3D — material-cache key uniqueness', () => {
  // The renderer keys its terrain material cache by sprite id alone (one
  // material per textured variant, shared across every tile that picks it).
  // We verify the key-distinction property the cache relies on without
  // exercising the actual Babylon material constructor.
  test('two tiles of the same terrain & coords resolve to the same id', () => {
    const a = terrainSpriteIdFor({ type: TileType.GRASS }, 4, 7);
    const b = terrainSpriteIdFor({ type: TileType.GRASS }, 4, 7);
    assert.equal(a, b);
  });

  test('different terrains never collide on sprite id', () => {
    const ids = new Set();
    for (const t of [TileType.GRASS, TileType.FOREST, TileType.DIRT]) {
      for (let c = 0; c < 5; c++) {
        for (let r = 0; r < 5; r++) {
          const id = terrainSpriteIdFor({ type: t }, c, r);
          if (id) ids.add(id);
        }
      }
    }
    // Every id begins with its terrain name — no cross-terrain reuse.
    for (const id of ids) {
      assert.ok(
        id.startsWith('grass_') || id.startsWith('forest_') || id.startsWith('dirt_'),
        `unexpected id ${id}`,
      );
    }
  });

  test('null sprite-id is the renderer signal for "use solid colour fallback"', () => {
    // _terrainMaterialFor(null) returns null in the renderer; that is the
    // explicit fallback gate. Item 2 made road/river/bridge return a grass
    // sprite (so the underlay matches the surrounding terrain), so the only
    // null cases left are tiles with unrecognised types — locked here.
    assert.equal(terrainSpriteIdFor({ type: 'mystery' }, 0, 0), null);
    assert.equal(terrainSpriteIdFor(null,                 0, 0), null);
  });
});

describe('Renderer3D — texture-disc geometry constants', () => {
  test('disc radius multiplier matches the cylinder hex edge', () => {
    // 1.0 means the disc's hex corners land exactly on the cylinder's hex
    // corners — chosen for clean visual alignment with no overhang. A future
    // tweak away from 1.0 should be a deliberate decision, not an accident.
    assert.equal(TERRAIN_DISC_RADIUS_MUL, 1.0);
  });

  test('disc Y offset sits just above the cylinder top to win the depth fight', () => {
    // Cylinder has height 0.15 centred at y=0, so its top face is at y=0.075.
    // The textured disc must sit above that — but only by a tiny margin so it
    // doesn't read as floating. Anything between 0.0751 and ~0.08 is fine.
    assert.ok(TERRAIN_DISC_Y_OFFSET > 0.075, `disc Y ${TERRAIN_DISC_Y_OFFSET} must be > cylinder top 0.075`);
    assert.ok(TERRAIN_DISC_Y_OFFSET < 0.09,  `disc Y ${TERRAIN_DISC_Y_OFFSET} must be < road deck Y 0.09`);
  });

  test('variant counts cover only multi-variant terrains', () => {
    assert.equal(TERRAIN_VARIANT_COUNTS.grass,  5);
    assert.equal(TERRAIN_VARIANT_COUNTS.forest, 5);
    assert.equal(TERRAIN_VARIANT_COUNTS.dirt,   5);
    // road/river/bridge intentionally absent — they're not textured at all.
    assert.equal(TERRAIN_VARIANT_COUNTS.road,   undefined);
    assert.equal(TERRAIN_VARIANT_COUNTS.river,  undefined);
    assert.equal(TERRAIN_VARIANT_COUNTS.bridge, undefined);
  });
});
