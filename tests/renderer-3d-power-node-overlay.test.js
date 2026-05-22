// Power-node tint + floating name label — pure-helper tests for the new
// per-hex tint disc and billboarded label added alongside the existing node
// ring tubes. Babylon mesh wiring (CreateCylinder, DynamicTexture, billboard
// rotation) runs in-browser; this file locks the math + colour rules.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_TINT_Y,
  NODE_TINT_DIAMETER,
  NODE_TINT_ALPHA,
  NODE_LABEL_Y,
  NODE_LABEL_WIDTH,
  NODE_LABEL_HEIGHT,
  NODE_LABEL_TEX_W,
  NODE_LABEL_TEX_H,
  NODE_GLOW_COLORS,
  NODE_DISC_DIAMETER,
  BUILDING_LABEL_Y,
  nodeLabelText,
  nodeOverlayColor,
  getNodeGlowColor,
} from '../src/renderer-3d.js';

describe('nodeLabelText — display string for a power-node label', () => {
  test('returns the objective label verbatim when present', () => {
    assert.equal(nodeLabelText({ label: 'The Crooked Pine' }), 'The Crooked Pine');
    assert.equal(nodeLabelText({ label: 'Power Node 1'   }), 'Power Node 1');
  });

  test('falls back to a generic name when label is missing or empty', () => {
    assert.equal(nodeLabelText({}),              'Power Node');
    assert.equal(nodeLabelText({ label: ''   }), 'Power Node');
    assert.equal(nodeLabelText({ label: null }), 'Power Node');
  });

  test('null / undefined objective returns empty string (defensive)', () => {
    assert.equal(nodeLabelText(null),      '');
    assert.equal(nodeLabelText(undefined), '');
  });
});

describe('nodeOverlayColor — controller → hex colour', () => {
  test('hero / witch / neutral / contested each map to the glow palette', () => {
    assert.equal(nodeOverlayColor('hero'),      NODE_GLOW_COLORS.hero);
    assert.equal(nodeOverlayColor('witch'),     NODE_GLOW_COLORS.witch);
    assert.equal(nodeOverlayColor('neutral'),   NODE_GLOW_COLORS.neutral);
    assert.equal(nodeOverlayColor('contested'), NODE_GLOW_COLORS.contested);
  });

  test('unknown controllers fall back to neutral pale grey', () => {
    assert.equal(nodeOverlayColor('martian'),  NODE_GLOW_COLORS.neutral);
    assert.equal(nodeOverlayColor(undefined),  NODE_GLOW_COLORS.neutral);
    assert.equal(nodeOverlayColor(null),       NODE_GLOW_COLORS.neutral);
  });

  test('shares one source of truth with getNodeGlowColor (no palette drift)', () => {
    // If a designer retunes the glow palette, the tint + label retint with it.
    // This test guards against the two helpers silently diverging.
    for (const ctrl of ['hero', 'witch', 'neutral', 'contested', 'unknown']) {
      assert.equal(nodeOverlayColor(ctrl), getNodeGlowColor(ctrl),
        `nodeOverlayColor(${ctrl}) should equal getNodeGlowColor(${ctrl})`);
    }
  });
});

describe('Tint disc geometry constants — sits in the right Y band', () => {
  test('NODE_TINT_Y sits above the terrain disc (0.084) and below highlight (0.12)', () => {
    // Per the layered Y ordering doc in renderer-3d.js:
    //   terrain disc 0.084  →  node tint  →  highlight 0.12
    assert.ok(NODE_TINT_Y > 0.084,
      `NODE_TINT_Y ${NODE_TINT_Y} must clear the terrain disc to avoid z-fighting`);
    assert.ok(NODE_TINT_Y < 0.12,
      `NODE_TINT_Y ${NODE_TINT_Y} must stay below the highlight band so highlights win`);
  });

  test('NODE_TINT_ALPHA is the 10% wash per the operator brief', () => {
    assert.ok(Math.abs(NODE_TINT_ALPHA - 0.1) < 1e-9,
      `NODE_TINT_ALPHA ${NODE_TINT_ALPHA} should be ~0.1 (10%)`);
  });

  test('tint covers the same footprint as the existing node ring disc', () => {
    // The disc and the tint sit on the same tile; matching diameters keep the
    // colour reading visually consistent at the hex edges.
    assert.equal(NODE_TINT_DIAMETER, NODE_DISC_DIAMETER,
      'tint disc should match the existing NODE_DISC_DIAMETER');
  });
});

describe('Floating label constants — sit above the tile, below building labels', () => {
  test('label Y clears the tile but sits below the building label band', () => {
    assert.ok(NODE_LABEL_Y > 0.93,
      `NODE_LABEL_Y ${NODE_LABEL_Y} should clear the tile surface`);
    // Building labels live at 1.55 — the node label sits a bit lower so a hex
    // that doubles as both doesn't stack two labels on top of each other.
    assert.ok(NODE_LABEL_Y < BUILDING_LABEL_Y,
      `NODE_LABEL_Y ${NODE_LABEL_Y} should sit below BUILDING_LABEL_Y ${BUILDING_LABEL_Y}`);
  });

  test('label plane is wide enough for long node names', () => {
    // "The Crooked Pine" is ~16 chars; the plane width / texture should fit
    // comfortably without horizontal squash.
    assert.ok(NODE_LABEL_WIDTH > 2.0,
      `NODE_LABEL_WIDTH ${NODE_LABEL_WIDTH} should be wide enough for 16+ char labels`);
    assert.ok(NODE_LABEL_HEIGHT > 0.4,
      `NODE_LABEL_HEIGHT ${NODE_LABEL_HEIGHT} should give the text breathing room`);
  });

  test('label DynamicTexture is power-of-two-friendly', () => {
    // Babylon DynamicTextures prefer pow-2 sizes for filtering / upload.
    const isPow2 = (n) => (n & (n - 1)) === 0;
    // We use 384x96 which is 3*128 x 96 — not strict pow-2 but matches the
    // building label's 256x64 aspect ratio (4:1) so the painting code can be
    // shared. Just assert a sane shape rather than strict pow-2.
    assert.ok(NODE_LABEL_TEX_W >= 256, 'label texture must be at least 256 wide');
    assert.ok(NODE_LABEL_TEX_H >= 64,  'label texture must be at least 64 tall');
    assert.ok(NODE_LABEL_TEX_W / NODE_LABEL_TEX_H >= 3,
      'label texture aspect ≥ 3:1 (wide-and-short suits horizontal text)');
  });
});

describe('Faction palette — tint and label both read as the controller colour', () => {
  test('hero control = saturated gold across both overlays', () => {
    assert.equal(nodeOverlayColor('hero'), '#ffb800');
  });

  test('witch control = vivid sickly green across both overlays', () => {
    assert.equal(nodeOverlayColor('witch'), '#3ee013');
  });

  test('neutral = pale grey (~10% wash reads as "uncontested" cleanly)', () => {
    assert.equal(nodeOverlayColor('neutral'), '#e8e8e8');
  });

  test('contested = vivid orange', () => {
    assert.equal(nodeOverlayColor('contested'), '#ff6a00');
  });
});
