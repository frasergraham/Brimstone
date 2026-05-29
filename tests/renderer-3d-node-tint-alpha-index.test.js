// Transparent-sort stability for the Power-Node TINT discs (alphaIndex).
//
// The faint faction-tinted hex overlays laid over each Power Node hex
// (NODE_TINT_ALPHA = 0.1) are alpha-blended but otherwise sat at Babylon's
// default alphaIndex (Number.MAX_VALUE), so the transparent pass tie-broke them
// purely on distance-to-camera — the same per-frame reshuffle/pop fixed for the
// combat overlays (300+), the road/river ribbons (100/200), and the border
// forest band (80/90). Pinning a stable alphaIndex stops the flicker.
//
// Node tints are faint ground-level objective markers, so they draw FIRST
// (behind everything): below the border terrain band, below the road/river
// ribbons, and below the combat overlays.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_TINT_ALPHA_INDEX,
  BORDER_GROUND_ALPHA_INDEX,
  BORDER_TREE_ALPHA_INDEX,
  RIVER_ALPHA_INDEX,
  ROAD_ALPHA_INDEX,
  OVERLAY_SELECTION_ALPHA_INDEX,
} from '../src/renderer-3d.js';

describe('Renderer3D — node-tint disc alphaIndex (transparent-sort stability)', () => {
  test('node tints draw below the border terrain band', () => {
    assert.ok(
      NODE_TINT_ALPHA_INDEX < BORDER_GROUND_ALPHA_INDEX,
      `node tint (${NODE_TINT_ALPHA_INDEX}) must draw behind border ground (${BORDER_GROUND_ALPHA_INDEX})`,
    );
    assert.ok(NODE_TINT_ALPHA_INDEX < BORDER_TREE_ALPHA_INDEX);
  });

  test('node tints draw below the road/river ribbons and combat overlays', () => {
    assert.ok(NODE_TINT_ALPHA_INDEX < RIVER_ALPHA_INDEX);
    assert.ok(NODE_TINT_ALPHA_INDEX < ROAD_ALPHA_INDEX);
    assert.ok(NODE_TINT_ALPHA_INDEX < OVERLAY_SELECTION_ALPHA_INDEX);
  });

  test('node tints are pinned (not Babylon default)', () => {
    assert.notEqual(NODE_TINT_ALPHA_INDEX, Number.MAX_VALUE);
    assert.ok(Number.isFinite(NODE_TINT_ALPHA_INDEX));
  });
});
