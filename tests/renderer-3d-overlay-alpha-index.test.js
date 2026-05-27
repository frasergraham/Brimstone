// Transparent-sort stability for the COMBAT OVERLAY discs (alphaIndex).
//
// In-browser bug: hexes flickered at the END of combat. Diagnosed via headless
// Chrome (Babylon's real `RenderingGroup.defaultTransparentSortCompare` over an
// 80-frame combat-camera sweep): every transparent overlay disc — movement /
// target highlight fills, the plan waypoint puck + numbered badge, and the
// transparent hover ring — sat at Babylon's default alphaIndex
// (Number.MAX_VALUE), so the transparent pass tie-broke on distance-to-camera.
// The combat camera pan (lunge framing + ease-back) moves and rotates across
// these discs, and at grazing angles different-coloured overlays that overlap
// in screen space reshuffle their draw order — popping the alpha blend. The
// sweep measured the cross-category overlay draw order changing in 24 of 79
// frame transitions; pinning a stable per-variant alphaIndex drops it to 0.
//
// The fix mirrors the existing border-forest / road / river alphaIndex pins:
// a stable index per overlay variant, ascending in the same order as the
// overlay Y bands (selection < highlight-disc < plan-arrow), all above the
// road/river terrain band so overlays still draw over the network ribbons.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROAD_ALPHA_INDEX,
  RIVER_ALPHA_INDEX,
  BORDER_TREE_ALPHA_INDEX,
  OVERLAY_SELECTION_ALPHA_INDEX,
  OVERLAY_HIGHLIGHT_DISC_ALPHA_INDEX,
  OVERLAY_PLAN_ARROW_ALPHA_INDEX,
  OVERLAY_PLAN_BADGE_ALPHA_INDEX,
  Renderer3D,
} from '../src/renderer-3d.js';
import { makeOverlay } from '../src/overlays.js';

describe('Renderer3D — combat overlay alphaIndex (transparent-sort stability)', () => {
  test('selection < highlight-disc < plan-arrow < plan-badge mirrors the Y stacking', () => {
    assert.ok(
      OVERLAY_SELECTION_ALPHA_INDEX < OVERLAY_HIGHLIGHT_DISC_ALPHA_INDEX,
      'the selection/hover ring (Y 0.12) must draw behind the highlight fills (Y 0.16)',
    );
    assert.ok(
      OVERLAY_HIGHLIGHT_DISC_ALPHA_INDEX < OVERLAY_PLAN_ARROW_ALPHA_INDEX,
      'highlight fills (Y 0.16) must draw behind the plan waypoint puck (Y 0.18)',
    );
    assert.ok(
      OVERLAY_PLAN_ARROW_ALPHA_INDEX < OVERLAY_PLAN_BADGE_ALPHA_INDEX,
      'the plan puck must draw behind its own numbered badge',
    );
  });

  test('all overlay indices sit above the road/river/border terrain band', () => {
    for (const idx of [
      OVERLAY_SELECTION_ALPHA_INDEX,
      OVERLAY_HIGHLIGHT_DISC_ALPHA_INDEX,
      OVERLAY_PLAN_ARROW_ALPHA_INDEX,
      OVERLAY_PLAN_BADGE_ALPHA_INDEX,
    ]) {
      assert.ok(idx > ROAD_ALPHA_INDEX, `overlay index ${idx} must exceed ROAD (${ROAD_ALPHA_INDEX})`);
      assert.ok(idx > RIVER_ALPHA_INDEX, `overlay index ${idx} must exceed RIVER (${RIVER_ALPHA_INDEX})`);
      assert.ok(idx > BORDER_TREE_ALPHA_INDEX);
    }
  });

  test('highlight-disc base + max nested offset stays below the plan-arrow index', () => {
    // _buildFillOverlays pins base + nestedIndex (move / target / battle-hex).
    // There are at most a handful of fill overlays; reserve a comfortable gap so
    // the nested offsets never collide with the plan-arrow index.
    const MAX_NESTED = 8;
    assert.ok(
      OVERLAY_HIGHLIGHT_DISC_ALPHA_INDEX + MAX_NESTED < OVERLAY_PLAN_ARROW_ALPHA_INDEX,
      'nested fill offsets must not climb into the plan-arrow index',
    );
  });
});

// ── Functional: the fill builder actually pins the ribbons ───────────────────
//
// Drives `_buildFillOverlays` with a minimal Babylon stub and two fill overlays
// (move + target) in the highlight-disc layer, then asserts each emitted ribbon
// carries OVERLAY_HIGHLIGHT_DISC_ALPHA_INDEX + its nested index — never the
// default Number.MAX_VALUE.

function makeStubBabylon() {
  const makeMesh = (name) => ({
    name,
    position: { x: 0, z: 0, set() {} },
    parent: null,
    material: null,
    isPickable: true,
    alphaIndex: Number.MAX_VALUE, // Babylon default
    renderingGroupId: 0,
    dispose() {},
  });
  const StandardMaterial = function (name) {
    this.name = name;
    this.alpha = 1;
    this.diffuseColor = null;
    this.emissiveColor = null;
    this.specularColor = null;
    this.backFaceCulling = true;
  };
  return {
    MeshBuilder: {
      CreateRibbon: (name) => makeMesh(name),
      CreateTube:   (name) => makeMesh(name),
    },
    Mesh: { DOUBLESIDE: 2 },
    StandardMaterial,
    Color3: function (r, g, b) { this.r = r; this.g = g; this.b = b; },
    Vector3: function (x, y, z) { this.x = x; this.y = y; this.z = z; },
  };
}

describe('Renderer3D._buildFillOverlays — pins highlight-disc alphaIndex', () => {
  test('each fill ribbon is pinned to base + nested index (move=0, target=1)', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene = {};
    r._mapRoot = {};

    // Two fill overlays in the highlight-disc layer. Ids sort alphabetically:
    // 'battle-targets' (nested 0) before 'move-targets' (nested 1).
    r.setOverlay('battle-targets', makeOverlay({
      id: 'battle-targets', kind: 'fill', layer: 'highlight-disc',
      hexes: new Set(['2,2', '3,3']), style: { color: 'rgba(220,60,60,0.85)' },
    }));
    r.setOverlay('move-targets', makeOverlay({
      id: 'move-targets', kind: 'fill', layer: 'highlight-disc',
      hexes: new Set(['1,1']), style: { color: 'rgba(60,220,80,0.85)' },
    }));

    r._buildFillOverlays();

    assert.equal(r._highlightMeshes.length, 3, 'one ribbon per tagged hex');
    for (const m of r._highlightMeshes) {
      assert.notEqual(m.alphaIndex, Number.MAX_VALUE, 'every fill ribbon is pinned');
    }
    const byOverlay = (prefix) =>
      r._highlightMeshes.filter((m) => m.name.startsWith(`highlight_${prefix}_`));
    // 'battle-targets' sorts first → nested 0 → base index.
    for (const m of byOverlay('battle-targets')) {
      assert.equal(m.alphaIndex, OVERLAY_HIGHLIGHT_DISC_ALPHA_INDEX);
    }
    // 'move-targets' sorts second → nested 1 → base + 1.
    for (const m of byOverlay('move-targets')) {
      assert.equal(m.alphaIndex, OVERLAY_HIGHLIGHT_DISC_ALPHA_INDEX + 1);
    }
  });
});
