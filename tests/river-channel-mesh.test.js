// Pure geometry tests for the per-tile river channel mesh (no Babylon/DOM).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRiverChannelGeometry, classifyRiverEdges, RIVER_SHAPES,
  CHANNEL_BED_Y,
} from '../src/river-channel-mesh.js';

const HEX_AREA = (3 * Math.sqrt(3) / 2); // regular hexagon, radius 1 ≈ 2.598

function tris(positions, idx) {
  const out = [];
  for (let i = 0; i < idx.length; i += 3) {
    const p = (k) => [positions[idx[i + k] * 3], positions[idx[i + k] * 3 + 1], positions[idx[i + k] * 3 + 2]];
    out.push([p(0), p(1), p(2)]);
  }
  return out;
}
// XZ-projected absolute triangle area.
const triAreaXZ = (t) => Math.abs(
  (t[1][0] - t[0][0]) * (t[2][2] - t[0][2]) - (t[2][0] - t[0][0]) * (t[1][2] - t[0][2]),
) / 2;

for (const [name, { entryEdge, exitEdge }] of Object.entries(RIVER_SHAPES)) {
  describe(`buildRiverChannelGeometry — ${name}`, () => {
    const g = buildRiverChannelGeometry(entryEdge, exitEdge);

    test('every submesh has triangles', () => {
      assert.ok(g.grass.length >= 3 && g.grass.length % 3 === 0, 'grass');
      assert.ok(g.bank.length  >= 3 && g.bank.length  % 3 === 0, 'bank');
      assert.ok(g.river.length >= 3 && g.river.length % 3 === 0, 'river');
    });

    test('grass top is coplanar at Y=0; river bed is flat at BED_Y', () => {
      for (const t of tris(g.positions, g.grass)) for (const v of t) {
        assert.ok(Math.abs(v[1]) < 1e-9, `grass vert Y=${v[1]} should be 0`);
      }
      for (const t of tris(g.positions, g.river)) for (const v of t) {
        assert.ok(Math.abs(v[1] - CHANNEL_BED_Y) < 1e-9, `river vert Y=${v[1]} should be ${CHANNEL_BED_Y}`);
      }
    });

    test('bank walls span from the grass rim (Y=0) down to the bed (Y=BED_Y)', () => {
      let sawTop = false, sawBed = false;
      for (const t of tris(g.positions, g.bank)) for (const v of t) {
        if (Math.abs(v[1]) < 1e-9) sawTop = true;
        if (Math.abs(v[1] - CHANNEL_BED_Y) < 1e-9) sawBed = true;
      }
      assert.ok(sawTop && sawBed, 'bank should touch both the rim and the bed');
    });

    test('no degenerate triangles in any submesh', () => {
      for (const key of ['grass', 'bank', 'river']) {
        for (const t of tris(g.positions, g[key])) {
          const e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
          const e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
          const cx = e1[1] * e2[2] - e1[2] * e2[1];
          const cy = e1[2] * e2[0] - e1[0] * e2[2];
          const cz = e1[0] * e2[1] - e1[1] * e2[0];
          assert.ok(Math.hypot(cx, cy, cz) > 1e-6, `${key} has a degenerate triangle`);
        }
      }
    });

    test('the whole mesh tiles the hex exactly in XZ (no gaps / overlaps)', () => {
      let area = 0;
      for (const key of ['grass', 'bank', 'river']) {
        for (const t of tris(g.positions, g[key])) area += triAreaXZ(t);
      }
      // Grass + bank-footprint + river-footprint should cover the hex once.
      assert.ok(Math.abs(area - HEX_AREA) < 0.05,
        `XZ coverage ${area.toFixed(3)} should ≈ hex area ${HEX_AREA.toFixed(3)}`);
    });

    test('all six hex corners are present at Y=0 (perimeter stays coplanar)', () => {
      for (let k = 0; k < 6; k++) {
        const a = (30 + 60 * k) * Math.PI / 180;
        const cx = Math.cos(a), cz = Math.sin(a);
        let found = false;
        for (let i = 0; i < g.positions.length; i += 3) {
          if (Math.abs(g.positions[i] - cx) < 1e-6 &&
              Math.abs(g.positions[i + 1]) < 1e-9 &&
              Math.abs(g.positions[i + 2] - cz) < 1e-6) { found = true; break; }
        }
        assert.ok(found, `corner ${k} missing from the mesh`);
      }
    });
  });
}

describe('classifyRiverEdges', () => {
  test('opposite edges → straight', () => {
    assert.deepEqual(classifyRiverEdges(0, 3), { shape: 'straight', rot: 0 });
    assert.equal(classifyRiverEdges(1, 4).shape, 'straight');
    assert.equal(classifyRiverEdges(2, 5).shape, 'straight');
  });
  test('±120° → a gentle bend either way (one template, rotated)', () => {
    assert.deepEqual(classifyRiverEdges(0, 2), { shape: 'bend', rot: 0 });
    assert.equal(classifyRiverEdges(0, 4).shape, 'bend'); // mirror = same template rotated
    // The rotation must actually land the canonical bend (0,2) on the real edges.
    const { rot } = classifyRiverEdges(0, 4);
    assert.deepEqual([(0 + rot) % 6, (2 + rot) % 6].sort(), [0, 4].sort());
  });
  test('order-independent', () => {
    assert.equal(classifyRiverEdges(2, 0).shape, 'bend'); // same pair, reversed
  });
  test('sharp (adjacent) or same edge → null (never generated)', () => {
    assert.equal(classifyRiverEdges(0, 1), null);
    assert.equal(classifyRiverEdges(3, 3), null);
  });
});
