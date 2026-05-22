// Quinn: targeted fix for Phase 5 plan dashed lines — raise Y, swap
// `LinesMesh` for tube dashes so the path connector renders with reliable
// thickness and no z-fight. Pure helper + tuning-constant tests; Babylon
// mesh wiring is exercised by hand in-browser.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_LINE_Y,
  PLAN_LINE_RADIUS,
  PLAN_LINE_DASH_SIZE,
  PLAN_LINE_GAP_SIZE,
  PLAN_MARKER_Y,
  PLAN_MARKER_HEIGHT,
  HIGHLIGHT_DISC_Y,
  computeDashSegments,
} from '../src/renderer-3d.js';

// ── Y placement constants ───────────────────────────────────────────────────

describe('Renderer3D plan-line — Y placement clears ground geometry', () => {
  test('PLAN_LINE_Y sits above the marker puck top with margin (no z-fight)', () => {
    const markerTop = PLAN_MARKER_Y + PLAN_MARKER_HEIGHT / 2;
    assert.ok(PLAN_LINE_Y > markerTop + 0.05,
      `PLAN_LINE_Y ${PLAN_LINE_Y} should sit ≥0.05 above marker top ${markerTop}`);
  });

  test('PLAN_LINE_Y sits above the highlight-disc layer (avoids ring fight)', () => {
    assert.ok(PLAN_LINE_Y > HIGHLIGHT_DISC_Y,
      `PLAN_LINE_Y ${PLAN_LINE_Y} should clear HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y}`);
  });

  test('PLAN_LINE_Y stays well below the floating badge (0.6) so the line still reads as ground-anchored', () => {
    assert.ok(PLAN_LINE_Y < 0.3,
      `PLAN_LINE_Y ${PLAN_LINE_Y} should not float visibly above the ground`);
  });
});

// ── Tube radius (thickness) ─────────────────────────────────────────────────

describe('Renderer3D plan-line — tube radius', () => {
  test('PLAN_LINE_RADIUS is positive and visibly thick (>0.03 wu)', () => {
    assert.ok(PLAN_LINE_RADIUS > 0.03,
      `PLAN_LINE_RADIUS ${PLAN_LINE_RADIUS} should give visible thickness`);
  });

  test('PLAN_LINE_RADIUS stays smaller than half a hex so dashes do not overlap the marker', () => {
    assert.ok(PLAN_LINE_RADIUS < 0.5,
      `PLAN_LINE_RADIUS ${PLAN_LINE_RADIUS} must be sub-hex`);
  });
});

// ── Dash period sanity ─────────────────────────────────────────────────────

describe('Renderer3D plan-line — dash + gap sizing', () => {
  test('dash + gap fit comfortably inside one hex step (~sqrt(3) ≈ 1.73 wu)', () => {
    const stepLen = Math.sqrt(3); // adjacent pointy-top hex centre distance @ radius 1
    const period = PLAN_LINE_DASH_SIZE + PLAN_LINE_GAP_SIZE;
    assert.ok(period > 0.2 && period < stepLen / 2,
      `dash+gap period ${period} should yield ≥3 chunks per hop`);
  });

  test('dash size is larger than gap (line reads as dashes, not dots)', () => {
    assert.ok(PLAN_LINE_DASH_SIZE > PLAN_LINE_GAP_SIZE,
      `dash ${PLAN_LINE_DASH_SIZE} should be > gap ${PLAN_LINE_GAP_SIZE}`);
  });
});

// ── computeDashSegments helper ─────────────────────────────────────────────

describe('Renderer3D plan-line — computeDashSegments()', () => {
  test('empty / degenerate inputs return []', () => {
    assert.deepEqual(computeDashSegments(null, { x: 1, z: 0 }, 0.3, 0.2), []);
    assert.deepEqual(computeDashSegments({ x: 0, z: 0 }, null, 0.3, 0.2), []);
    assert.deepEqual(computeDashSegments({ x: 0, z: 0 }, { x: 0, z: 0 }, 0.3, 0.2), []);
    assert.deepEqual(computeDashSegments({ x: 0, z: 0 }, { x: 1, z: 0 }, 0, 0.2), []);
  });

  test('axis-aligned segment splits into the expected number of dashes', () => {
    // Length 2.0, dash 0.4, gap 0.2 → period 0.6 → offsets 0, 0.6, 1.2, 1.8.
    // At offset 1.8 the remaining run is 0.2 < dash → trimmed to a 0.2 stub
    // which is < 0.4 * 0.25 = 0.1 false — 0.2 ≥ 0.1, so it IS kept. So:
    // dashes at [0..0.4], [0.6..1.0], [1.2..1.6], [1.8..2.0] = 4 dashes.
    const segs = computeDashSegments({ x: 0, z: 0 }, { x: 2, z: 0 }, 0.4, 0.2, 0.18);
    assert.equal(segs.length, 4);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(segs[0].start.x, 0));
    assert.ok(near(segs[0].end.x,   0.4));
    assert.ok(near(segs[1].start.x, 0.6));
    assert.ok(near(segs[3].end.x,   2));
  });

  test('all segments inherit the supplied Y plane', () => {
    const segs = computeDashSegments({ x: 0, z: 0 }, { x: 3, z: 0 }, 0.3, 0.2, 0.42);
    for (const { start, end } of segs) {
      assert.equal(start.y, 0.42);
      assert.equal(end.y,   0.42);
    }
  });

  test('diagonal segment: dash start/end lie on the original line and respect distances', () => {
    // p1 → p2 covers 5 units at angle atan(4/3) ≈ 53°. Dash 1.0 / gap 0.5.
    const p1 = { x: 0, z: 0 };
    const p2 = { x: 3, z: 4 };
    const segs = computeDashSegments(p1, p2, 1.0, 0.5);
    const total = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const ux = (p2.x - p1.x) / total;
    const uz = (p2.z - p1.z) / total;
    for (const { start, end } of segs) {
      // each end is exactly along the (ux,uz) unit vector from p1
      const tStart = (start.x - p1.x) * ux + (start.z - p1.z) * uz;
      const tEnd   = (end.x   - p1.x) * ux + (end.z   - p1.z) * uz;
      // colinearity: perpendicular component should be ~0
      const perpStart = (start.x - p1.x) * (-uz) + (start.z - p1.z) * ux;
      const perpEnd   = (end.x   - p1.x) * (-uz) + (end.z   - p1.z) * ux;
      assert.ok(Math.abs(perpStart) < 1e-9, 'dash start lies on the segment');
      assert.ok(Math.abs(perpEnd)   < 1e-9, 'dash end lies on the segment');
      // each dash length ≤ requested dashSize (last one may be truncated)
      assert.ok(tEnd - tStart <= 1.0 + 1e-9, 'dash length ≤ dashSize');
      assert.ok(tEnd - tStart > 0,           'dash length positive');
    }
  });

  test('tiny remaining stub (< 25% of dashSize) is dropped to avoid orphan fragments', () => {
    // Length 1.05, dash 1.0, gap 0.0 → after dash 0..1.0, remainder 0.05.
    // 0.05 < 0.25 → dropped. Only one dash.
    const segs = computeDashSegments({ x: 0, z: 0 }, { x: 1.05, z: 0 }, 1.0, 0.0);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].end.x, 1.0);
  });

  test('gap=0 produces a continuous chain of dashes (no overlap, no gap)', () => {
    const segs = computeDashSegments({ x: 0, z: 0 }, { x: 2, z: 0 }, 0.5, 0);
    assert.equal(segs.length, 4);
    for (let i = 1; i < segs.length; i++) {
      assert.equal(segs[i].start.x, segs[i - 1].end.x);
    }
  });

  test('dashes never extend past p2', () => {
    const segs = computeDashSegments({ x: 0, z: 0 }, { x: 1.7, z: 0 }, 0.4, 0.2);
    const last = segs[segs.length - 1];
    assert.ok(last.end.x <= 1.7 + 1e-9, `last dash ends at ${last.end.x}, should be ≤ 1.7`);
  });
});
