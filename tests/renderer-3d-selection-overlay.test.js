// Renderer3D selection + hover overlays (PR 3).
//
// Verifies the unified overlay map carries the selection / hover outlines on a
// real Renderer3D instance (constructed without Babylon — the constructor must
// not touch the GPU), the layer/Y policy keeps selection above hover, and the
// overlay signature is stable across identical setSelection calls.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';
import { overlaySignature, yForLayer } from '../src/overlays.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600 };
  return new Renderer3D(fakeCanvas, {});
}

describe('Renderer3D selection + hover overlay map', () => {
  test('setSelection populates the selection overlay (outline, selection layer)', () => {
    const r = makeRenderer();
    r.setSelection({ entityId: 'h1', hex: { col: 3, row: 4 } });
    const ov = r.getOverlay('selection');
    assert.ok(ov);
    assert.equal(ov.kind, 'outline');
    assert.equal(ov.layer, 'selection');
    assert.ok(ov.hexes.has('3,4'));
    assert.equal(ov.style.glow, true);
    assert.equal(ov.meta.entityId, 'h1');
    assert.deepEqual(r._selection, { entityId: 'h1', hex: { col: 3, row: 4 } });
  });

  test('setHover populates a subtle hover overlay; clearing removes it', () => {
    const r = makeRenderer();
    r.setHover({ col: 1, row: 2 });
    const ov = r.getOverlay('hover');
    assert.ok(ov);
    assert.equal(ov.kind, 'outline');
    assert.equal(ov.layer, 'selection');
    assert.equal(ov.style.glow, false);
    assert.equal(ov.style.strokeWidth, 1);
    r.setHover(null);
    assert.equal(r.getOverlay('hover'), null);
    assert.equal(r._hover, null);
  });

  test('selection nests above hover in the Y band (alphabetical order)', () => {
    // hover sorts first (n=0), selection second (n=1) → selection has the
    // higher Y, so it draws on top.
    const hoverY = yForLayer('selection', 0);
    const selY   = yForLayer('selection', 1);
    assert.ok(selY > hoverY, `selection Y ${selY} must exceed hover Y ${hoverY}`);
    assert.ok(hoverY >= 0.120 && selY <= 0.135, 'both Ys stay inside the selection band');
  });

  test('overlay signature is stable for identical selections', () => {
    const r = makeRenderer();
    r.setSelection({ entityId: 'h1', hex: { col: 5, row: 5 } });
    const sigA = overlaySignature(r.getOverlay('selection'));
    r.setSelection({ entityId: 'h1', hex: { col: 5, row: 5 } });
    const sigB = overlaySignature(r.getOverlay('selection'));
    assert.equal(sigA, sigB);
  });

  test('_syncSelectionOverlays is a no-op (no throw) before the scene exists', () => {
    const r = makeRenderer();
    r.setSelection({ entityId: 'h1', hex: { col: 0, row: 0 } });
    assert.equal(r._scene, null, 'scene not built until draw()');
    assert.doesNotThrow(() => r._syncSelectionOverlays());
    assert.equal(r._selectionOverlayMeshes.length, 0, 'no meshes built without a scene');
  });
});
