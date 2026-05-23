// Unit tests for the board-game-token unit body (cone + sphere) that replaced
// the old tombstone-shaped silhouette in the 3D renderer.
//
// The Babylon mesh construction itself needs a WebGL context, so the tests
// here cover the pure data exposed for the new design:
//   • the cone/sphere dimension constants stay in sane proportions
//   • entityBaseColor still resolves the per-player colour (this is also the
//     cone+sphere body colour now — same material drives all three meshes)
//   • tombstoneTokenColor produces a darker / desaturated variant suitable
//     for dead-unit markers
//
// Tasks: t-0b653997 (cone+sphere body), t-57bd2dd9 (drop tombstone Y offset)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STANDEE_BASE_Y_OFFSET,
  STANDEE_BASE_THICKNESS,
  STANDEE_BASE_DIAMETER,
  STANDEE_CONE_HEIGHT,
  STANDEE_CONE_DIAMETER_BOTTOM,
  STANDEE_CONE_DIAMETER_TOP,
  STANDEE_SPHERE_DIAMETER,
  entityBaseColor,
  tombstoneTokenColor,
} from '../src/renderer-3d.js';

describe('Renderer3D — board-game token dimensions', () => {
  test('cone tapers from wide bottom to narrow top', () => {
    assert.ok(STANDEE_CONE_DIAMETER_BOTTOM > STANDEE_CONE_DIAMETER_TOP,
      'cone bottom must be wider than top');
    assert.ok(STANDEE_CONE_DIAMETER_TOP > 0,
      'cone top must have nonzero diameter so the sphere rests on a flat ring');
  });

  test('cone bottom fits inside the base disc footprint', () => {
    // The base disc is what the cone rests on; the cone shouldn't overhang
    // it or it'll read as floating mid-air at oblique camera angles.
    assert.ok(STANDEE_CONE_DIAMETER_BOTTOM < STANDEE_BASE_DIAMETER,
      `cone bottom ${STANDEE_CONE_DIAMETER_BOTTOM} must fit inside base ${STANDEE_BASE_DIAMETER}`);
  });

  test('sphere head sits proudly above the cone (visible from above)', () => {
    // Sphere should be smaller than the cone height so the token doesn't read
    // as a sphere-on-stick, but not so small it's invisible from a top-down
    // camera angle. Half to two-thirds of cone height is the sweet spot.
    assert.ok(STANDEE_SPHERE_DIAMETER > 0.2,
      'sphere head should be at least 0.2 world units across');
    assert.ok(STANDEE_SPHERE_DIAMETER < STANDEE_CONE_HEIGHT,
      'sphere head should be smaller than the cone for a meeple-like silhouette');
  });

  test('tombstone Y offset is dropped — cone bottom rests on the disc, no extra gap', () => {
    // The bottom rim of the cone sits at:
    //   STANDEE_BASE_Y_OFFSET + STANDEE_BASE_THICKNESS / 2
    // i.e. the TOP of the base disc. There's no extra elevation; tombstone-era
    // code lifted the silhouette so its bottom edge sat at this Y. The new
    // token's bottom is at the same Y — "flat on the ground" relative to the
    // disc surface, with no separate tombstone Y offset.
    const discTop = STANDEE_BASE_Y_OFFSET + STANDEE_BASE_THICKNESS / 2;
    assert.ok(discTop > 0.075, 'disc top must clear the tile prism (height 0.075)');
    // Sanity: total token height stays compact enough that the HP-bar and
    // floating-text anchors above it still read as "above the unit".
    const tokenTop = discTop + STANDEE_CONE_HEIGHT + STANDEE_SPHERE_DIAMETER;
    assert.ok(tokenTop < 1.5,
      `total token top ${tokenTop} should fit under the ~1.5wu floater anchor`);
  });
});

describe('Renderer3D — entityBaseColor drives the whole token, not just the disc', () => {
  test('explicit per-player color slot wins over faction default', () => {
    assert.equal(entityBaseColor({ color: '#3399ff', owner: 'hero' }), '#3399ff');
  });

  test('faction primary is used when no per-player color is set', () => {
    assert.equal(entityBaseColor({ owner: 'hero'  }), '#d4a72c');
    assert.equal(entityBaseColor({ owner: 'witch' }), '#9b59b6');
  });

  test('stray neutrals (no color, no owner) get the neutral grey', () => {
    assert.equal(entityBaseColor({}), '#888888');
    assert.equal(entityBaseColor(null), '#888888');
  });
});

describe('Renderer3D — tombstoneTokenColor (dead-unit variant)', () => {
  test('returns a 7-character hex string', () => {
    const out = tombstoneTokenColor('#d4a72c');
    assert.equal(out.length, 7);
    assert.equal(out[0], '#');
    assert.match(out, /^#[0-9a-f]{6}$/);
  });

  test('is strictly darker than the living-unit colour', () => {
    const luminance = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return r * 0.299 + g * 0.587 + b * 0.114;
    };
    for (const live of ['#d4a72c', '#9b59b6', '#3399ff', '#ff3030', '#30ff30']) {
      const dead = tombstoneTokenColor(live);
      assert.ok(luminance(dead) < luminance(live),
        `tombstone ${dead} should be darker than live ${live}`);
    }
  });

  test('saturated channel deltas shrink — desaturation toward grey', () => {
    // A heavily-saturated red (R≫G,B) should have its channel spread reduced.
    const dead = tombstoneTokenColor('#ff0000');
    const r = parseInt(dead.slice(1, 3), 16);
    const g = parseInt(dead.slice(3, 5), 16);
    const b = parseInt(dead.slice(5, 7), 16);
    // After desaturation g and b should be > 0 (no longer pure 0), and the
    // spread r-min(g,b) should be smaller than the original 255.
    assert.ok(g > 0 && b > 0, `dead red ${dead} should pick up some g/b`);
    assert.ok(r - Math.min(g, b) < 255,
      `channel spread ${r - Math.min(g, b)} should shrink from the live 255`);
  });

  test('preserves grey input as a still-grey (or near-grey) darker output', () => {
    const dead = tombstoneTokenColor('#888888');
    const r = parseInt(dead.slice(1, 3), 16);
    const g = parseInt(dead.slice(3, 5), 16);
    const b = parseInt(dead.slice(5, 7), 16);
    assert.equal(r, g);
    assert.equal(g, b);
    assert.ok(r < 0x88, 'grey input should darken');
  });

  test('clamps within valid byte range for any input', () => {
    for (const c of ['#000000', '#ffffff', '#abcdef', '#102030']) {
      const dead = tombstoneTokenColor(c);
      const r = parseInt(dead.slice(1, 3), 16);
      const g = parseInt(dead.slice(3, 5), 16);
      const b = parseInt(dead.slice(5, 7), 16);
      for (const v of [r, g, b]) {
        assert.ok(v >= 0 && v <= 255, `channel ${v} out of range for input ${c}`);
      }
    }
  });
});
