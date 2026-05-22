// Movement-highlight overlay tuning: ring sits comfortably above road tubes,
// applied alpha lands in the translucent band, deepened RGB stays darker than
// the source. Pure helpers + constants only — Babylon mesh wiring is exercised
// by hand in-browser.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HIGHLIGHT_DISC_Y,
  HIGHLIGHT_OVERLAY_ALPHA,
  HIGHLIGHT_MIN_ALPHA,
  HIGHLIGHT_DEEPEN_FACTOR,
  HIGHLIGHT_DEFAULT_RGBA,
  PLAN_DISC_Y,
  PLAN_LINE_Y,
  ROAD_RIBBON_Y,
  RIVER_RIBBON_Y,
  parseRgba01,
  deepenHighlight01,
  hexOutlinePaths,
} from '../src/renderer-3d.js';

// ── Ring sits well above road / river / node-ring geometry ───────────────────

describe('Renderer3D highlight overlay — Y ordering with margin', () => {
  // Apparent road-network apex: ROAD_RIBBON_Y is the ribbon plane, and the
  // tallest road-style tube in the scene is the power-node ring at Y=0.03
  // radius 0.06 → apex ≈ 0.09. Highlight must clear that with margin so the
  // ring is never occluded at any tilt under the locked 45° camera.
  const ROAD_NETWORK_APEX = 0.09;

  test('HIGHLIGHT_DISC_Y clears road network apex with ≥0.05 margin', () => {
    const margin = HIGHLIGHT_DISC_Y - ROAD_NETWORK_APEX;
    assert.ok(margin >= 0.05,
      `HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y} needs ≥0.05 margin above road apex ${ROAD_NETWORK_APEX}, got ${margin}`);
  });

  test('HIGHLIGHT_DISC_Y still clears the flat road and river ribbon planes', () => {
    assert.ok(HIGHLIGHT_DISC_Y > ROAD_RIBBON_Y);
    assert.ok(HIGHLIGHT_DISC_Y > RIVER_RIBBON_Y);
  });

  test('HIGHLIGHT_DISC_Y stays strictly below PLAN_DISC_Y and PLAN_LINE_Y', () => {
    assert.ok(HIGHLIGHT_DISC_Y < PLAN_DISC_Y,
      `HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y} must remain below PLAN_DISC_Y ${PLAN_DISC_Y}`);
    assert.ok(HIGHLIGHT_DISC_Y < PLAN_LINE_Y,
      `HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y} must remain below PLAN_LINE_Y ${PLAN_LINE_Y}`);
  });

  test('hexOutlinePaths places vertices at HIGHLIGHT_DISC_Y by default', () => {
    const { outer, inner } = hexOutlinePaths(0, 0);
    for (const p of outer) assert.equal(p.y, HIGHLIGHT_DISC_Y);
    for (const p of inner) assert.equal(p.y, HIGHLIGHT_DISC_Y);
  });
});

// ── Applied alpha is a fixed translucent overlay ─────────────────────────────

describe('Renderer3D highlight overlay — applied alpha', () => {
  test('HIGHLIGHT_OVERLAY_ALPHA reads as translucent overlay, not solid sticker', () => {
    assert.ok(HIGHLIGHT_OVERLAY_ALPHA >= 0.6 && HIGHLIGHT_OVERLAY_ALPHA <= 0.7,
      `HIGHLIGHT_OVERLAY_ALPHA ${HIGHLIGHT_OVERLAY_ALPHA} out of overlay band [0.6, 0.7]`);
  });

  test('HIGHLIGHT_MIN_ALPHA aliases the overlay alpha (semantics changed)', () => {
    assert.equal(HIGHLIGHT_MIN_ALPHA, HIGHLIGHT_OVERLAY_ALPHA);
  });
});

// ── Deepened colours look darker than the source ─────────────────────────────

describe('Renderer3D highlight overlay — deepenHighlight01', () => {
  test('scales each RGB channel by HIGHLIGHT_DEEPEN_FACTOR', () => {
    const [r, g, b] = deepenHighlight01([0.5, 0.8, 0.2, 1]);
    assert.ok(Math.abs(r - 0.5 * HIGHLIGHT_DEEPEN_FACTOR) < 1e-9);
    assert.ok(Math.abs(g - 0.8 * HIGHLIGHT_DEEPEN_FACTOR) < 1e-9);
    assert.ok(Math.abs(b - 0.2 * HIGHLIGHT_DEEPEN_FACTOR) < 1e-9);
  });

  test('passes alpha through unchanged (alpha is set at the material layer)', () => {
    const [, , , a] = deepenHighlight01([1, 1, 1, 0.42]);
    assert.equal(a, 0.42);
  });

  test('default movement-green becomes visibly darker than the source', () => {
    const src   = parseRgba01(HIGHLIGHT_DEFAULT_RGBA);
    const deep  = deepenHighlight01(src);
    // At least 20% lightness reduction on the dominant green channel — keeps
    // the overlay looking saturated/dark rather than pastel.
    assert.ok(deep[1] <= src[1] * 0.8,
      `deepened green ${deep[1]} should be ≤ 80% of source green ${src[1]}`);
  });

  test('clamps RGB into [0, 1] (no negatives, no overflow)', () => {
    const out = deepenHighlight01([2, -1, 0.5, 1]);
    assert.ok(out[0] >= 0 && out[0] <= 1);
    assert.ok(out[1] >= 0 && out[1] <= 1);
    assert.ok(out[2] >= 0 && out[2] <= 1);
  });

  test('falls back to opaque black for malformed input rather than throwing', () => {
    assert.deepEqual(deepenHighlight01(null),       [0, 0, 0, 1]);
    assert.deepEqual(deepenHighlight01([]),         [0, 0, 0, 1]);
    assert.deepEqual(deepenHighlight01([0.1, 0.2]), [0, 0, 0, 1]);
  });

  test('HIGHLIGHT_DEEPEN_FACTOR is in the 20–30% darken band the operator asked for', () => {
    assert.ok(HIGHLIGHT_DEEPEN_FACTOR >= 0.7 && HIGHLIGHT_DEEPEN_FACTOR <= 0.8,
      `HIGHLIGHT_DEEPEN_FACTOR ${HIGHLIGHT_DEEPEN_FACTOR} out of [0.7, 0.8]`);
  });
});
