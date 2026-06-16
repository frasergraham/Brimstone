// Building ground labels — pure-helper tests for `groundLabelPlacement`,
// the snap-to-most-horizontal-hex-edge math that drives the name rects
// painted on each building's entrance hex. The Babylon mesh wiring
// (DynamicTexture plane, `_pumpBuildingGroundLabels` walk) is exercised
// in-browser; this file locks the geometry that drives it.
//
// Conventions under test (pointy-top hexes, world XZ angles via atan2(z, x)):
//  - hex corners sit at π/6 + j·π/3, so edge-parallel READING directions are
//    the angle set π/6 + k·π/3 (six candidates — each edge line twice, ±).
//  - camera ground-right = forward rotated −90° = (fz, −fx); the candidate
//    with the max dot against it is the most horizontal on screen and reads
//    left-to-right.
//  - mesh yaw for a plane pitched flat with rotation.x = π/2 is −dirAngle.
//  - the label hugs the near-camera edge: offset along −(dir + 90°).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groundLabelPlacement,
  GROUND_LABEL_WIDTH,
  GROUND_LABEL_HEIGHT,
  GROUND_LABEL_EDGE_INSET,
} from '../src/building-render.js';

const DEG = Math.PI / 180;
// Forward vector whose ground-right lands exactly at `rightAngle`:
// right = fwd − 90° ⇒ fwd = right + 90°.
const fwdForRight = (rightAngle) => ({
  x: Math.cos(rightAngle + Math.PI / 2),
  z: Math.sin(rightAngle + Math.PI / 2),
});
const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≉ ${b}`);

describe('groundLabelPlacement — edge-direction snapping', () => {
  test('camera-right exactly on a candidate direction snaps to it', () => {
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + k * (Math.PI / 3);
      const f = fwdForRight(a);
      const p = groundLabelPlacement(f.x, f.z);
      approx(p.dirAngle, a, `candidate k=${k}`);
    }
  });

  test('camera-right between candidates snaps to the nearest one', () => {
    // 80° is 10° from the 90° candidate, 50° from 30° — expect 90°.
    let p = groundLabelPlacement(...Object.values(fwdForRight(80 * DEG)));
    approx(p.dirAngle, 90 * DEG, 'right at 80° → 90° edge');
    // 100° is 10° from 90° — still 90°.
    p = groundLabelPlacement(...Object.values(fwdForRight(100 * DEG)));
    approx(p.dirAngle, 90 * DEG, 'right at 100° → 90° edge');
    // 125° is 5° from 120°? No — candidates are 30/90/150…; 125° is 25° from
    // 150° and 35° from 90° — expect 150°.
    p = groundLabelPlacement(...Object.values(fwdForRight(125 * DEG)));
    approx(p.dirAngle, 150 * DEG, 'right at 125° → 150° edge');
  });

  test('opposite camera headings pick opposite reading directions (no upside-down text)', () => {
    const f1 = fwdForRight(90 * DEG);
    const f2 = fwdForRight(270 * DEG);
    const p1 = groundLabelPlacement(f1.x, f1.z);
    const p2 = groundLabelPlacement(f2.x, f2.z);
    approx(p1.dirAngle, 90 * DEG, 'right at 90°');
    approx(p2.dirAngle, 270 * DEG, 'right at 270° — the 180° twin, not the same edge line');
  });

  test('yaw is the negated reading direction (Babylon rotation.y convention)', () => {
    for (const deg of [10, 95, 170, 200, 290, 355]) {
      const f = fwdForRight(deg * DEG);
      const p = groundLabelPlacement(f.x, f.z);
      approx(p.yaw, -p.dirAngle, `right at ${deg}°`);
    }
  });

  test('forward magnitude is irrelevant — only the heading matters', () => {
    const f = fwdForRight(40 * DEG);
    const small = groundLabelPlacement(f.x * 1e-3, f.z * 1e-3);
    const big   = groundLabelPlacement(f.x * 1e4,  f.z * 1e4);
    approx(small.dirAngle, big.dirAngle, 'scaled forwards agree');
    approx(small.offsetX,  big.offsetX,  'offsets agree (x)');
    approx(small.offsetZ,  big.offsetZ,  'offsets agree (z)');
  });

  test('degenerate zero-length forward returns null', () => {
    assert.equal(groundLabelPlacement(0, 0), null);
  });
});

describe('groundLabelPlacement — edge-hugging offset', () => {
  test('offset magnitude equals the edge inset and is perpendicular to the reading direction', () => {
    for (const deg of [0, 33, 91, 187, 260, 340]) {
      const f = fwdForRight(deg * DEG);
      const p = groundLabelPlacement(f.x, f.z);
      approx(Math.hypot(p.offsetX, p.offsetZ), GROUND_LABEL_EDGE_INSET,
        `|offset| at ${deg}°`);
      const dot = p.offsetX * Math.cos(p.dirAngle) + p.offsetZ * Math.sin(p.dirAngle);
      approx(dot, 0, `offset ⊥ reading dir at ${deg}°`);
    }
  });

  test('offset points toward the camera (screen-bottom edge of the hex)', () => {
    for (const deg of [5, 60, 130, 222, 301]) {
      const f = fwdForRight(deg * DEG);
      const p = groundLabelPlacement(f.x, f.z);
      // Toward-camera ground direction = −forward; the offset must have a
      // positive component along it (i.e. negative along forward).
      const along = p.offsetX * f.x + p.offsetZ * f.z;
      assert.ok(along < 0,
        `right at ${deg}°: offset·fwd = ${along} should be negative (label hugs the near edge)`);
    }
  });

  test('custom edge inset is honoured', () => {
    const f = fwdForRight(90 * DEG);
    const p = groundLabelPlacement(f.x, f.z, 0.3);
    approx(Math.hypot(p.offsetX, p.offsetZ), 0.3, 'custom inset');
  });
});

describe('ground-label geometry constants — sanity', () => {
  test('the offset rect stays inside the hex (inset + half-height < inradius)', () => {
    const inradius = Math.sqrt(3) / 2; // corner radius 1.0 (HEX_RADIUS_WORLD)
    assert.ok(GROUND_LABEL_EDGE_INSET + GROUND_LABEL_HEIGHT / 2 < inradius,
      `inset ${GROUND_LABEL_EDGE_INSET} + h/2 ${GROUND_LABEL_HEIGHT / 2} must stay under inradius ${inradius}`);
  });

  test('the rect width fits across the hex with margin', () => {
    // Widest usable span parallel to an edge, at the edge, is the edge length
    // (1.0); nearer the centre it approaches the full √3 width. Keep the rect
    // under the inradius-axis width so corners never clip.
    assert.ok(GROUND_LABEL_WIDTH < Math.sqrt(3),
      `width ${GROUND_LABEL_WIDTH} must fit inside the hex (√3 across flats)`);
  });
});
