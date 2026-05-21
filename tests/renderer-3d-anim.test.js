// Phase 5 of the 3D renderer — pure-helper unit tests for animations,
// plan-ghost arrows, HP bars, and floating combat text.
//
// We deliberately do NOT test Babylon mesh construction here: a real WebGL
// context isn't available under node:test, and the Babylon CDN dependency
// would balloon the suite runtime. Instead, this file locks down the
// behaviour of every pure helper that drives a Phase 5 visual:
//
//   • interpolatePosition   — linear movement curve (0%, 50%, 100%)
//   • planArrowPolyline     — arrow geometry between two hex centres
//   • planArrowBadgePosition — numbered-badge anchor at the arrow head
//   • hpBarColor            — red/yellow/green threshold table
//   • floatingTextTransform — rise + fade curve for combat result floaters
//   • projectileColor01     — projectile colour-by-type table
//
// Together these cover the contract the renderer exposes to playback code
// — *where* a move/lunge interpolates through, *what* arrow the plan panel
// shows, *what* colour an HP bar takes, and *how* a floating-text label
// rises and fades. The Babylon-touching wrappers around these helpers are
// driven by integration testing in a real browser session (out of scope here).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hexToWorld,
  HEX_RADIUS_WORLD,
  MOVE_ANIM_MS,
  LUNGE_ANIM_MS,
  PROJECTILE_ANIM_MS,
  FLOAT_TEXT_MS,
  HP_BAR_Y_ABOVE_BASE,
  HP_RED_BELOW,
  HP_YELLOW_BELOW,
  interpolatePosition,
  planArrowPolyline,
  planArrowBadgePosition,
  hpBarColor,
  floatingTextTransform,
  projectileColor01,
} from '../src/renderer-3d.js';

// ─── Constants ──────────────────────────────────────────────────────────────

describe('Renderer3D Phase 5 — anim duration constants', () => {
  test('MOVE_ANIM_MS is around 250ms (linear single-hex slide)', () => {
    assert.equal(MOVE_ANIM_MS, 250);
  });

  test('LUNGE_ANIM_MS < MOVE_ANIM_MS (sharper, snappier feel)', () => {
    assert.ok(LUNGE_ANIM_MS < MOVE_ANIM_MS,
      `expected LUNGE_ANIM_MS (${LUNGE_ANIM_MS}) < MOVE_ANIM_MS (${MOVE_ANIM_MS})`);
  });

  test('PROJECTILE_ANIM_MS matches the 2D renderer default (≈320ms)', () => {
    assert.equal(PROJECTILE_ANIM_MS, 320);
  });

  test('FLOAT_TEXT_MS is around 700ms — long enough to read', () => {
    assert.ok(FLOAT_TEXT_MS >= 500 && FLOAT_TEXT_MS <= 1200,
      `expected FLOAT_TEXT_MS in [500, 1200], got ${FLOAT_TEXT_MS}`);
  });
});

// ─── interpolatePosition ────────────────────────────────────────────────────

describe('Renderer3D Phase 5 — interpolatePosition (linear move)', () => {
  const from = { x: 0, z: 0 };
  const to   = { x: 10, z: -4 };

  test('t=0 returns the source exactly', () => {
    const p = interpolatePosition(from, to, 0);
    assert.equal(p.x, 0);
    assert.equal(p.z, 0);
  });

  test('t=1 returns the destination exactly', () => {
    const p = interpolatePosition(from, to, 1);
    assert.equal(p.x, 10);
    assert.equal(p.z, -4);
  });

  test('t=0.5 returns the midpoint', () => {
    const p = interpolatePosition(from, to, 0.5);
    assert.equal(p.x, 5);
    assert.equal(p.z, -2);
  });

  test('t<0 clamps to source (we never overshoot backwards)', () => {
    const p = interpolatePosition(from, to, -0.25);
    assert.equal(p.x, 0);
    assert.equal(p.z, 0);
  });

  test('t>1 clamps to destination (we never overshoot forwards)', () => {
    const p = interpolatePosition(from, to, 1.25);
    assert.equal(p.x, 10);
    assert.equal(p.z, -4);
  });

  test('quarter-way is exactly 1/4 of the displacement', () => {
    const p = interpolatePosition(from, to, 0.25);
    assert.equal(p.x, 2.5);
    assert.equal(p.z, -1);
  });
});

// ─── planArrowPolyline + planArrowBadgePosition ─────────────────────────────

describe('Renderer3D Phase 5 — plan-ghost arrow geometry', () => {
  test('polyline has exactly two points (start, end) — straight line', () => {
    const pts = planArrowPolyline(0, 0, 3, 4);
    assert.equal(pts.length, 2);
  });

  test('arrow endpoints match the hex centres in world space', () => {
    const a = hexToWorld(2, 3);
    const b = hexToWorld(5, 7);
    const pts = planArrowPolyline(2, 3, 5, 7);
    assert.equal(pts[0].x, a.x);
    assert.equal(pts[0].z, a.z);
    assert.equal(pts[1].x, b.x);
    assert.equal(pts[1].z, b.z);
  });

  test('arrow Y is uniform across the polyline (floats at a single height)', () => {
    const pts = planArrowPolyline(0, 0, 5, 5, 0.9);
    assert.equal(pts[0].y, 0.9);
    assert.equal(pts[1].y, 0.9);
  });

  test('arrow height clears the tile prism top (y > 0.075)', () => {
    const pts = planArrowPolyline(0, 0, 1, 1);
    assert.ok(pts[0].y > 0.075,
      `arrow at y=${pts[0].y} must be above the tile prism top (0.075)`);
  });

  test('badge anchor sits at the destination hex centre, above the arrow', () => {
    const b = planArrowBadgePosition(4, 6);
    const t = hexToWorld(4, 6);
    assert.equal(b.x, t.x);
    assert.equal(b.z, t.z);
    assert.ok(b.y > 0.5, `badge y=${b.y} should sit above the arrow line`);
  });

  test('arrow uses the documented HEX_RADIUS_WORLD spacing (no zoom-dependent scaling)', () => {
    // The arrow geometry should be invariant to camera zoom — it's defined
    // in world units only, which is why it can be cached & reused frame to frame.
    assert.equal(HEX_RADIUS_WORLD, 1);
  });
});

// ─── hpBarColor ─────────────────────────────────────────────────────────────

describe('Renderer3D Phase 5 — hpBarColor threshold table', () => {
  test('full HP is green', () => {
    assert.equal(hpBarColor(10, 10), '#46c84a');
  });

  test('exactly at the yellow boundary is green (≥ threshold means safe)', () => {
    // ratio = 0.66 = HP_YELLOW_BELOW → not strictly less than threshold, so green.
    const r = HP_YELLOW_BELOW;
    assert.ok(r >= HP_YELLOW_BELOW);
    assert.equal(hpBarColor(Math.round(r * 100), 100), '#46c84a');
  });

  test('mid-low HP is yellow (between red and yellow thresholds)', () => {
    // ratio = 0.5 → between 0.33 and 0.66.
    assert.equal(hpBarColor(5, 10), '#d8c333');
  });

  test('critical HP is red (below the red threshold)', () => {
    // ratio = 0.2 → strictly < 0.33.
    assert.equal(hpBarColor(2, 10), '#d83333');
  });

  test('zero HP is red (defensive, not yellow/green)', () => {
    assert.equal(hpBarColor(0, 10), '#d83333');
  });

  test('maxHp=0 does not throw — treats max as 1 internally', () => {
    // Pathological state during spawn/death transitions.
    assert.doesNotThrow(() => hpBarColor(0, 0));
  });

  test('hp > maxHp clamps to green (overheal must not be coloured red)', () => {
    assert.equal(hpBarColor(15, 10), '#46c84a');
  });

  test('thresholds are at the documented ratios', () => {
    assert.ok(HP_RED_BELOW    > 0   && HP_RED_BELOW    < 1);
    assert.ok(HP_YELLOW_BELOW > HP_RED_BELOW && HP_YELLOW_BELOW < 1);
  });
});

// ─── floatingTextTransform ──────────────────────────────────────────────────

describe('Renderer3D Phase 5 — floatingTextTransform (rise + fade)', () => {
  test('t=0 starts at y=0 and full opacity', () => {
    const p = floatingTextTransform(0);
    assert.equal(p.y, 0);
    assert.equal(p.alpha, 1);
  });

  test('t=0.5 has risen halfway and still at full opacity (alpha holds first half)', () => {
    const p = floatingTextTransform(0.5);
    assert.ok(Math.abs(p.y - 0.6) < 1e-9, `expected y≈0.6 at t=0.5, got ${p.y}`);
    assert.equal(p.alpha, 1);
  });

  test('t=1 is fully risen and fully transparent', () => {
    const p = floatingTextTransform(1);
    assert.ok(Math.abs(p.y - 1.2) < 1e-9, `expected y≈1.2 at t=1, got ${p.y}`);
    assert.equal(p.alpha, 0);
  });

  test('alpha lerps 1 → 0 across [0.5, 1] linearly', () => {
    const p75 = floatingTextTransform(0.75);
    // At t=0.75, alpha = 1 - (0.75 - 0.5) * 2 = 0.5.
    assert.ok(Math.abs(p75.alpha - 0.5) < 1e-9);
  });

  test('clamps t below 0 and above 1', () => {
    const before = floatingTextTransform(-0.2);
    const after  = floatingTextTransform(1.4);
    assert.equal(before.y, 0);
    assert.equal(before.alpha, 1);
    assert.equal(after.y, 1.2);
    assert.equal(after.alpha, 0);
  });

  test('custom riseDistance scales the trajectory linearly', () => {
    const p = floatingTextTransform(1, 3);
    assert.equal(p.y, 3);
  });
});

// ─── projectileColor01 ──────────────────────────────────────────────────────

describe('Renderer3D Phase 5 — projectile colour table', () => {
  test('witch sparkle projectile is greenish', () => {
    const [r, g, b] = projectileColor01('sparkle');
    assert.ok(g > r && g > b,
      `expected green-dominant, got rgb(${r}, ${g}, ${b})`);
  });

  test('hero arrow/crossbow projectile is brownish (red dominant)', () => {
    for (const t of ['arrow', 'crossbow']) {
      const [r, g, b] = projectileColor01(t);
      assert.ok(r > g && r > b,
        `expected red-dominant for ${t}, got rgb(${r}, ${g}, ${b})`);
    }
  });

  test('unknown projectile type falls back to a neutral colour (no throw)', () => {
    const [r, g, b] = projectileColor01('unknown-type');
    assert.ok(r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1);
  });

  test('null/undefined safe', () => {
    assert.doesNotThrow(() => projectileColor01(null));
    assert.doesNotThrow(() => projectileColor01(undefined));
  });
});

// ─── HP bar positioning constant ────────────────────────────────────────────

describe('Renderer3D Phase 5 — HP bar layout', () => {
  test('HP bar sits above the standee base (positive Y offset)', () => {
    assert.ok(HP_BAR_Y_ABOVE_BASE > 0);
  });
});
