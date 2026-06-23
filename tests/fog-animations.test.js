// Tests for fog-of-war animation culling:
//   _buildFogVisibleHexes — correct visible-hex set from observer units
//   _drawFlashes / _drawDeathAnims — skip animations at fogged hexes
//   _drawMoveAnims / _drawLungeAnims — skip enemy animations when both endpoints are in fog

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline helpers matching src/hex.js ──────────────────────────────────────

function hexKey(col, row) { return `${col},${row}`; }

// Axial conversion for offset coords (odd-r)
function toAxial(col, row) {
  const q = col - (row - (row & 1)) / 2;
  const r = row;
  return { q, r };
}

function hexDistance(col1, row1, col2, row2) {
  const a = toAxial(col1, row1);
  const b = toAxial(col2, row2);
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

// ── _buildFogVisibleHexes logic (pure, extracted for unit testing) ───────────

/**
 * Replicates renderer._buildFogVisibleHexes for a given set of observer entities
 * and map dimensions. Returns a Set<hexKey>.
 */
function buildFogVisibleHexes(observerOwner, entities, phase, cols, rows) {
  function sightRange(phase, isScout) {
    let base;
    switch (phase) {
      case 'day':   base = 3; break;
      case 'night': base = 1; break;
      default:      base = 2; // dawn, dusk
    }
    return base + (isScout ? 1 : 0);
  }

  const visibleSet = new Set();
  for (const e of entities) {
    if (!e.alive || e.owner !== observerOwner) continue;
    const range = sightRange(phase, e.isScout === true);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (hexDistance(col, row, e.col, e.row) <= range) {
          visibleSet.add(hexKey(col, row));
        }
      }
    }
  }
  return visibleSet;
}

// ── _buildFogVisibleHexes ───────────────────────────────────────────────────

describe('buildFogVisibleHexes', () => {
  test('hero unit at (6,5) has its own hex visible', () => {
    const entities = [{ owner: 'hero', alive: true, col: 6, row: 5 }];
    const vis = buildFogVisibleHexes('hero', entities, 'day', 13, 11);
    assert.ok(vis.has(hexKey(6, 5)), 'own hex must be visible');
  });

  test('hero sight range is 3 in day phase', () => {
    const entities = [{ owner: 'hero', alive: true, col: 6, row: 5 }];
    const vis = buildFogVisibleHexes('hero', entities, 'day', 13, 11);
    // hex exactly 3 away should be visible
    // hex (6,2) is 3 rows up — distance 3
    assert.ok(vis.has(hexKey(6, 2)), 'hex at distance 3 should be visible in day');
  });

  test('hero sight range is 1 in night phase', () => {
    const entities = [{ owner: 'hero', alive: true, col: 6, row: 5 }];
    const vis = buildFogVisibleHexes('hero', entities, 'night', 13, 11);
    // hex 2 away should NOT be visible
    assert.ok(!vis.has(hexKey(6, 3)), 'hex at distance 2 should be hidden in night');
    // hex 1 away should be visible
    assert.ok(vis.has(hexKey(6, 4)), 'hex at distance 1 should be visible in night');
  });

  test('scout gets +1 range', () => {
    const normalEntities = [{ owner: 'hero', alive: true, col: 6, row: 5, isScout: false }];
    const scoutEntities  = [{ owner: 'hero', alive: true, col: 6, row: 5, isScout: true  }];
    const visNormal = buildFogVisibleHexes('hero', normalEntities, 'dusk', 13, 11);
    const visScout  = buildFogVisibleHexes('hero', scoutEntities,  'dusk', 13, 11);
    // dusk base = 2; scout = 3
    // Find a hex at distance exactly 3 from (6,5)
    assert.ok(!visNormal.has(hexKey(6, 2)), 'distance-3 hex hidden for normal unit at dusk');
    assert.ok(visScout.has(hexKey(6, 2)),   'distance-3 hex visible for scout at dusk');
  });

  test('dead entities do not contribute sight', () => {
    const entities = [{ owner: 'hero', alive: false, col: 6, row: 5 }];
    const vis = buildFogVisibleHexes('hero', entities, 'day', 13, 11);
    assert.strictEqual(vis.size, 0, 'dead entity should not expand visible set');
  });

  test('witch units are ignored when observerOwner is hero', () => {
    const entities = [
      { owner: 'witch', alive: true, col: 6, row: 5 },
    ];
    const vis = buildFogVisibleHexes('hero', entities, 'day', 13, 11);
    assert.strictEqual(vis.size, 0, 'witch units should not grant hero visibility');
  });

  test('multiple hero units combine their sight ranges', () => {
    const entities = [
      { owner: 'hero', alive: true, col: 0, row: 0 },
      { owner: 'hero', alive: true, col: 12, row: 10 },
    ];
    const vis = buildFogVisibleHexes('hero', entities, 'day', 13, 11);
    assert.ok(vis.has(hexKey(0, 0)),   'first unit hex visible');
    assert.ok(vis.has(hexKey(12, 10)), 'second unit hex visible');
  });
});

// ── Flash / death anim fog culling logic ────────────────────────────────────
// Replicate the skip condition used in _drawFlashes and _drawDeathAnims.

function shouldDrawAnim(anim, fogVisibleHexes) {
  if (fogVisibleHexes !== null && !fogVisibleHexes.has(hexKey(anim.col, anim.row))) return false;
  return true;
}

describe('flash/death anim fog culling', () => {
  test('drawn when fogVisibleHexes is null (fog disabled)', () => {
    assert.ok(shouldDrawAnim({ col: 3, row: 4 }, null));
  });

  test('drawn when hex is in visible set', () => {
    const vis = new Set([hexKey(3, 4)]);
    assert.ok(shouldDrawAnim({ col: 3, row: 4 }, vis));
  });

  test('hidden when hex is NOT in visible set', () => {
    const vis = new Set([hexKey(1, 1)]);
    assert.ok(!shouldDrawAnim({ col: 3, row: 4 }, vis));
  });

  test('spawn anim at fogged hex is hidden', () => {
    const vis = new Set([hexKey(0, 0)]); // only origin visible
    const spawnAnim = { col: 8, row: 7, spawn: true }; // far away
    assert.ok(!shouldDrawAnim(spawnAnim, vis));
  });

  test('spawn anim at visible hex is shown', () => {
    const vis = new Set([hexKey(8, 7)]);
    const spawnAnim = { col: 8, row: 7, spawn: true };
    assert.ok(shouldDrawAnim(spawnAnim, vis));
  });
});

// ── Move / lunge anim fog culling logic ─────────────────────────────────────
// Replicate the skip condition used in _drawMoveAnims and _drawLungeAnims:
// skip if the entity belongs to the hidden faction AND neither endpoint is visible.

function shouldDrawMoveAnim(anim, fogVisibleHexes, hiddenOwner) {
  if (fogVisibleHexes !== null && hiddenOwner !== null && anim.owner === hiddenOwner) {
    const fromVisible = fogVisibleHexes.has(hexKey(anim.fromCol, anim.fromRow));
    const toVisible   = fogVisibleHexes.has(hexKey(anim.toCol,   anim.toRow));
    if (!fromVisible && !toVisible) return false;
  }
  return true;
}

describe('move/lunge anim fog culling', () => {
  test('drawn when fog is disabled (fogVisibleHexes null)', () => {
    const anim = { owner: 'witch', fromCol: 3, fromRow: 4, toCol: 5, toRow: 4 };
    assert.ok(shouldDrawMoveAnim(anim, null, 'witch'));
  });

  test('drawn when hiddenOwner is null (AI vs AI / spectator)', () => {
    const vis  = new Set([hexKey(0, 0)]);
    const anim = { owner: 'witch', fromCol: 3, fromRow: 4, toCol: 5, toRow: 4 };
    assert.ok(shouldDrawMoveAnim(anim, vis, null));
  });

  test('hero-owned anim is always drawn even when fog active (hero is observer)', () => {
    const vis  = new Set([hexKey(0, 0)]); // only corner visible
    const anim = { owner: 'hero', fromCol: 3, fromRow: 4, toCol: 5, toRow: 4 };
    assert.ok(shouldDrawMoveAnim(anim, vis, 'witch')); // hidden faction is witch, not hero
  });

  test('witch-owned anim hidden when both endpoints in fog', () => {
    const vis  = new Set([hexKey(0, 0)]);
    const anim = { owner: 'witch', fromCol: 3, fromRow: 4, toCol: 5, toRow: 4 };
    assert.ok(!shouldDrawMoveAnim(anim, vis, 'witch'));
  });

  test('witch-owned anim shown when from-hex is visible', () => {
    const anim = { owner: 'witch', fromCol: 3, fromRow: 4, toCol: 5, toRow: 4 };
    const vis  = new Set([hexKey(3, 4)]); // from is visible
    assert.ok(shouldDrawMoveAnim(anim, vis, 'witch'));
  });

  test('witch-owned anim shown when to-hex is visible', () => {
    const anim = { owner: 'witch', fromCol: 3, fromRow: 4, toCol: 5, toRow: 4 };
    const vis  = new Set([hexKey(5, 4)]); // to is visible
    assert.ok(shouldDrawMoveAnim(anim, vis, 'witch'));
  });

  test('witch-owned anim shown when both endpoints visible', () => {
    const anim = { owner: 'witch', fromCol: 3, fromRow: 4, toCol: 5, toRow: 4 };
    const vis  = new Set([hexKey(3, 4), hexKey(5, 4)]);
    assert.ok(shouldDrawMoveAnim(anim, vis, 'witch'));
  });
});

// ── Standee veil culling during a move animation ────────────────────────────
// Replicates the per-standee decision in _applyFogVeil. This is a SECOND fog
// layer beyond the move-anim gate above: even when a move is allowed to animate
// (origin OR destination in sight), the veil separately hides each standee
// whose metadata hex is fogged. While a unit is mid move/lunge its metadata hex
// is its DESTINATION, so a unit walking INTO fog (destination fogged) was hidden
// the instant its slide began — the move never showed, the unit just vanished.
// Fix: a unit mid-animation is never fog-hidden; at rest it follows the veil.

function shouldRenderEntityAt(target, hexK) {
  return !target ? true : target.has(hexK); // mirrors renderer-3d.js
}
function standeeVisibleUnderVeil({ target, metaHexKey, animating }) {
  return animating || shouldRenderEntityAt(target, metaHexKey);
}

describe('standee veil culling vs move animation', () => {
  const vis = new Set([hexKey(2, 2)]); // only (2,2) in the viewer's sight
  const foggedDest = hexKey(9, 5);     // a hex NOT in the visible set

  test('mid-move INTO fog stays visible — the regression', () => {
    // During the slide the standee's metadata hex is the fogged destination;
    // the animating bypass keeps it on screen so the move is actually seen.
    assert.equal(standeeVisibleUnderVeil({ target: vis, metaHexKey: foggedDest, animating: true }), true);
  });

  test('at rest in fog → hidden (veil unchanged when not animating)', () => {
    assert.equal(standeeVisibleUnderVeil({ target: vis, metaHexKey: foggedDest, animating: false }), false);
  });

  test('mid-move toward a visible hex → visible', () => {
    assert.equal(standeeVisibleUnderVeil({ target: vis, metaHexKey: hexKey(2, 2), animating: true }), true);
  });

  test('at rest on a visible hex → visible', () => {
    assert.equal(standeeVisibleUnderVeil({ target: vis, metaHexKey: hexKey(2, 2), animating: false }), true);
  });

  test('no fog (target null) → visible regardless of hex or animation', () => {
    assert.equal(standeeVisibleUnderVeil({ target: null, metaHexKey: foggedDest, animating: false }), true);
  });
});
