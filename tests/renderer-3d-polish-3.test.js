// Round 3 3D-renderer polish: fog respects node discs + HP bars, movement
// highlights, dialled-down selection glow, clamped camera tilt. Babylon mesh
// work is exercised by hand in-browser; here we lock down the pure helpers
// and tuning constants that drive the change.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldRenderEntityAt,
  movementHighlightSignature,
  movementHighlightPosition,
  parseRgba01,
  hexToWorld,
  HIGHLIGHT_DISC_Y,
  HIGHLIGHT_MIN_ALPHA,
  HIGHLIGHT_DEFAULT_RGBA,
  CAMERA_BETA_LOWER_DELTA,
  CAMERA_BETA_UPPER_DELTA,
  SELECTION_PULSE_MIN,
  SELECTION_PULSE_MAX,
  PLAN_DISC_Y,
} from '../src/renderer-3d.js';

// ── Fog visibility (item 2: HP bars follow standee visibility) ─────────────

describe('Renderer3D round-3 polish — shouldRenderEntityAt', () => {
  test('returns true when there is no fog target (no fog active)', () => {
    assert.equal(shouldRenderEntityAt(null, '4,5'), true);
    assert.equal(shouldRenderEntityAt(undefined, '4,5'), true);
  });

  test('returns true when the entity hex is in the visible set', () => {
    const t = new Set(['4,5', '4,6']);
    assert.equal(shouldRenderEntityAt(t, '4,5'), true);
  });

  test('returns false when the entity hex is fogged (not in set)', () => {
    const t = new Set(['4,5']);
    assert.equal(shouldRenderEntityAt(t, '9,9'), false);
  });

  test('empty visible set hides everything', () => {
    assert.equal(shouldRenderEntityAt(new Set(), '0,0'), false);
  });
});

// ── Movement highlight signature (item 3) ──────────────────────────────────

describe('Renderer3D round-3 polish — movementHighlightSignature', () => {
  test('empty / non-array input → empty signature', () => {
    assert.equal(movementHighlightSignature(null), '');
    assert.equal(movementHighlightSignature(undefined), '');
    assert.equal(movementHighlightSignature([]), '');
    assert.equal(movementHighlightSignature('not-an-array'), '');
  });

  test('identical lists produce identical signatures', () => {
    const a = [{ col: 1, row: 2, color: 'rgba(60,220,80,0.22)' }];
    const b = [{ col: 1, row: 2, color: 'rgba(60,220,80,0.22)' }];
    assert.equal(movementHighlightSignature(a), movementHighlightSignature(b));
  });

  test('different colour on same hex changes the signature', () => {
    const a = [{ col: 1, row: 2, color: 'rgba(60,220,80,0.22)' }];
    const b = [{ col: 1, row: 2, color: 'rgba(220,60,60,0.55)' }];
    assert.notEqual(movementHighlightSignature(a), movementHighlightSignature(b));
  });

  test('different hex set changes the signature', () => {
    const a = [{ col: 1, row: 2, color: 'rgba(0,0,0,1)' }];
    const b = [{ col: 3, row: 4, color: 'rgba(0,0,0,1)' }];
    assert.notEqual(movementHighlightSignature(a), movementHighlightSignature(b));
  });

  test('skips malformed entries (missing col/row) without throwing', () => {
    assert.equal(movementHighlightSignature([{}, null, undefined]), '');
  });
});

// ── Movement highlight position math (item 3) ──────────────────────────────

describe('Renderer3D round-3 polish — movementHighlightPosition', () => {
  test('XZ matches hexToWorld for the same (col, row)', () => {
    for (const [c, r] of [[0, 0], [3, 2], [5, 7], [-2, -3]]) {
      const expected = hexToWorld(c, r);
      const got = movementHighlightPosition(c, r);
      assert.equal(got.x, expected.x);
      assert.equal(got.z, expected.z);
    }
  });

  test('Y is the configured disc height (above tile prism, below plan disc)', () => {
    const { y } = movementHighlightPosition(0, 0);
    assert.equal(y, HIGHLIGHT_DISC_Y);
    // tile prism top sits at 0.075 → highlight must clear it visually.
    assert.ok(y > 0.075, `highlight Y ${y} must clear tile prism top (0.075)`);
    // ...but stay BELOW the plan-marker disc so when both are present the
    // plan marker remains the dominant visual cue.
    assert.ok(y < PLAN_DISC_Y,
      `highlight Y ${y} must sit below PLAN_DISC_Y (${PLAN_DISC_Y})`);
  });
});

// ── RGBA parsing (item 3) ──────────────────────────────────────────────────

describe('Renderer3D round-3 polish — parseRgba01', () => {
  test('parses a typical ui.js rgba string', () => {
    const [r, g, b, a] = parseRgba01('rgba(60,220,80,0.22)');
    assert.ok(Math.abs(r - 60 / 255) < 1e-9);
    assert.ok(Math.abs(g - 220 / 255) < 1e-9);
    assert.ok(Math.abs(b - 80 / 255) < 1e-9);
    assert.ok(Math.abs(a - 0.22) < 1e-9);
  });

  test('parses rgb() without alpha (alpha defaults to 1)', () => {
    const [, , , a] = parseRgba01('rgb(10,20,30)');
    assert.equal(a, 1);
  });

  test('clamps out-of-range channels to [0, 1]', () => {
    const [r, , , a] = parseRgba01('rgba(300,0,0,2.5)');
    assert.equal(r, 1);
    assert.equal(a, 1);
  });

  test('falls back to a sensible default for garbage input', () => {
    const tup = parseRgba01('not-a-color');
    assert.equal(tup.length, 4);
    tup.forEach(n => assert.ok(n >= 0 && n <= 1));
  });

  test('non-string input falls back rather than crashing', () => {
    const tup = parseRgba01(null);
    assert.equal(tup.length, 4);
  });
});

// ── Highlight tuning constants (item 3) ────────────────────────────────────

describe('Renderer3D round-3 polish — highlight constants', () => {
  test('min alpha keeps highlights legible against varied terrain', () => {
    assert.ok(HIGHLIGHT_MIN_ALPHA >= 0.2 && HIGHLIGHT_MIN_ALPHA <= 0.6,
      `HIGHLIGHT_MIN_ALPHA ${HIGHLIGHT_MIN_ALPHA} out of expected band`);
  });

  test('default rgba parses cleanly (used when ui.js omits the color field)', () => {
    const tup = parseRgba01(HIGHLIGHT_DEFAULT_RGBA);
    assert.equal(tup.length, 4);
    tup.forEach(n => assert.ok(n >= 0 && n <= 1));
  });
});

// ── Camera tilt clamp (item 6) ─────────────────────────────────────────────

describe('Renderer3D round-3 polish — camera beta range', () => {
  // _lockedBeta = π/3.5 ≈ 0.898 rad ≈ 51.4°. Deltas must keep the clamped
  // range strictly inside (0, π/2) — outside that band the camera either
  // points straight down at the floor (β=0) or sees through tile prisms (β≈π/2).
  const ANCHOR = Math.PI / 3.5;
  const lower = ANCHOR - CAMERA_BETA_LOWER_DELTA;
  const upper = ANCHOR + CAMERA_BETA_UPPER_DELTA;

  test('both deltas are non-zero (otherwise tilt is effectively locked again)', () => {
    assert.ok(CAMERA_BETA_LOWER_DELTA > 0, 'lower delta must be positive');
    assert.ok(CAMERA_BETA_UPPER_DELTA > 0, 'upper delta must be positive');
  });

  test('clamped range stays inside (0, π/2) — never straight-down, never horizontal', () => {
    assert.ok(lower > 0.05,
      `lower limit ${lower} too close to zero — camera would point at the floor`);
    assert.ok(upper < Math.PI / 2 - 0.05,
      `upper limit ${upper} too close to π/2 — camera would see through tile sides`);
  });

  test('lower < upper (valid clamp), with the anchor inside the range', () => {
    assert.ok(lower < upper, 'lower limit must be strictly below the upper limit');
    assert.ok(ANCHOR > lower && ANCHOR < upper,
      'anchor must sit inside the clamped range so the default tilt is reachable');
  });
});

// ── Selection glow tuning (item 5) ─────────────────────────────────────────

describe('Renderer3D round-3 polish — selection pulse tuning', () => {
  test('peak intensity stays well below the GlowLayer ceiling', () => {
    // GlowLayer + emissive saturate when summed >= 1.0; round-3 reduces the
    // pulse peak so the standee silhouette stays visible inside the halo.
    assert.ok(SELECTION_PULSE_MAX < 0.6,
      `SELECTION_PULSE_MAX ${SELECTION_PULSE_MAX} too bright after round-3 tuning`);
  });

  test('min is meaningfully below max so the breathing motion still reads', () => {
    assert.ok(SELECTION_PULSE_MIN < SELECTION_PULSE_MAX);
    assert.ok(SELECTION_PULSE_MAX - SELECTION_PULSE_MIN > 0.1,
      'pulse swing too narrow — halo would look static');
  });

  test('min stays > 0 so the halo never disappears entirely', () => {
    assert.ok(SELECTION_PULSE_MIN > 0,
      `SELECTION_PULSE_MIN ${SELECTION_PULSE_MIN} would make the selection invisible at trough`);
  });
});
