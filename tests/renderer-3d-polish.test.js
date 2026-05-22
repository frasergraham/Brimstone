// Playtest-polish coverage — locks down the pure logic introduced by the
// "fix(3d): playtest polish" pass. The Babylon-touching bits (mesh creation,
// material setup, camera animation) still aren't runnable under node-test, so
// each fix has a pure helper extracted from the change so its math + decisions
// can be verified without WebGL.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hexToWorld,
  bridgeRotationY,
  computePlanGhostPaths,
  planGhostPose,
  PLAN_GHOST_STEP_MS,
  PLAN_GHOST_FADE_MS,
  PLAN_DISC_Y,
  PLAN_DISC_ALPHA,
  PLAN_GHOST_ALPHA,
  BUILDING_OFFSET,
  SELECTION_FOCUS_RADIUS,
  PHASE_LIGHT_CONFIG,
  getPhaseLightConfig,
} from '../src/renderer-3d.js';
import { TileType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { Phase } from '../src/game.js';

// ── Bridge rotation (item 8) ────────────────────────────────────────────────

describe('Renderer3D polish — bridgeRotationY', () => {
  // Helper: build a Map<hexKey, Tile> from a flat list of {col,row,type} tiles
  // so the helper can look up water neighbours.
  function buildTileMap(tiles) {
    const m = new Map();
    for (const t of tiles) m.set(hexKey(t.col, t.row), t);
    return m;
  }

  test('returns 0 when the bridge has no water neighbours (defensive)', () => {
    const bridge = { col: 5, row: 5, type: TileType.BRIDGE };
    const tiles  = buildTileMap([bridge]);
    assert.equal(bridgeRotationY(bridge, tiles), 0);
  });

  test('plank long axis is perpendicular to a vertical river through hex', () => {
    // Pointy-top odd-r: neighbours (col, row-1) and (col, row+1) for even row
    // share the same X (river runs along world Z). Plank's local +X axis must
    // end up perpendicular — pointing along ±X (rotation.y ≡ 0 mod π).
    const bridge = { col: 4, row: 4, type: TileType.BRIDGE };
    const n1     = { col: 4, row: 3, type: TileType.RIVER };
    const n2     = { col: 4, row: 5, type: TileType.RIVER };
    const tiles  = buildTileMap([bridge, n1, n2]);

    const rot = bridgeRotationY(bridge, tiles);
    // post-rotation X axis: (cos rot, sin rot). We want |sin rot| ≈ 0 so X
    // remains in the world XZ-plane along ±X.
    assert.ok(Math.abs(Math.sin(rot)) < 1e-9,
      `expected plank to align ±X for vertical river; rotation ${rot}`);
  });

  test('plank long axis is perpendicular to a horizontal river', () => {
    // Even row: neighbours (col-1, row) and (col+1, row) sit on the world X
    // axis, so river flows along world X. Plank should align along world Z
    // (rotation.y ≡ ±π/2).
    const bridge = { col: 4, row: 4, type: TileType.BRIDGE };
    const n1     = { col: 3, row: 4, type: TileType.RIVER };
    const n2     = { col: 5, row: 4, type: TileType.RIVER };
    const tiles  = buildTileMap([bridge, n1, n2]);

    const rot = bridgeRotationY(bridge, tiles);
    // post-rotation X axis: (cos rot, sin rot). For ±Z alignment, cos rot ≈ 0.
    assert.ok(Math.abs(Math.cos(rot)) < 1e-9,
      `expected plank to align ±Z for horizontal river; rotation ${rot}`);
  });

  test('falls back to the single-neighbour direction when river ends at hex', () => {
    const bridge = { col: 4, row: 4, type: TileType.BRIDGE };
    const n1     = { col: 4, row: 3, type: TileType.RIVER };
    const tiles  = buildTileMap([bridge, n1]);

    // No neighbour sits directly above on the pointy-top odd-r grid, so the
    // rotation is set to make the plank perpendicular to the bridge→neighbour
    // vector. Verify perpendicularity via dot product: the plank's local +X
    // (after rotation) should be orthogonal to the river vector.
    const rot = bridgeRotationY(bridge, tiles);
    const here  = hexToWorld(bridge.col, bridge.row);
    const there = hexToWorld(n1.col, n1.row);
    const river = { x: there.x - here.x, z: there.z - here.z };
    const plankX = { x: Math.cos(rot), z: Math.sin(rot) };
    const dot = river.x * plankX.x + river.z * plankX.z;
    assert.ok(Math.abs(dot) < 1e-9,
      `plank +X axis should be perpendicular to river direction; dot ${dot}`);
  });

  test('treats BRIDGE-typed neighbours as water (river continues through bridges)', () => {
    const bridge   = { col: 4, row: 4, type: TileType.BRIDGE };
    const upstream = { col: 4, row: 3, type: TileType.RIVER };
    const adjacent = { col: 4, row: 5, type: TileType.BRIDGE };
    const tiles    = buildTileMap([bridge, upstream, adjacent]);

    const rot = bridgeRotationY(bridge, tiles);
    assert.ok(Math.abs(Math.sin(rot)) < 1e-9,
      'bridge neighbours must count as water so rivers crossing bridges still steer plank');
  });

  test('ignores non-water neighbours (grass, forest, road, building)', () => {
    const bridge = { col: 4, row: 4, type: TileType.BRIDGE };
    const grass  = { col: 3, row: 4, type: TileType.GRASS };
    const forest = { col: 5, row: 4, type: TileType.FOREST };
    const tiles  = buildTileMap([bridge, grass, forest]);

    assert.equal(bridgeRotationY(bridge, tiles), 0,
      'no water neighbours → no rotation; non-water types must not influence axis');
  });

  test('handles null tiles + missing map gracefully', () => {
    assert.equal(bridgeRotationY(null, new Map()), 0);
    assert.equal(bridgeRotationY({ col: 0, row: 0, type: TileType.BRIDGE }, null), 0);
  });

  // ── Road-based orientation (2D parity) ────────────────────────────────────
  // The 2D renderer (`src/renderer.js` _drawRoadLayer ≈L1951-1992) orients the
  // bridge along its road exits, NOT directly off the water axis. The crossing
  // pair is chosen by maximising perpendicularity-to-water. These tests lock
  // in that the 3D helper mirrors the same selection.

  // ── Road-based orientation (2D parity) ────────────────────────────────────
  // The 2D renderer (`src/renderer.js` _drawRoadLayer ≈L1951-1992) orients the
  // bridge along its road exits, NOT directly off the water axis. The crossing
  // pair is chosen by maximising perpendicularity-to-water. These tests lock
  // in that the 3D helper mirrors the same selection.

  test('road exits drive orientation: plank long axis aligns with the road', () => {
    // Bridge with river bending through NW→SW (water-avg ≈ west), road exits
    // at NE and SE (both perpendicular-ish to the average water direction).
    // The plank's long axis (+X) must align with the NE→SE line — which is
    // straight north-south in world coords (both NE and SE neighbours of an
    // even row share the same world x) → rotation.y = π/2.
    const bridge = { col: 4, row: 4, type: TileType.BRIDGE };
    bridge.roadDirs = new Set([hexKey(4, 3), hexKey(4, 5)]);
    const w1 = { col: 3, row: 3, type: TileType.RIVER }; // NW
    const w2 = { col: 3, row: 5, type: TileType.RIVER }; // SW
    const r1 = { col: 4, row: 3, type: TileType.ROAD };  // NE
    const r2 = { col: 4, row: 5, type: TileType.ROAD };  // SE
    const tiles = buildTileMap([bridge, w1, w2, r1, r2]);

    const rot = bridgeRotationY(bridge, tiles);
    // Plank +X must lie along ±Z → cos(rot) ≈ 0.
    assert.ok(Math.abs(Math.cos(rot)) < 1e-9,
      `expected plank long-axis along road (±Z); rotation ${rot}`);
  });

  test('road logic differs from water-only logic when river curves', () => {
    // Same NW→SW bending river as above, plus a road pair that the old
    // water-only heuristic would orient incorrectly. Old logic took
    // `bestPair.diff = (0, 3)` → rotation.y = atan2(3, 0) + π/2 = π → plank
    // along ±X. New logic picks the road axis (NE↔SE) → ±Z. Different.
    const bridge = { col: 4, row: 4, type: TileType.BRIDGE };
    bridge.roadDirs = new Set([hexKey(4, 3), hexKey(4, 5)]);
    const w1 = { col: 3, row: 3, type: TileType.RIVER };
    const w2 = { col: 3, row: 5, type: TileType.RIVER };
    const r1 = { col: 4, row: 3, type: TileType.ROAD };
    const r2 = { col: 4, row: 5, type: TileType.ROAD };
    const tiles = buildTileMap([bridge, w1, w2, r1, r2]);

    const rot = bridgeRotationY(bridge, tiles);
    // The OLD water-only result would be ~π (plank along ±X). The new road
    // result is π/2 (along ±Z). |cos(π/2)| = 0; |cos(π)| = 1. Ensure we are
    // NOT in the old regime.
    assert.ok(Math.abs(Math.cos(rot)) < 0.1,
      `road logic must override water-only (would be ~π); rotation ${rot}`);
  });

  test('no water + ≥2 road exits → most-opposing road pair (fallback)', () => {
    const bridge = { col: 4, row: 4, type: TileType.BRIDGE };
    bridge.roadDirs = new Set([hexKey(3, 4), hexKey(5, 4)]);
    const r1 = { col: 3, row: 4, type: TileType.ROAD };
    const r2 = { col: 5, row: 4, type: TileType.ROAD };
    const tiles = buildTileMap([bridge, r1, r2]);

    const rot = bridgeRotationY(bridge, tiles);
    // r1↔r2 are opposite along ±X, so plank +X should align ±X → sin(rot)≈0.
    assert.ok(Math.abs(Math.sin(rot)) < 1e-9,
      `expected plank to align ±X for opposite road pair; rotation ${rot}`);
  });

  test('single road exit → falls back to water-perpendicular heuristic', () => {
    // One road exit can't define a crossing axis; fall through to the
    // water-based orientation. Water is horizontal (W, E neighbours), so the
    // plank should align perpendicular to the river → along ±Z (cos≈0).
    const bridge = { col: 4, row: 4, type: TileType.BRIDGE };
    bridge.roadDirs = new Set([hexKey(4, 3)]);
    const w1 = { col: 3, row: 4, type: TileType.RIVER };
    const w2 = { col: 5, row: 4, type: TileType.RIVER };
    const r1 = { col: 4, row: 3, type: TileType.ROAD };
    const tiles = buildTileMap([bridge, w1, w2, r1]);

    const rot = bridgeRotationY(bridge, tiles);
    assert.ok(Math.abs(Math.cos(rot)) < 1e-9,
      `single-road fallback should orient perpendicular to horizontal river; rotation ${rot}`);
  });
});

// ── Plan ghost path computation (item 6) ────────────────────────────────────

describe('Renderer3D polish — computePlanGhostPaths', () => {
  test('returns empty map for null / non-array input', () => {
    assert.equal(computePlanGhostPaths(null).size, 0);
    assert.equal(computePlanGhostPaths(undefined).size, 0);
    assert.equal(computePlanGhostPaths('not-an-array').size, 0);
  });

  test('returns empty map when no steps have arrows (no MOVE actions)', () => {
    const steps = [
      { arrow: null, summonInfo: { col: 1, row: 1 } },
      { arrow: null, attackArrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 1 } },
    ];
    assert.equal(computePlanGhostPaths(steps).size, 0);
  });

  test('builds a single path per entity, prefixed with origin', () => {
    const steps = [
      { arrow: { entityId: 'h1', fromCol: 2, fromRow: 2, toCol: 3, toRow: 2 } },
      { arrow: { entityId: 'h1', fromCol: 3, fromRow: 2, toCol: 4, toRow: 2 } },
      { arrow: { entityId: 'h1', fromCol: 4, fromRow: 2, toCol: 4, toRow: 3 } },
    ];
    const paths = computePlanGhostPaths(steps);
    assert.equal(paths.size, 1);
    assert.deepEqual(paths.get('h1'), [
      { col: 2, row: 2 },
      { col: 3, row: 2 },
      { col: 4, row: 2 },
      { col: 4, row: 3 },
    ]);
  });

  test('separates paths by entity id', () => {
    const steps = [
      { arrow: { entityId: 'h1', fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } },
      { arrow: { entityId: 'h2', fromCol: 5, fromRow: 5, toCol: 5, toRow: 6 } },
      { arrow: { entityId: 'h1', fromCol: 1, fromRow: 0, toCol: 2, toRow: 0 } },
    ];
    const paths = computePlanGhostPaths(steps);
    assert.equal(paths.size, 2);
    assert.deepEqual(paths.get('h1'), [
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 },
    ]);
    assert.deepEqual(paths.get('h2'), [
      { col: 5, row: 5 }, { col: 5, row: 6 },
    ]);
  });
});

describe('Renderer3D polish — planGhostPose', () => {
  test('still ghost when path has 1 or 0 vertices (no destinations)', () => {
    for (const n of [0, 1]) {
      const pose = planGhostPose(0, n);
      assert.equal(pose.segment, 0);
      assert.equal(pose.segT, 0);
      assert.equal(pose.alpha, 1);
    }
  });

  test('start of cycle: ghost sits at origin (segment 0, segT 0, alpha 1)', () => {
    const pose = planGhostPose(0, 3); // 2 segments
    assert.equal(pose.segment, 0);
    assert.equal(pose.segT, 0);
    assert.equal(pose.alpha, 1);
  });

  test('mid-segment progress reads back the within-segment t correctly', () => {
    const pose = planGhostPose(PLAN_GHOST_STEP_MS / 2, 3);
    assert.equal(pose.segment, 0);
    assert.ok(Math.abs(pose.segT - 0.5) < 1e-9);
    assert.equal(pose.alpha, 1);
  });

  test('advancing past a segment boundary moves to the next segment', () => {
    const pose = planGhostPose(PLAN_GHOST_STEP_MS + 1, 3);
    assert.equal(pose.segment, 1);
    assert.ok(pose.segT > 0 && pose.segT < 1);
    assert.equal(pose.alpha, 1);
  });

  test('fade phase: ghost holds at last destination and alpha lerps to 0', () => {
    const segCount = 2;
    const walkTotal = segCount * PLAN_GHOST_STEP_MS;
    // Halfway through fade
    const pose = planGhostPose(walkTotal + PLAN_GHOST_FADE_MS / 2, segCount + 1);
    assert.equal(pose.segment, segCount - 1);
    assert.equal(pose.segT, 1);
    assert.ok(pose.alpha > 0 && pose.alpha < 1,
      `mid-fade alpha ${pose.alpha} should be between 0 and 1`);
  });

  test('cycle wraps cleanly: time = 1 cycle later equals time = 0', () => {
    const segCount = 3;
    const cycle = segCount * PLAN_GHOST_STEP_MS + PLAN_GHOST_FADE_MS;
    const p0 = planGhostPose(0, segCount + 1);
    const p1 = planGhostPose(cycle, segCount + 1);
    assert.deepEqual(p0, p1);
  });

  test('negative time inputs (clock skew) map into a valid cycle position', () => {
    const pose = planGhostPose(-PLAN_GHOST_STEP_MS / 2, 3);
    // Should not throw; segment and segT must be sane.
    assert.ok(pose.segment >= 0);
    assert.ok(pose.segT >= 0 && pose.segT <= 1);
  });
});

// ── Plan-disc visual constants (item 3) ─────────────────────────────────────

describe('Renderer3D polish — plan-marker disc constants', () => {
  test('disc Y clears the tile prism top (0.075) and the road deck top (0.155)', () => {
    assert.ok(PLAN_DISC_Y > 0.155,
      `PLAN_DISC_Y ${PLAN_DISC_Y} must exceed road deck top (0.155)`);
  });

  test('disc alpha is opaque enough to read at a glance', () => {
    // Round 4: marker shrank from full-hex disc → small puck, so opacity can
    // push closer to 1.0 without obscuring terrain. Floor sanity-checks that
    // we still see the marker; ceiling is just "in (0, 1]".
    assert.ok(PLAN_DISC_ALPHA > 0 && PLAN_DISC_ALPHA <= 1.0,
      `PLAN_DISC_ALPHA ${PLAN_DISC_ALPHA} out of expected band (0, 1]`);
  });

  test('ghost alpha is more transparent than the marker so ghosts read as previews', () => {
    assert.ok(PLAN_GHOST_ALPHA <= PLAN_DISC_ALPHA,
      `ghost alpha ${PLAN_GHOST_ALPHA} should be ≤ disc alpha ${PLAN_DISC_ALPHA}`);
  });
});

// ── Building offset (item 1) ────────────────────────────────────────────────

describe('Renderer3D polish — building offset', () => {
  test('offset moves the building into a single quadrant of the hex', () => {
    // Standee disc diameter is 0.75 → radius 0.375; building shifted by 0.35
    // → centres should differ by hypot(0.35, 0.35) ≈ 0.495, larger than the
    // standee radius so the silhouettes don't overlap at hex centre.
    const d = Math.hypot(BUILDING_OFFSET.x, BUILDING_OFFSET.z);
    assert.ok(d > 0.375,
      `building offset distance ${d.toFixed(3)} must clear the standee disc radius (0.375)`);
  });

  test('offset is stable (frozen) — picking a stable direction matters for layout', () => {
    assert.ok(Object.isFrozen(BUILDING_OFFSET),
      'BUILDING_OFFSET must be Object.freeze()d so a build never mutates it accidentally');
  });
});

// ── Camera selection focus constant (item 5) ────────────────────────────────

describe('Renderer3D polish — SELECTION_FOCUS_RADIUS', () => {
  test('zoom-in target sits within the camera radius limits (4..80)', () => {
    assert.ok(SELECTION_FOCUS_RADIUS >= 4,
      `SELECTION_FOCUS_RADIUS ${SELECTION_FOCUS_RADIUS} below camera.lowerRadiusLimit (4)`);
    assert.ok(SELECTION_FOCUS_RADIUS <= 80,
      `SELECTION_FOCUS_RADIUS ${SELECTION_FOCUS_RADIUS} exceeds camera.upperRadiusLimit (80)`);
  });

  test('zoom-in radius is appreciably tighter than the upper limit', () => {
    // Otherwise selection wouldn't visibly zoom in on a full-map-fit camera.
    assert.ok(SELECTION_FOCUS_RADIUS < 40,
      `SELECTION_FOCUS_RADIUS ${SELECTION_FOCUS_RADIUS} too far out to read as a zoom-in`);
  });
});

// ── Phase lighting brightness (item 2) ──────────────────────────────────────
// Tests check that the readability bump took effect; exact values are visual
// taste and tracked by the existing assertions in renderer-3d-atmosphere.test.js.

describe('Renderer3D polish — phase lighting brightness floor', () => {
  test('every phase intensity > 0 so the hemi fill keeps shadowed areas legible', () => {
    // Hemi intensity is intentionally low across the board now — shadows from
    // the directional sun only darken the sun's contribution, so a strong
    // hemi washes them out. We still need a non-zero fill so unlit faces
    // don't go pitch black.
    for (const phase of [Phase.DAWN, Phase.DAY, Phase.DUSK, Phase.NIGHT]) {
      const cfg = getPhaseLightConfig(phase);
      assert.ok(cfg.intensity > 0,
        `phase ${phase} intensity ${cfg.intensity} must be positive`);
      assert.ok(cfg.intensity < cfg.sun.intensity * 3 || phase === Phase.NIGHT,
        `phase ${phase} hemi ${cfg.intensity} should not swamp the sun ${cfg.sun.intensity}`);
    }
  });

  test('night clear-colour is a deep blue sky (cool, low luminance — readability comes from hemi/ambient)', () => {
    // Operator chose a deep-night sky on the lighting tuner (clear ≈ (0,0.05,0.15)).
    // Tile readability is carried by hemi.intensity + ambient at night now,
    // not by the sky tint behind them — so the previous "luminance ≥ 0.5"
    // floor doesn't apply. Keep the colour-shape constraint: the sky must
    // still read as a cool blue (not warm or grey).
    const cfg = PHASE_LIGHT_CONFIG.night;
    assert.ok(cfg.clear.b >= cfg.clear.r, 'night sky blue ≥ red (cool tone)');
    assert.ok(cfg.clear.b >= cfg.clear.g, 'night sky blue ≥ green (cool tone)');
  });
});

// ── Plan ghost path → world position end-to-end smoke test ──────────────────

describe('Renderer3D polish — plan ghost path traversal', () => {
  test('ghost interpolates between hexes as time advances within a segment', () => {
    const path = [{ col: 0, row: 0 }, { col: 1, row: 0 }];
    const a = hexToWorld(path[0].col, path[0].row);
    const b = hexToWorld(path[1].col, path[1].row);

    const pStart = planGhostPose(0, path.length);
    const pMid   = planGhostPose(PLAN_GHOST_STEP_MS / 2, path.length);
    const pEnd   = planGhostPose(PLAN_GHOST_STEP_MS - 1, path.length);

    const lerp = (s, e, t) => s + (e - s) * t;
    const xStart = lerp(a.x, b.x, pStart.segT);
    const xMid   = lerp(a.x, b.x, pMid.segT);
    const xEnd   = lerp(a.x, b.x, pEnd.segT);

    assert.ok(Math.abs(xStart - a.x) < 1e-9, 'starts at origin');
    assert.ok(Math.abs(xMid - (a.x + b.x) / 2) < 1e-9, 'midpoint at hex midpoint');
    assert.ok(xEnd > xMid, 'progresses monotonically through segment');
  });
});
