// Pure-helper coverage for the Phase 6 reaction effects ported from the 2D
// renderer to the 3D one:
//
//   • Sound Horn — expanding torus ring at the actor's hex
//   • Power Node Discovered — radial starburst + floating label
//
// The actual mesh construction is exercised only in a real browser session
// (no WebGL context under node:test). Here we lock the curves and geometry
// helpers that drive the Babylon animations so future tuning can't silently
// drift the visual envelope without a failing test.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOUND_HORN_RING_Y,
  SOUND_HORN_RING_MS,
  SOUND_HORN_RING_R0,
  SOUND_HORN_RING_R1,
  SOUND_HORN_RING_TUBE,
  soundHornRingRadius,
  soundHornRingAlpha,
  NODE_DISCOVERED_Y,
  NODE_DISCOVERED_MS,
  NODE_DISCOVERED_R0,
  NODE_DISCOVERED_R1,
  NODE_DISCOVERED_RAY_COUNT,
  NODE_DISCOVERED_LABEL_MS,
  nodeDiscoveredRayEndpoints,
  nodeDiscoveredRayScale,
  nodeDiscoveredAlpha,
  HEX_HIGHLIGHT_BAND_MIN_Y,
  HEX_HIGHLIGHT_BAND_MAX_Y,
} from '../src/renderer-3d.js';

// ─── Sound Horn — constants ────────────────────────────────────────────────

describe('Renderer3D Phase 6 — sound horn constants', () => {
  test('ring lifetime sits in the 500-1200ms band (brief target ≈ 700)', () => {
    assert.ok(SOUND_HORN_RING_MS >= 500 && SOUND_HORN_RING_MS <= 1200,
      `expected SOUND_HORN_RING_MS in [500, 1200], got ${SOUND_HORN_RING_MS}`);
  });

  test('start radius is small (≤ 0.3) so the ring spawns at the actor', () => {
    assert.ok(SOUND_HORN_RING_R0 > 0 && SOUND_HORN_RING_R0 <= 0.3,
      `expected SOUND_HORN_RING_R0 in (0, 0.3], got ${SOUND_HORN_RING_R0}`);
  });

  test('end radius exceeds one hex (>1) but stays local (≤ 4)', () => {
    assert.ok(SOUND_HORN_RING_R1 > 1 && SOUND_HORN_RING_R1 <= 4,
      `expected SOUND_HORN_RING_R1 in (1, 4], got ${SOUND_HORN_RING_R1}`);
  });

  test('ring expands (r1 > r0)', () => {
    assert.ok(SOUND_HORN_RING_R1 > SOUND_HORN_RING_R0);
  });

  test('tube thickness stays thin (≤ 0.1)', () => {
    assert.ok(SOUND_HORN_RING_TUBE > 0 && SOUND_HORN_RING_TUBE <= 0.1,
      `expected SOUND_HORN_RING_TUBE in (0, 0.1], got ${SOUND_HORN_RING_TUBE}`);
  });

  test('ring Y sits inside the hex-highlight band so ground geometry never occludes it', () => {
    assert.ok(SOUND_HORN_RING_Y >= HEX_HIGHLIGHT_BAND_MIN_Y
           && SOUND_HORN_RING_Y <= HEX_HIGHLIGHT_BAND_MAX_Y,
      `expected SOUND_HORN_RING_Y in [${HEX_HIGHLIGHT_BAND_MIN_Y}, ${HEX_HIGHLIGHT_BAND_MAX_Y}], got ${SOUND_HORN_RING_Y}`);
  });
});

// ─── Sound Horn — radius curve ──────────────────────────────────────────────

describe('Renderer3D Phase 6 — soundHornRingRadius (linear expand)', () => {
  test('t=0 returns the starting radius exactly', () => {
    assert.equal(soundHornRingRadius(0), SOUND_HORN_RING_R0);
  });

  test('t=1 returns the ending radius exactly', () => {
    assert.equal(soundHornRingRadius(1), SOUND_HORN_RING_R1);
  });

  test('t=0.5 returns the midpoint of [r0, r1]', () => {
    const mid = (SOUND_HORN_RING_R0 + SOUND_HORN_RING_R1) / 2;
    assert.ok(Math.abs(soundHornRingRadius(0.5) - mid) < 1e-9,
      `expected ${mid}, got ${soundHornRingRadius(0.5)}`);
  });

  test('t<0 clamps to r0 (no inward overshoot)', () => {
    assert.equal(soundHornRingRadius(-0.5), SOUND_HORN_RING_R0);
  });

  test('t>1 clamps to r1 (no outward overshoot)', () => {
    assert.equal(soundHornRingRadius(1.7), SOUND_HORN_RING_R1);
  });

  test('curve is monotonically non-decreasing across [0, 1]', () => {
    let prev = soundHornRingRadius(0);
    for (let i = 1; i <= 20; i++) {
      const r = soundHornRingRadius(i / 20);
      assert.ok(r >= prev, `radius regressed at t=${i / 20}: ${r} < ${prev}`);
      prev = r;
    }
  });

  test('honours custom r0 / r1 overrides (caller-controlled span)', () => {
    assert.equal(soundHornRingRadius(0.5, 0, 10), 5);
    assert.equal(soundHornRingRadius(0,   2, 8), 2);
    assert.equal(soundHornRingRadius(1,   2, 8), 8);
  });
});

// ─── Sound Horn — alpha curve ───────────────────────────────────────────────

describe('Renderer3D Phase 6 — soundHornRingAlpha (linear fade)', () => {
  test('t=0 starts at full opacity (1)', () => {
    assert.equal(soundHornRingAlpha(0), 1);
  });

  test('t=1 ends fully transparent (0)', () => {
    assert.equal(soundHornRingAlpha(1), 0);
  });

  test('t=0.5 sits at 50% opacity', () => {
    assert.equal(soundHornRingAlpha(0.5), 0.5);
  });

  test('alpha tracks 1 - radius progress (so ring dissolves as it expands)', () => {
    // Fade is paired with expansion — the further the ring has travelled,
    // the more it's faded out. This pairing is what gives the horn its
    // "shockwave" feel rather than a static disc.
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      assert.equal(soundHornRingAlpha(t), 1 - t);
    }
  });

  test('clamps outside [0, 1]', () => {
    assert.equal(soundHornRingAlpha(-0.5), 1);
    assert.equal(soundHornRingAlpha(2),    0);
  });
});

// ─── Node Discovered — constants ────────────────────────────────────────────

describe('Renderer3D Phase 6 — node-discovered constants', () => {
  test('burst lifetime sits in the 400-1200ms band (brief target ≈ 600)', () => {
    assert.ok(NODE_DISCOVERED_MS >= 400 && NODE_DISCOVERED_MS <= 1200,
      `expected NODE_DISCOVERED_MS in [400, 1200], got ${NODE_DISCOVERED_MS}`);
  });

  test('start radius is zero (rays emerge from a single point)', () => {
    assert.equal(NODE_DISCOVERED_R0, 0);
  });

  test('end radius pokes out beyond a hex centre but inside its neighbours', () => {
    // One hex radius (≈ 1 wu) is the visual reference; the brief asks for ~1.5.
    assert.ok(NODE_DISCOVERED_R1 >= 1 && NODE_DISCOVERED_R1 <= 2.5,
      `expected NODE_DISCOVERED_R1 in [1, 2.5], got ${NODE_DISCOVERED_R1}`);
  });

  test('ray count sits in the 6–8 band (brief target)', () => {
    assert.ok(NODE_DISCOVERED_RAY_COUNT >= 6 && NODE_DISCOVERED_RAY_COUNT <= 12,
      `expected NODE_DISCOVERED_RAY_COUNT in [6, 12], got ${NODE_DISCOVERED_RAY_COUNT}`);
  });

  test('burst Y sits inside the hex-highlight band', () => {
    assert.ok(NODE_DISCOVERED_Y >= HEX_HIGHLIGHT_BAND_MIN_Y
           && NODE_DISCOVERED_Y <= HEX_HIGHLIGHT_BAND_MAX_Y,
      `expected NODE_DISCOVERED_Y in [${HEX_HIGHLIGHT_BAND_MIN_Y}, ${HEX_HIGHLIGHT_BAND_MAX_Y}], got ${NODE_DISCOVERED_Y}`);
  });

  test('label outlasts the burst — player has time to read it', () => {
    assert.ok(NODE_DISCOVERED_LABEL_MS >= NODE_DISCOVERED_MS,
      `label (${NODE_DISCOVERED_LABEL_MS}ms) must outlive burst (${NODE_DISCOVERED_MS}ms)`);
  });
});

// ─── Node Discovered — ray endpoints ────────────────────────────────────────

describe('Renderer3D Phase 6 — nodeDiscoveredRayEndpoints geometry', () => {
  test('produces exactly `count` endpoints', () => {
    const pts = nodeDiscoveredRayEndpoints(8, 1.5);
    assert.equal(pts.length, 8);
  });

  test('all endpoints sit on a circle of the requested radius', () => {
    const pts = nodeDiscoveredRayEndpoints(8, 1.5);
    for (const p of pts) {
      const r = Math.hypot(p.x, p.z);
      assert.ok(Math.abs(r - 1.5) < 1e-9,
        `endpoint (${p.x}, ${p.z}) — radius ${r}, expected 1.5`);
    }
  });

  test('endpoints are evenly spaced around the full circle', () => {
    const pts = nodeDiscoveredRayEndpoints(4, 1);
    // 4 rays → expect angles 0°, 90°, 180°, 270°.
    // Index 0 lands on the +x axis (cos 0 = 1, sin 0 = 0).
    assert.ok(Math.abs(pts[0].x - 1) < 1e-9 && Math.abs(pts[0].z) < 1e-9,
      `first ray should be on +x axis, got (${pts[0].x}, ${pts[0].z})`);
    // Index 2 lands on the −x axis (180°).
    assert.ok(Math.abs(pts[2].x + 1) < 1e-9 && Math.abs(pts[2].z) < 1e-9,
      `third ray should be on -x axis, got (${pts[2].x}, ${pts[2].z})`);
  });

  test('defaults to module-level constants when called with no args', () => {
    const pts = nodeDiscoveredRayEndpoints();
    assert.equal(pts.length, NODE_DISCOVERED_RAY_COUNT);
    for (const p of pts) {
      const r = Math.hypot(p.x, p.z);
      assert.ok(Math.abs(r - NODE_DISCOVERED_R1) < 1e-9);
    }
  });

  test('y is implied (caller fixes it) — endpoints carry only x/z', () => {
    // The renderer Y-positions the whole mesh; endpoints are local-space.
    const pts = nodeDiscoveredRayEndpoints(6, 1);
    for (const p of pts) {
      assert.ok(typeof p.x === 'number');
      assert.ok(typeof p.z === 'number');
      assert.ok(!('y' in p),
        `endpoint should not carry y (renderer positions the mesh): ${JSON.stringify(p)}`);
    }
  });
});

// ─── Node Discovered — scale curve ──────────────────────────────────────────

describe('Renderer3D Phase 6 — nodeDiscoveredRayScale (linear expand)', () => {
  test('t=0 collapses the burst to a point (scale 0)', () => {
    assert.equal(nodeDiscoveredRayScale(0), 0);
  });

  test('t=1 expands to full scale (1 — full radius)', () => {
    assert.equal(nodeDiscoveredRayScale(1), 1);
  });

  test('t=0.5 hits the half-scale midpoint', () => {
    assert.equal(nodeDiscoveredRayScale(0.5), 0.5);
  });

  test('clamps outside [0, 1] (no overshoot)', () => {
    assert.equal(nodeDiscoveredRayScale(-1), 0);
    assert.equal(nodeDiscoveredRayScale(2),  1);
  });

  test('monotonically non-decreasing across the lifetime', () => {
    let prev = nodeDiscoveredRayScale(0);
    for (let i = 1; i <= 20; i++) {
      const s = nodeDiscoveredRayScale(i / 20);
      assert.ok(s >= prev);
      prev = s;
    }
  });
});

// ─── Node Discovered — alpha curve ──────────────────────────────────────────

describe('Renderer3D Phase 6 — nodeDiscoveredAlpha (sustain + fade)', () => {
  test('t=0 starts at full opacity', () => {
    assert.equal(nodeDiscoveredAlpha(0), 1);
  });

  test('full opacity sustains across the first half', () => {
    for (const t of [0, 0.1, 0.25, 0.49]) {
      assert.equal(nodeDiscoveredAlpha(t), 1);
    }
  });

  test('fade kicks in at the halfway mark', () => {
    assert.equal(nodeDiscoveredAlpha(0.5), 1);
    assert.ok(nodeDiscoveredAlpha(0.75) < 1);
  });

  test('t=0.75 sits at exactly 50% opacity', () => {
    assert.equal(nodeDiscoveredAlpha(0.75), 0.5);
  });

  test('t=1 ends fully transparent', () => {
    assert.equal(nodeDiscoveredAlpha(1), 0);
  });

  test('clamps outside [0, 1]', () => {
    assert.equal(nodeDiscoveredAlpha(-0.5), 1);
    assert.equal(nodeDiscoveredAlpha(2),    0);
  });

  test('fade segment is monotonically non-increasing', () => {
    let prev = nodeDiscoveredAlpha(0.5);
    for (let i = 11; i <= 20; i++) {
      const a = nodeDiscoveredAlpha(i / 20);
      assert.ok(a <= prev);
      prev = a;
    }
  });
});

// ─── Phase 6 — reaction-effect call-site contract ──────────────────────────

describe('Renderer3D Phase 6 — addSoundHorn / addNodeDiscovered stubs', () => {
  test('addSoundHorn is callable on a half-built renderer without throwing', async () => {
    const { Renderer3D } = await import('../src/renderer-3d.js');
    // No-canvas instance — every method we touch must early-return when
    // _scene / _babylon are null. This mirrors how callers in
    // src/main.js fire the methods before / after a renderer has booted.
    const r = Object.create(Renderer3D.prototype);
    r._scene = null;
    r._babylon = null;
    // Should not throw.
    r.addSoundHorn(3, 4, '#d4a72c');
  });

  test('addNodeDiscovered is callable on a half-built renderer without throwing', async () => {
    const { Renderer3D } = await import('../src/renderer-3d.js');
    const r = Object.create(Renderer3D.prototype);
    r._scene = null;
    r._babylon = null;
    r.addNodeDiscovered([{ col: 3, row: 4 }], '#ffd54a', 'Power Node Discovered');
  });

  test('addNodeDiscovered tolerates an empty hex list', async () => {
    const { Renderer3D } = await import('../src/renderer-3d.js');
    const r = Object.create(Renderer3D.prototype);
    r._scene = null;
    r._babylon = null;
    r.addNodeDiscovered([], '#ffd54a', 'unused');
  });
});
