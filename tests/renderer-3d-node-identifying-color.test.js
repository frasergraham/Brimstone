// Per-node identifying colour — pure-helper tests for the 3D renderer's
// palette match with the 2D score-dot HUD. The 3D label text and the outer
// node identifier ring both pull from `nodeIdentifyingColor`, which reads
// the same `NODE_COLORS` palette that map-gen stamps onto each witch
// objective. This file locks the lookup rules and the palette parity.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { NODE_COLORS } from '../src/map.js';
import {
  nodeIdentifyingColor,
  NODE_IDENTIFIER_RING_RADIUS,
  NODE_IDENTIFIER_RING_TUBE,
} from '../src/renderer-3d.js';

describe('nodeIdentifyingColor — palette resolution', () => {
  test('reads obj.color when present (preferred — matches HUD score dot)', () => {
    // The score dot in `src/ui-render.js` reads obj.color directly, so the
    // 3D side must do the same to stay in sync at map-gen time.
    assert.equal(nodeIdentifyingColor({ color: '#d946ef' }), '#d946ef');
    assert.equal(nodeIdentifyingColor({ color: '#f59e0b' }), '#f59e0b');
    assert.equal(nodeIdentifyingColor({ color: '#06b6d4' }), '#06b6d4');
  });

  test('numeric index looks up NODE_COLORS (defensive fallback)', () => {
    assert.equal(nodeIdentifyingColor(0), NODE_COLORS[0]);
    assert.equal(nodeIdentifyingColor(1), NODE_COLORS[1]);
    assert.equal(nodeIdentifyingColor(2), NODE_COLORS[2]);
  });

  test('numeric index wraps around the palette', () => {
    const n = NODE_COLORS.length;
    assert.equal(nodeIdentifyingColor(n),     NODE_COLORS[0]);
    assert.equal(nodeIdentifyingColor(n + 1), NODE_COLORS[1]);
    assert.equal(nodeIdentifyingColor(-1),    NODE_COLORS[n - 1]);
  });

  test('null / undefined / empty objects fall back to the first palette entry', () => {
    assert.equal(nodeIdentifyingColor(null),       NODE_COLORS[0]);
    assert.equal(nodeIdentifyingColor(undefined),  NODE_COLORS[0]);
    assert.equal(nodeIdentifyingColor({}),         NODE_COLORS[0]);
    assert.equal(nodeIdentifyingColor({ color: '' }), NODE_COLORS[0]);
    assert.equal(nodeIdentifyingColor({ color: null }), NODE_COLORS[0]);
  });

  test('the standard 3-node game gets 3 distinct identifying colours', () => {
    // Map-gen runs `NODE_COLORS[i % NODE_COLORS.length]` so three nodes are
    // always three distinct palette entries. The 3D label + outer ring must
    // honour that distinction.
    const a = nodeIdentifyingColor({ color: NODE_COLORS[0] });
    const b = nodeIdentifyingColor({ color: NODE_COLORS[1] });
    const c = nodeIdentifyingColor({ color: NODE_COLORS[2] });
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
  });
});

describe('NODE_COLORS palette — distinct + clear of the move-here highlight', () => {
  // The reachable-hex "you can move here" highlight is green
  // (HIGHLIGHT_DEFAULT_RGBA = rgba(60,220,80,…) in renderer-3d.js → ~hue 128°).
  // A node-identifier colour sitting near that hue (the old emerald #22c55e at
  // ~hue 142°) is confusable with the highlight, so no node colour may land in
  // the green band around it. Max simultaneous nodes is 7, so we need ≥7 hues.
  const MOVE_HIGHLIGHT_HUE = 128; // rgb(60,220,80)
  const MIN_HUE_GAP_FROM_HIGHLIGHT = 30; // degrees — keep node hues out of the green band

  function hueOf(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0; // achromatic — no hue to clash
    const d = max - min;
    let hue;
    if (max === r)      hue = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) hue = ((b - r) / d + 2);
    else                hue = ((r - g) / d + 4);
    return Math.round((hue / 6) * 360);
  }
  function hueDist(a, b) {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  }

  test('palette supplies at least 7 colours (max node count)', () => {
    assert.ok(NODE_COLORS.length >= 7,
      `expected ≥7 node colours (max nodes is 7), got ${NODE_COLORS.length}`);
  });

  test('all node colours are mutually distinct', () => {
    assert.equal(new Set(NODE_COLORS).size, NODE_COLORS.length,
      `duplicate node colour in ${JSON.stringify(NODE_COLORS)}`);
  });

  test('no node colour is confusable in hue with the green move-here highlight', () => {
    for (const hex of NODE_COLORS) {
      const gap = hueDist(hueOf(hex), MOVE_HIGHLIGHT_HUE);
      assert.ok(gap >= MIN_HUE_GAP_FROM_HIGHLIGHT,
        `node colour ${hex} (hue ${hueOf(hex)}°) is only ${gap}° from the move ` +
        `highlight (hue ${MOVE_HIGHLIGHT_HUE}°); needs ≥${MIN_HUE_GAP_FROM_HIGHLIGHT}°`);
    }
  });

  test('node 0 is no longer the old emerald green that clashed with the highlight', () => {
    assert.notEqual(NODE_COLORS[0], '#22c55e');
  });
});

describe('NODE_IDENTIFIER_RING geometry constants', () => {
  test('outer identifier ring sits outside the controller ring (radius 0.96)', () => {
    // The controller ring tube is drawn at radius 0.96 inside
    // _buildNodeGlowMeshes. The identifier ring must sit outside it so the
    // two read as a concentric pair, not as a single fat outline.
    assert.ok(NODE_IDENTIFIER_RING_RADIUS > 0.96,
      `NODE_IDENTIFIER_RING_RADIUS ${NODE_IDENTIFIER_RING_RADIUS} should sit outside the controller ring (0.96)`);
  });

  test('outer identifier ring stays inside the tile footprint (≤ HEX_RADIUS_WORLD = 1.0 + a margin)', () => {
    // A ring that exceeded the tile edge by a wide margin would bleed onto
    // neighbouring hexes. Allow a small overhang (≤ 0.1 worldunit) since
    // the tube has a finite radius.
    assert.ok(NODE_IDENTIFIER_RING_RADIUS < 1.15,
      `NODE_IDENTIFIER_RING_RADIUS ${NODE_IDENTIFIER_RING_RADIUS} should stay within the tile footprint`);
  });

  test('identifier ring is thinner than the controller ring (0.06)', () => {
    // The controller signal must stay dominant; the identifier just adds
    // a quiet edge of palette colour.
    assert.ok(NODE_IDENTIFIER_RING_TUBE < 0.06,
      `NODE_IDENTIFIER_RING_TUBE ${NODE_IDENTIFIER_RING_TUBE} should be thinner than the controller ring tube (0.06)`);
    assert.ok(NODE_IDENTIFIER_RING_TUBE > 0.01,
      `NODE_IDENTIFIER_RING_TUBE ${NODE_IDENTIFIER_RING_TUBE} should still be thick enough to read at zoomed-out distance`);
  });
});
