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
  alphaForAxis,
  combatCardFrameExtent,
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

describe('framingForEntities — cardExtent (combat card-aware loosening)', () => {
  test('extends the depth span, pushing the radius out', () => {
    // A single point has zero footprint, so any card extent is the dominant
    // span and must drive the radius up off the (zero) fit.
    const positions = [{ x: 0, z: 0 }];
    const base   = framingForEntities(positions, { ...VIEW, padding: 0 }, 0);
    const carded = framingForEntities(positions, { ...VIEW, padding: 0, cardExtent: 3 }, 0);
    assert.ok(carded.radius > base.radius, 'card extent loosens the radius');
  });

  test('matches an equivalent manual depth increase', () => {
    // cardExtent C is added to the depth span; a width-dominant cluster whose
    // depth+C exceeds its width should fit exactly that depth.
    const positions = [{ x: 0, z: -1 }, { x: 0, z: 1 }]; // depth span 2
    const C = 4;
    const f = framingForEntities(positions, { ...VIEW, padding: 0, cardExtent: C }, 0);
    const expected = radiusForFit(0, 2 + C, VIEW.aspect, VIEW.fov, VIEW.margin);
    assert.ok(Math.abs(f.radius - expected) < 1e-9);
  });

  test('zero / missing cardExtent is a no-op', () => {
    const positions = [{ x: -3, z: 0 }, { x: 3, z: 0 }];
    const a = framingForEntities(positions, { ...VIEW }, 0);
    const b = framingForEntities(positions, { ...VIEW, cardExtent: 0 }, 0);
    assert.equal(a.radius, b.radius);
  });

  test('does not move the centre (symmetric loosening)', () => {
    const positions = [{ x: 1, z: 5 }, { x: 7, z: 11 }];
    const f = framingForEntities(positions, { ...VIEW, cardExtent: 3 }, 0);
    assert.equal(f.centerX, 4);
    assert.equal(f.centerZ, 8);
  });
});

describe('combatCardFrameExtent', () => {
  test('is a positive world height (head + gap + card)', () => {
    assert.ok(combatCardFrameExtent(true)  > 0);
    assert.ok(combatCardFrameExtent(false) > 0);
  });
  test('leader geometry reaches at least as high as a pawn', () => {
    assert.ok(combatCardFrameExtent(true) >= combatCardFrameExtent(false));
  });
});

describe('alphaForAxis — orient a world-XZ axis horizontal on screen', () => {
  // For an ArcRotateCamera the horizontal view direction (target→camera, in the
  // XZ plane) is ∝ (cos α, sin α). The axis reads HORIZONTAL on screen exactly
  // when it is PERPENDICULAR to that view direction.
  const perpDot = (dx, dz, alpha) => dx * Math.cos(alpha) + dz * Math.sin(alpha);

  test('returns null for a degenerate (zero-length) axis', () => {
    assert.equal(alphaForAxis(0, 0), null);
  });

  test('returns null for non-finite components', () => {
    assert.equal(alphaForAxis(NaN, 1), null);
    assert.equal(alphaForAxis(1, Infinity), null);
  });

  test('axis is perpendicular to the camera view direction', () => {
    for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [-3, 2], [5, -7], [-4, -9]]) {
      const alpha = alphaForAxis(dx, dz);
      assert.ok(Math.abs(perpDot(dx, dz, alpha)) < 1e-9,
        `axis (${dx},${dz}) should be perpendicular to view dir at alpha=${alpha}`);
    }
  });

  test('a reversed axis yields the opposite-facing alpha (π apart)', () => {
    const a = alphaForAxis(3, 4);
    const b = alphaForAxis(-3, -4);
    // Normalize the delta to (−π, π]; a reversal should leave them ±π apart.
    let d = (a - b) % (2 * Math.PI);
    if (d <= -Math.PI) d += 2 * Math.PI;
    if (d > Math.PI) d -= 2 * Math.PI;
    assert.ok(Math.abs(Math.abs(d) - Math.PI) < 1e-9, 'reversed axis flips alpha by π');
  });
});
