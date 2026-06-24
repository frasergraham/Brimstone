// Camera distance on auto-refocus — locks down `resolveFocusRadius`, the pure
// helper that governs whether an AUTO-focus (unit selection, turn focus, replay
// focus, combat lean-in) PANS-only (preserving the player's chosen zoom
// distance) or zooms IN to a sensible default.
//
// Operator rule: once the player has set their own zoom (wheel / pinch / fit
// button / zoom-to-me), auto-refocus must retarget only and never touch the
// distance. Before that — a fresh game still at the initial map-fit — the first
// focus may still zoom in so a unit frames sensibly. The Babylon camera plumbing
// can't run under node-test, so the decision is extracted to this pure helper
// and the call sites (`_applySelectionAndFocus`, combat bump/lunge, frameHexes)
// all delegate to it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFocusRadius,
  SELECTION_FOCUS_RADIUS,
  COMBAT_FOCUS_RADIUS,
} from '../src/renderer-3d.js';

describe('resolveFocusRadius — auto-focus distance decision', () => {
  test('preserves the current radius once the user has set a zoom (pan-only)', () => {
    // User zoomed far out (radius 60); selecting another unit must not zoom in.
    assert.equal(
      resolveFocusRadius(60, true, SELECTION_FOCUS_RADIUS, 4),
      60,
      'an established far-out zoom must be preserved on refocus',
    );
    // User zoomed far in (radius 6); refocus must keep that tight distance too.
    assert.equal(
      resolveFocusRadius(6, true, SELECTION_FOCUS_RADIUS, 4),
      6,
      'an established close zoom must be preserved on refocus',
    );
  });

  test('before any user zoom, eases IN toward the fallback when parked far out', () => {
    // Fresh game at a wide map-fit (radius 60) — first selection should zoom in
    // to the sensible default rather than stay zoomed all the way out.
    assert.equal(
      resolveFocusRadius(60, false, SELECTION_FOCUS_RADIUS, 4),
      SELECTION_FOCUS_RADIUS,
      'first focus of a fresh game should zoom in to the default framing',
    );
  });

  test('before any user zoom, never zooms OUT past the current radius', () => {
    // Camera already closer (radius 8) than the fallback (14): keep the 8 —
    // never push the view further out as part of a focus.
    assert.equal(
      resolveFocusRadius(8, false, SELECTION_FOCUS_RADIUS, 4),
      8,
      'focus must never zoom out past the current radius',
    );
  });

  test('before any user zoom, never closer than the camera lower limit', () => {
    // Fallback below the lower limit gets floored at the limit.
    assert.equal(
      resolveFocusRadius(60, false, 2, 4),
      4,
      'fallback below lowerLimit must be clamped up to lowerLimit',
    );
  });

  test('combat lean-in uses the tighter combat fallback when no user zoom yet', () => {
    assert.equal(
      resolveFocusRadius(60, false, COMBAT_FOCUS_RADIUS, 4),
      COMBAT_FOCUS_RADIUS,
      'combat focus should lean in to COMBAT_FOCUS_RADIUS on a fresh, wide view',
    );
    // …but still preserves an established zoom (combat is auto-focus too).
    assert.equal(
      resolveFocusRadius(40, true, COMBAT_FOCUS_RADIUS, 4),
      40,
      'combat focus must preserve the player zoom once established',
    );
  });

  test('lowerLimit defaults to 4 when omitted', () => {
    assert.equal(resolveFocusRadius(60, false, 1), 4);
  });
});
