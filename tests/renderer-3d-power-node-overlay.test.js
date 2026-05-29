// Power-node tint overlay — pure-helper tests for the per-hex tint disc that
// sits alongside the node ring tubes + identifier outline. Babylon mesh wiring
// (CreateCylinder, CreateTube) runs in-browser; this file locks the math +
// colour rules. (P4c removed the floating power-node name label entirely — the
// node's on-map identity is the ring + tint + identifier outline + HUD dots.)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_TINT_Y,
  NODE_TINT_DIAMETER,
  NODE_TINT_ALPHA,
  NODE_GLOW_COLORS,
  NODE_DISC_DIAMETER,
  nodeOverlayColor,
  getNodeGlowColor,
  nodeControllerRingVisible,
  clusterCentroidWorld,
  hexToWorld,
} from '../src/renderer-3d.js';

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

describe('nodeControllerRingVisible — R5a: ring only on occupied nodes', () => {
  test('neutral / unoccupied node hides the controller ring', () => {
    assert.equal(nodeControllerRingVisible('neutral'), false);
  });

  test('a side holding the node shows the ring', () => {
    assert.equal(nodeControllerRingVisible('hero'),  true);
    assert.equal(nodeControllerRingVisible('witch'), true);
  });

  test('contested (both sides on the node) still shows the ring', () => {
    // Contested is occupied — the brief only drops the *white* (neutral) ring.
    assert.equal(nodeControllerRingVisible('contested'), true);
  });

  test('an arbitrary player owner id shows the ring', () => {
    assert.equal(nodeControllerRingVisible('player-abc-123'), true);
  });

  test('null / undefined controller is treated as hidden', () => {
    assert.equal(nodeControllerRingVisible(null),      false);
    assert.equal(nodeControllerRingVisible(undefined), false);
  });
});

describe('clusterCentroidWorld — R5b: label anchors at cluster centre of mass', () => {
  test('single-hex cluster centroid equals that hex world position', () => {
    const c = clusterCentroidWorld([{ col: 3, row: 4 }]);
    const w = hexToWorld(3, 4);
    assert.equal(c.x, w.x);
    assert.equal(c.z, w.z);
  });

  test('centroid is the mean of the member hex world positions', () => {
    const hexes = [{ col: 2, row: 2 }, { col: 3, row: 2 }, { col: 2, row: 3 }];
    const c = clusterCentroidWorld(hexes);
    let sx = 0;
    let sz = 0;
    for (const h of hexes) {
      const w = hexToWorld(h.col, h.row);
      sx += w.x;
      sz += w.z;
    }
    assert.ok(Math.abs(c.x - sx / hexes.length) < 1e-9);
    assert.ok(Math.abs(c.z - sz / hexes.length) < 1e-9);
  });

  test('centroid lies strictly between the extreme hexes of a spread cluster', () => {
    const a = hexToWorld(0, 0);
    const b = hexToWorld(4, 0);
    const c = clusterCentroidWorld([{ col: 0, row: 0 }, { col: 4, row: 0 }]);
    assert.ok(c.x > Math.min(a.x, b.x) && c.x < Math.max(a.x, b.x),
      'centroid x sits between the two hexes, not over either one');
  });

  test('empty / invalid cluster returns null', () => {
    assert.equal(clusterCentroidWorld([]),        null);
    assert.equal(clusterCentroidWorld(null),      null);
    assert.equal(clusterCentroidWorld(undefined), null);
  });
});
