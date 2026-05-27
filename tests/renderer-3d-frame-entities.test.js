// Unit tests for the entity-framing camera math (`framingForEntities`) and the
// ENTITY_FRAME_PADDING constant added for the reusable `frameEntities` camera
// mechanism (combat G4 + dialog will both call it).
//
// All tests are pure (no Babylon, no DOM, no WebGL) — they exercise the
// centroid + fit-radius + max-zoom-clamp helper directly.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  framingForEntities,
  radiusForFit,
  ENTITY_FRAME_PADDING,
} from '../src/renderer-3d.js';

const VIEW = { aspect: 16 / 9, fov: 0.8, margin: 1.05, padding: 0 };

describe('framingForEntities — degenerate input', () => {
  test('returns null for empty / nullish input', () => {
    assert.equal(framingForEntities([], VIEW, 4), null);
    assert.equal(framingForEntities(null, VIEW, 4), null);
    assert.equal(framingForEntities(undefined, VIEW, 4), null);
  });

  test('returns null when no position is finite', () => {
    assert.equal(
      framingForEntities([{ x: NaN, z: 1 }, { x: 2, z: Infinity }], VIEW, 4),
      null,
    );
  });

  test('skips non-finite entries but still frames the finite ones', () => {
    const f = framingForEntities(
      [{ x: NaN, z: 0 }, { x: 0, z: 0 }, { x: 10, z: 0 }],
      VIEW, 0,
    );
    assert.equal(f.centerX, 5);
    assert.equal(f.centerZ, 0);
  });
});

describe('framingForEntities — centroid (bounding-box centre)', () => {
  test('single entity centres on its anchor', () => {
    const f = framingForEntities([{ x: 7, z: -3 }], VIEW, 4);
    assert.equal(f.centerX, 7);
    assert.equal(f.centerZ, -3);
  });

  test('two entities centre on their midpoint', () => {
    const f = framingForEntities([{ x: 0, z: 0 }, { x: 4, z: 8 }], VIEW, 0);
    assert.equal(f.centerX, 2);
    assert.equal(f.centerZ, 4);
  });

  test('uses bounds centre (not weighted mean) for asymmetric clusters', () => {
    // Three points clustered near x=0 and one far out at x=12 → mean ≈ 3,
    // bounds centre = 6. The fit must centre on 6 so all four fit.
    const f = framingForEntities(
      [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 12, z: 0 }],
      VIEW, 0,
    );
    assert.equal(f.centerX, 6);
  });
});

describe('framingForEntities — radius & max-zoom clamp', () => {
  test('single entity clamps to the max-zoom (lowerRadiusLimit) floor', () => {
    // A point has zero span; with no padding the fit radius is ~0, so the
    // result must floor at maxZoomRadius — i.e. the closest allowed zoom.
    const f = framingForEntities([{ x: 0, z: 0 }], { ...VIEW, padding: 0 }, 9);
    assert.equal(f.radius, 9);
  });

  test('wide cluster overrides the floor with the true fit radius', () => {
    // A 40-unit-wide span needs a much larger radius than the 4-unit floor.
    const positions = [{ x: -20, z: 0 }, { x: 20, z: 0 }];
    const f = framingForEntities(positions, VIEW, 4);
    const expected = radiusForFit(40, 0, VIEW.aspect, VIEW.fov, VIEW.margin);
    assert.ok(f.radius > 4, 'fit radius should exceed the floor');
    assert.ok(Math.abs(f.radius - expected) < 1e-9);
  });

  test('padding widens the fit and pushes the radius out', () => {
    const tight = framingForEntities([{ x: 0, z: 0 }, { x: 2, z: 0 }], { ...VIEW, padding: 0 }, 0);
    const padded = framingForEntities([{ x: 0, z: 0 }, { x: 2, z: 0 }], { ...VIEW, padding: 3 }, 0);
    assert.ok(padded.radius > tight.radius);
  });

  test('depth-dominant cluster fits its depth', () => {
    const f = framingForEntities([{ x: 0, z: -15 }, { x: 0, z: 15 }], VIEW, 0);
    const expected = radiusForFit(0, 30, VIEW.aspect, VIEW.fov, VIEW.margin);
    assert.ok(Math.abs(f.radius - expected) < 1e-9);
  });

  test('defaults fill in for a missing viewport', () => {
    // No viewport → aspect 16/9, fov 0.8, margin 1.05, padding 0.
    const f = framingForEntities([{ x: -5, z: 0 }, { x: 5, z: 0 }], undefined, 0);
    const expected = radiusForFit(10, 0, 16 / 9, 0.8, 1.05);
    assert.ok(Math.abs(f.radius - expected) < 1e-9);
  });
});

describe('ENTITY_FRAME_PADDING', () => {
  test('is a small positive world-unit slack (~1 hex)', () => {
    assert.ok(ENTITY_FRAME_PADDING > 0);
    assert.ok(ENTITY_FRAME_PADDING <= 3);
  });
});
