// Round 4 3D-renderer polish: glow include-only mode, smaller waypoint
// markers + dashed path lines, hex-outline movement highlights, fog
// readability bump, mobile gesture swap, UI portrait/tile data URLs. Tests
// lock down the pure helpers + tuning constants — Babylon mesh wiring is
// exercised by hand in-browser.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  // item 3
  PLAN_MARKER_DIAMETER,
  PLAN_MARKER_HEIGHT,
  PLAN_MARKER_Y,
  PLAN_LINE_Y,
  PLAN_DISC_Y,
  // item 4
  hexOutlinePaths,
  HIGHLIGHT_OUTER_R,
  HIGHLIGHT_INNER_R,
  HIGHLIGHT_DISC_Y,
  HIGHLIGHT_DEFAULT_RGBA,
  HEX_RADIUS_WORLD,
  ROAD_RIBBON_Y,
  RIVER_RIBBON_Y,
  // item 5
  FOG_TILE_DARKEN,
  // item 9
  _terrainThumbSpriteId,
  hexToWorld,
  parseRgba01,
} from '../src/renderer-3d.js';

// ── Item 3: smaller waypoint markers + dashed path connector ─────────────────

describe('Renderer3D round-4 polish — waypoint marker geometry', () => {
  test('marker diameter much smaller than the hex footprint (≤ 0.5 world units)', () => {
    assert.ok(PLAN_MARKER_DIAMETER > 0 && PLAN_MARKER_DIAMETER <= 0.5,
      `PLAN_MARKER_DIAMETER ${PLAN_MARKER_DIAMETER} should be a small puck`);
  });

  test('marker height stays very flat (≤ 0.05)', () => {
    assert.ok(PLAN_MARKER_HEIGHT > 0 && PLAN_MARKER_HEIGHT <= 0.05,
      `PLAN_MARKER_HEIGHT ${PLAN_MARKER_HEIGHT} should hug the tile`);
  });

  test('marker Y is above the tile top (0.075) and below the legacy PLAN_DISC_Y', () => {
    assert.ok(PLAN_MARKER_Y > 0.075,
      `PLAN_MARKER_Y ${PLAN_MARKER_Y} must clear tile top`);
    assert.ok(PLAN_MARKER_Y < PLAN_DISC_Y,
      `PLAN_MARKER_Y ${PLAN_MARKER_Y} should sit below the legacy disc layer`);
  });

  test('path-connector line sits above the marker puck so the dashes read on top', () => {
    assert.ok(PLAN_LINE_Y > PLAN_MARKER_Y,
      `PLAN_LINE_Y ${PLAN_LINE_Y} must be above PLAN_MARKER_Y ${PLAN_MARKER_Y}`);
  });
});

// ── Item 4: hex-outline movement highlights ─────────────────────────────────

describe('Renderer3D round-4 polish — hexOutlinePaths', () => {
  test('returns 7 outer + 7 inner points (last == first to close the loop)', () => {
    const { outer, inner } = hexOutlinePaths(0, 0);
    assert.equal(outer.length, 7);
    assert.equal(inner.length, 7);
    // Trig produces tiny FP drift at i=6 (cos/sin of 2π vs 0); compare with
    // an epsilon rather than deep-equal.
    const closeEnough = (a, b) => Math.abs(a.x - b.x) < 1e-9
      && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;
    assert.ok(closeEnough(outer[0], outer[6]), 'outer loop should close back on itself');
    assert.ok(closeEnough(inner[0], inner[6]), 'inner loop should close back on itself');
  });

  test('all outer points lie at outerR, all inner at innerR, from the hex centre', () => {
    const { outer, inner } = hexOutlinePaths(2, 3);
    const { x: cx, z: cz } = hexToWorld(2, 3);
    for (const p of outer.slice(0, 6)) {
      const r = Math.hypot(p.x - cx, p.z - cz);
      assert.ok(Math.abs(r - HIGHLIGHT_OUTER_R) < 1e-6,
        `outer point radius ${r} != HIGHLIGHT_OUTER_R ${HIGHLIGHT_OUTER_R}`);
    }
    for (const p of inner.slice(0, 6)) {
      const r = Math.hypot(p.x - cx, p.z - cz);
      assert.ok(Math.abs(r - HIGHLIGHT_INNER_R) < 1e-6,
        `inner point radius ${r} != HIGHLIGHT_INNER_R ${HIGHLIGHT_INNER_R}`);
    }
  });

  test('all points share the requested Y plane', () => {
    const { outer, inner } = hexOutlinePaths(0, 0, 0.95, 0.78, 0.42);
    for (const p of [...outer, ...inner]) assert.equal(p.y, 0.42);
  });

  test('inner radius is smaller than outer (defining a visible ring width)', () => {
    assert.ok(HIGHLIGHT_INNER_R < HIGHLIGHT_OUTER_R,
      `inner ${HIGHLIGHT_INNER_R} must be < outer ${HIGHLIGHT_OUTER_R}`);
  });

  test('outer radius fits inside the hex footprint (≤ HEX_RADIUS_WORLD)', () => {
    assert.ok(HIGHLIGHT_OUTER_R <= HEX_RADIUS_WORLD,
      `outer ${HIGHLIGHT_OUTER_R} should not exceed the hex's own radius`);
  });

  test('default highlight rgba parses cleanly and has high alpha (≥ 0.7) post-round-4', () => {
    const [, , , a] = parseRgba01(HIGHLIGHT_DEFAULT_RGBA);
    assert.ok(a >= 0.7,
      `default rgba alpha ${a} should be high enough to render the outline ring`);
  });

  test('outline Y matches HIGHLIGHT_DISC_Y so the ring sits above the tile prism top', () => {
    const { outer } = hexOutlinePaths(0, 0);
    assert.equal(outer[0].y, HIGHLIGHT_DISC_Y);
  });

  test('highlight Y sits ABOVE road and river ribbons so the outline is not occluded by a road tile', () => {
    assert.ok(HIGHLIGHT_DISC_Y > ROAD_RIBBON_Y,
      `HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y} must clear ROAD_RIBBON_Y ${ROAD_RIBBON_Y}`);
    assert.ok(HIGHLIGHT_DISC_Y > RIVER_RIBBON_Y,
      `HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y} must clear RIVER_RIBBON_Y ${RIVER_RIBBON_Y}`);
  });

  test('highlight Y sits BELOW plan disc and plan-line layers so plan overlay still reads on top', () => {
    assert.ok(HIGHLIGHT_DISC_Y < PLAN_DISC_Y,
      `HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y} must be below PLAN_DISC_Y ${PLAN_DISC_Y}`);
    assert.ok(HIGHLIGHT_DISC_Y < PLAN_LINE_Y,
      `HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y} must be below PLAN_LINE_Y ${PLAN_LINE_Y}`);
  });
});

// ── Item 5: fog readability bump ─────────────────────────────────────────────

describe('Renderer3D round-4 polish — FOG_TILE_DARKEN', () => {
  test('fog darken factor leaves terrain visibly fogged against the daytime sun', () => {
    // After the daytime lighting bump (sun cranked to 2.0 intensity, hemi
    // dropped to 0.3), fog needs a stronger tint to read against the bright
    // backdrop. Anywhere in (0, 0.4] keeps unfogged tiles legible while
    // clearly signalling "this hex is out of sight."
    assert.ok(FOG_TILE_DARKEN > 0 && FOG_TILE_DARKEN <= 0.4,
      `FOG_TILE_DARKEN ${FOG_TILE_DARKEN} out of expected band (0, 0.4]`);
  });
});

// ── Item 9: UI portrait/terrain thumbnail helpers ───────────────────────────

describe('Renderer3D round-4 polish — _terrainThumbSpriteId', () => {
  test('returns null for unsupported tile types', () => {
    assert.equal(_terrainThumbSpriteId(null, 0, 0), null);
    assert.equal(_terrainThumbSpriteId({ type: 'unknown_type' }, 0, 0), null);
  });

  test('grass maps to a grass variant', () => {
    const id = _terrainThumbSpriteId({ type: 'grass' }, 0, 0);
    assert.ok(/^grass_[1-5]$/.test(id), `unexpected id ${id}`);
  });

  test('forest maps to a forest variant', () => {
    const id = _terrainThumbSpriteId({ type: 'forest' }, 1, 2);
    assert.ok(/^forest_[1-5]$/.test(id), `unexpected id ${id}`);
  });

  test('dirt maps to a dirt variant', () => {
    const id = _terrainThumbSpriteId({ type: 'dirt' }, 1, 2);
    assert.ok(/^dirt_[1-5]$/.test(id), `unexpected id ${id}`);
  });

  test('road/river/bridge collapse to grass variants', () => {
    for (const t of ['road', 'river', 'bridge']) {
      const id = _terrainThumbSpriteId({ type: t }, 4, 5);
      assert.ok(/^grass_[1-5]$/.test(id), `${t} → unexpected id ${id}`);
    }
  });

  test('building tiles fall back to dirt variants (the building sprite is layered on top)', () => {
    const id = _terrainThumbSpriteId({ type: 'building', building: 'inn' }, 4, 5);
    assert.ok(/^dirt_[1-5]$/.test(id), `building → unexpected id ${id}`);
  });

  test('variant choice is stable per (col, row) — same input yields same output', () => {
    const a = _terrainThumbSpriteId({ type: 'grass' }, 7, 9);
    const b = _terrainThumbSpriteId({ type: 'grass' }, 7, 9);
    assert.equal(a, b);
  });

  test('different (col, row) can yield different variants (sanity check on hashing)', () => {
    const variants = new Set();
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 5; r++) {
        variants.add(_terrainThumbSpriteId({ type: 'grass' }, c, r));
      }
    }
    assert.ok(variants.size > 1,
      `hash should produce more than one variant across (0..5, 0..5); got ${[...variants]}`);
  });
});
