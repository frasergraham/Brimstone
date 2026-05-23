// Per-unit ground-level hex outline ring — pure helpers + tuning constants.
//
// What this locks down (no Babylon scene needed):
//   • Y placement: above road apex (≈0.09) / node rings (0.03) and below
//     HIGHLIGHT_DISC_Y so the ring still reads when a unit is standing on a
//     highlighted movement-range hex.
//   • Tube radius ordering: thin < thick. Selecting a unit visibly thickens
//     the ring (the "thicker-on-select" contract).
//   • Glow emissive cap: ≤ 0.6 × diffuse so the GlowLayer bloom stays
//     owner-tinted instead of clipping to white (same convention as
//     NODE_DISC_EMISSIVE_MUL).
//   • Ring path geometry: 7 vertices (last == first) on a pointy-top hex,
//     all at the same Y, ring centred on the origin so the renderer can
//     translate to any tile centre.
//   • Owner-colour delegation: `unitHexOutlineColor` returns the same colour
//     as the standee base disc, so the outline and token always match.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  // tuning constants under test
  UNIT_HEX_OUTLINE_Y,
  UNIT_HEX_OUTLINE_RING_R,
  UNIT_HEX_OUTLINE_THIN_TUBE,
  UNIT_HEX_OUTLINE_THICK_TUBE,
  UNIT_HEX_OUTLINE_THIN_EMISSIVE_MUL,
  UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL,
  // pure helpers under test
  unitHexOutlineRingPath,
  unitHexOutlineColor,
  // cross-layer constants the ring placement must respect
  HEX_RADIUS_WORLD,
  HIGHLIGHT_DISC_Y,
  HIGHLIGHT_OUTER_R,
  ROAD_RIBBON_Y,
  // for the owner-colour delegation cross-check
  entityBaseColor,
} from '../src/renderer-3d.js';

// ── Y placement ─────────────────────────────────────────────────────────────

describe('Renderer3D — UNIT_HEX_OUTLINE_Y', () => {
  test('sits below the movement-highlight disc so highlights still draw above', () => {
    assert.ok(UNIT_HEX_OUTLINE_Y < HIGHLIGHT_DISC_Y,
      `outline Y ${UNIT_HEX_OUTLINE_Y} must be < HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y}`);
  });

  test('sits well above the road ribbon apex so the ring is not buried under the deck', () => {
    // Road apex ≈ 0.09 (ROAD_RIBBON_Y plus the extruded thickness). We just
    // assert the outline clears the ribbon's flat ground plane by at least
    // a few hundredths — z-fight against the road tube is the failure mode
    // we're protecting against.
    assert.ok(UNIT_HEX_OUTLINE_Y > ROAD_RIBBON_Y + 0.05,
      `outline Y ${UNIT_HEX_OUTLINE_Y} should clear ROAD_RIBBON_Y ${ROAD_RIBBON_Y} with headroom`);
  });

  test('sits above the tile prism top (0.075) so it is not buried in terrain', () => {
    assert.ok(UNIT_HEX_OUTLINE_Y > 0.075,
      `outline Y ${UNIT_HEX_OUTLINE_Y} must clear the tile prism top`);
  });
});

// ── Ring geometry ───────────────────────────────────────────────────────────

describe('Renderer3D — unitHexOutlineRingPath', () => {
  test('returns a closed 7-point loop (last == first)', () => {
    const path = unitHexOutlineRingPath();
    assert.equal(path.length, 7);
    // i=6 trig drifts by ≤ 1e-9 vs i=0; close-enough comparison.
    const closeEnough = (a, b) =>
      Math.abs(a.x - b.x) < 1e-9 &&
      Math.abs(a.y - b.y) < 1e-9 &&
      Math.abs(a.z - b.z) < 1e-9;
    assert.ok(closeEnough(path[0], path[6]),
      'first and last vertex must coincide so the tube closes seamlessly');
  });

  test('every vertex lies on the configured Y plane', () => {
    const path = unitHexOutlineRingPath();
    for (const p of path) {
      assert.equal(p.y, UNIT_HEX_OUTLINE_Y,
        `vertex Y ${p.y} must equal UNIT_HEX_OUTLINE_Y ${UNIT_HEX_OUTLINE_Y}`);
    }
  });

  test('every vertex sits on a circle of UNIT_HEX_OUTLINE_RING_R from the origin', () => {
    const path = unitHexOutlineRingPath();
    const expected = UNIT_HEX_OUTLINE_RING_R;
    for (const p of path) {
      const r = Math.hypot(p.x, p.z);
      assert.ok(Math.abs(r - expected) < 1e-9,
        `vertex radius ${r} drifts from UNIT_HEX_OUTLINE_RING_R ${expected}`);
    }
  });

  test('ring radius sits inside HIGHLIGHT_OUTER_R so the outline + move-highlight read as nested bands', () => {
    // When a unit stands on its own valid-move source hex (a corner case
    // because source hexes are usually NOT highlighted, but still — guards
    // against future overlap), the per-unit outline (UNIT_HEX_OUTLINE_RING_R)
    // must visibly nest inside the move-highlight ring (HIGHLIGHT_OUTER_R)
    // rather than fighting it for the same band of pixels.
    assert.ok(UNIT_HEX_OUTLINE_RING_R < HIGHLIGHT_OUTER_R * HEX_RADIUS_WORLD,
      `UNIT_HEX_OUTLINE_RING_R ${UNIT_HEX_OUTLINE_RING_R} must be < HIGHLIGHT_OUTER_R ${HIGHLIGHT_OUTER_R}`);
  });

  test('honours a custom radius + Y override', () => {
    const path = unitHexOutlineRingPath(0.5, 0.42);
    assert.equal(path.length, 7);
    for (const p of path) {
      assert.equal(p.y, 0.42);
      assert.ok(Math.abs(Math.hypot(p.x, p.z) - 0.5) < 1e-9);
    }
  });
});

// ── Thin vs thick tube radius ───────────────────────────────────────────────

describe('Renderer3D — outline tube radii', () => {
  test('thick tube is strictly larger than thin (selection thickens the ring)', () => {
    assert.ok(UNIT_HEX_OUTLINE_THICK_TUBE > UNIT_HEX_OUTLINE_THIN_TUBE,
      `thick ${UNIT_HEX_OUTLINE_THICK_TUBE} must exceed thin ${UNIT_HEX_OUTLINE_THIN_TUBE}`);
  });

  test('both tube radii are positive', () => {
    assert.ok(UNIT_HEX_OUTLINE_THIN_TUBE  > 0);
    assert.ok(UNIT_HEX_OUTLINE_THICK_TUBE > 0);
  });

  test('thin tube stays slim enough to read as an outline (≤ 0.05)', () => {
    // A "thin" ring at world scale should not approach the thick variant's
    // 0.06 baseline; if this trips, the thin/thick contrast has eroded and
    // selecting a unit no longer reads as a distinct thickening.
    assert.ok(UNIT_HEX_OUTLINE_THIN_TUBE <= 0.05,
      `thin tube radius ${UNIT_HEX_OUTLINE_THIN_TUBE} should stay slim`);
  });
});

// ── Emissive caps ───────────────────────────────────────────────────────────

describe('Renderer3D — outline emissive caps', () => {
  test('selected outline emissive ≤ 0.6 × diffuse so the GlowLayer bloom stays tinted', () => {
    // Mirrors the NODE_DISC_EMISSIVE_MUL convention: above ~0.6 the brightest
    // diffuse channels saturate through the bloom and the ring washes to
    // white instead of carrying the owner colour.
    assert.ok(UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL > 0 && UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL <= 0.6,
      `glow emissive mul ${UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL} out of band (0, 0.6]`);
  });

  test('thin outline emissive is dimmer than the selected glow so non-selected rings do not look lit', () => {
    assert.ok(UNIT_HEX_OUTLINE_THIN_EMISSIVE_MUL < UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL,
      `thin emissive ${UNIT_HEX_OUTLINE_THIN_EMISSIVE_MUL} should be dimmer than selected ${UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL}`);
  });

  test('thin outline emissive is non-zero so the ring stays legible against dark terrain', () => {
    assert.ok(UNIT_HEX_OUTLINE_THIN_EMISSIVE_MUL > 0,
      'thin outline should carry SOME emissive so dim phases still show the ring');
  });
});

// ── Owner-colour delegation ─────────────────────────────────────────────────

describe('Renderer3D — unitHexOutlineColor', () => {
  test('returns the entity color when set (per-player tint takes priority)', () => {
    const e = { color: '#a020f0', owner: 'witch' };
    assert.equal(unitHexOutlineColor(e), '#a020f0');
    // And matches the standee base colour — outline + token must stay in sync.
    assert.equal(unitHexOutlineColor(e), entityBaseColor(e));
  });

  test('falls back to the faction theme primary when no entity color', () => {
    const e = { owner: 'hero' };
    const c = unitHexOutlineColor(e);
    assert.equal(typeof c, 'string');
    assert.equal(c, entityBaseColor(e));
  });

  test('returns the neutral grey for stray entities with no owner / colour', () => {
    assert.equal(unitHexOutlineColor({}), '#888888');
    assert.equal(unitHexOutlineColor(null), '#888888');
    assert.equal(unitHexOutlineColor(undefined), '#888888');
  });
});
