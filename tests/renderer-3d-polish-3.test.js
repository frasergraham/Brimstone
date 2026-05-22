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
  CAMERA_BETA_LOCKED,
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
  test('overlay alpha stays in the translucent-overlay band (0.6..0.7)', () => {
    // Operator-tuned overlay alpha: 0.6..0.7 reads as a translucent ring
    // letting the tile show through, rather than a solid floor sticker. The
    // legacy HIGHLIGHT_MIN_ALPHA name aliases the new HIGHLIGHT_OVERLAY_ALPHA
    // and now denotes the *applied* alpha, not a clamp floor.
    assert.ok(HIGHLIGHT_MIN_ALPHA >= 0.6 && HIGHLIGHT_MIN_ALPHA <= 0.7,
      `HIGHLIGHT_MIN_ALPHA ${HIGHLIGHT_MIN_ALPHA} out of expected band [0.6, 0.7]`);
  });

  test('default rgba parses cleanly (used when ui.js omits the color field)', () => {
    const tup = parseRgba01(HIGHLIGHT_DEFAULT_RGBA);
    assert.equal(tup.length, 4);
    tup.forEach(n => assert.ok(n >= 0 && n <= 1));
  });
});

// ── Camera tilt lock (item 6) ──────────────────────────────────────────────
// Round 3 allowed a clamped tilt range; superseded by the tilt-lock task,
// which pins beta at π/4 (CAMERA_BETA_LOCKED). The check below replaces the
// former "deltas non-zero / clamped range" assertions — tilt is now a single
// fixed value.

describe('Renderer3D — camera beta locked at π/4', () => {
  test('CAMERA_BETA_LOCKED sits strictly inside (0, π/2)', () => {
    assert.ok(CAMERA_BETA_LOCKED > 0.05,
      `${CAMERA_BETA_LOCKED} too close to zero — camera would point at the floor`);
    assert.ok(CAMERA_BETA_LOCKED < Math.PI / 2 - 0.05,
      `${CAMERA_BETA_LOCKED} too close to π/2 — camera would see through tile sides`);
  });
  test('CAMERA_BETA_LOCKED sits in a playable tilt band', () => {
    // Exact lock angle is operator-tuned (~35°); allow a band rather than
    // pinning the value, since taste shifts independently of the structural
    // invariants checked above.
    const min = Math.PI * 20 / 180;
    const max = Math.PI * 55 / 180;
    assert.ok(CAMERA_BETA_LOCKED >= min && CAMERA_BETA_LOCKED <= max,
      `tilt ${CAMERA_BETA_LOCKED} out of [${min}, ${max}]`);
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
