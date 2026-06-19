// Viv: red attack arrows + ×N target badges in planning mode (3D
// renderer parity with the 2D Layer-4 attack overlay). Pure-helper
// and constant tests — Babylon mesh wiring is exercised in-browser.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTACK_ARROW_Y,
  ATTACK_ARROW_RADIUS,
  ATTACK_ARROW_TRIM_FROM,
  ATTACK_ARROW_TRIM_TO,
  ATTACK_ARROW_HEAD_LEN,
  ATTACK_ARROW_HEAD_ANGLE,
  ATTACK_ARROW_COLOR,
  ATTACK_BADGE_Y,
  ATTACK_BADGE_SIZE,
  ATTACK_OVERLAY_GROUP,
  PLAN_LINE_Y,
  countAttacksPerTarget,
  attackBadgeLabel,
  attackBadgePosition,
  computeAttackArrowGeometry,
  hexToWorld,
  iconBillboardY,
} from '../src/renderer-3d.js';

// ── Y placement ─────────────────────────────────────────────────────────────

describe('Renderer3D attack arrow — Y placement layers above move plan', () => {
  test('ATTACK_ARROW_Y sits above PLAN_LINE_Y (battle overlays move plan)', () => {
    assert.ok(ATTACK_ARROW_Y > PLAN_LINE_Y,
      `ATTACK_ARROW_Y ${ATTACK_ARROW_Y} must clear PLAN_LINE_Y ${PLAN_LINE_Y}`);
  });

  test('ATTACK_ARROW_Y stays ground-anchored (well below badge layer)', () => {
    assert.ok(ATTACK_ARROW_Y < 0.4,
      `ATTACK_ARROW_Y ${ATTACK_ARROW_Y} should still read as ground-level`);
  });

  test('ATTACK_BADGE_Y floats above ground geometry and the arrow shaft', () => {
    assert.ok(ATTACK_BADGE_Y > ATTACK_ARROW_Y + 0.4,
      `ATTACK_BADGE_Y ${ATTACK_BADGE_Y} should clearly float above the shaft`);
  });

  test('ATTACK_BADGE_Y floats above the unit-icon billboard (non-leader)', () => {
    assert.ok(ATTACK_BADGE_Y > iconBillboardY(false),
      `ATTACK_BADGE_Y ${ATTACK_BADGE_Y} should float above the non-leader icon at ${iconBillboardY(false)}`);
  });

  test('ATTACK_BADGE_Y floats above the leader unit-icon billboard', () => {
    assert.ok(ATTACK_BADGE_Y > iconBillboardY(true),
      `ATTACK_BADGE_Y ${ATTACK_BADGE_Y} should float above the leader icon at ${iconBillboardY(true)}`);
  });
});

// ── Rendering-group z-order ─────────────────────────────────────────────────
//
// Planning-mode attack visuals (arrow tubes + ×N badges) must draw ABOVE the
// board but BELOW the unit-icon billboards — the icons (and the hit/crush %%
// painted into their badge texture) draw LAST so an arrow can never cover
// them. Babylon `renderingGroupId` groups render in ascending order; the
// overlay groups (1, 2) get a cleared depth slate so they sit on top of the
// world without depth-testing against it (see `setRenderingAutoClear-
// DepthStencil` in `_initBabylon`).
//
//   group 0  world geometry — terrain, ribbons, buildings, standees, hex
//            outlines, move arrows, plan ghosts. Depth buffer handles z-order
//            here so buildings can occlude units they sit in front of.
//   group 1  attack overlay (arrow tubes + ×N badge)
//   group 2  unit-icon billboard (+ floaters / speech bubbles) — drawn last,
//            on top of the attack overlay.
//
// Babylon's default MaxRenderingGroupId is 4 (valid range 0..3).

describe('Renderer3D attack overlay — renderingGroupId z-order', () => {
  test('ATTACK_OVERLAY_GROUP is strictly above world geometry (group 0)', () => {
    assert.ok(ATTACK_OVERLAY_GROUP > 0,
      `ATTACK_OVERLAY_GROUP ${ATTACK_OVERLAY_GROUP} must beat world geometry (group 0)`);
  });

  test('ATTACK_OVERLAY_GROUP is strictly BELOW the unit-icon billboard group (2)', () => {
    assert.ok(ATTACK_OVERLAY_GROUP < 2,
      `ATTACK_OVERLAY_GROUP ${ATTACK_OVERLAY_GROUP} must sit under the icon ` +
      `billboard (group 2) so arrows never cover the icons + hit/crush %%`);
  });

  test('ATTACK_OVERLAY_GROUP fits within Babylon\'s default MaxRenderingGroupId (≤ 3)', () => {
    assert.ok(ATTACK_OVERLAY_GROUP <= 3,
      `ATTACK_OVERLAY_GROUP ${ATTACK_OVERLAY_GROUP} must fit Babylon's default 0..3 range`);
  });

  test('ATTACK_OVERLAY_GROUP is an integer', () => {
    assert.equal(Number.isInteger(ATTACK_OVERLAY_GROUP), true);
  });
});

// ── Color, radius, head sizing ──────────────────────────────────────────────

describe('Renderer3D attack arrow — visual sizing', () => {
  test('ATTACK_ARROW_COLOR is a red CSS hex', () => {
    assert.match(ATTACK_ARROW_COLOR, /^#[0-9a-f]{6}$/i);
    const r = parseInt(ATTACK_ARROW_COLOR.slice(1, 3), 16);
    const g = parseInt(ATTACK_ARROW_COLOR.slice(3, 5), 16);
    const b = parseInt(ATTACK_ARROW_COLOR.slice(5, 7), 16);
    assert.ok(r > 150 && r > g * 2 && r > b * 2,
      `${ATTACK_ARROW_COLOR} should read as red`);
  });

  test('ATTACK_ARROW_RADIUS is positive and visible', () => {
    assert.ok(ATTACK_ARROW_RADIUS > 0.03 && ATTACK_ARROW_RADIUS < 0.5,
      `ATTACK_ARROW_RADIUS ${ATTACK_ARROW_RADIUS} should be visibly chunky but sub-hex`);
  });

  test('ATTACK_ARROW_HEAD_LEN is short enough to fit inside trim margin', () => {
    assert.ok(ATTACK_ARROW_HEAD_LEN > 0 && ATTACK_ARROW_HEAD_LEN < 0.6,
      `head length ${ATTACK_ARROW_HEAD_LEN} should be short relative to one hex`);
  });

  test('ATTACK_ARROW_HEAD_ANGLE is between 0.25 and 0.7 radians (sane wedge)', () => {
    assert.ok(ATTACK_ARROW_HEAD_ANGLE > 0.25 && ATTACK_ARROW_HEAD_ANGLE < 0.7,
      `head angle ${ATTACK_ARROW_HEAD_ANGLE} should yield an arrowhead-shaped wedge`);
  });

  test('ATTACK_BADGE_SIZE > the move-step badge (0.45) so ×N reads', () => {
    assert.ok(ATTACK_BADGE_SIZE > 0.45,
      `ATTACK_BADGE_SIZE ${ATTACK_BADGE_SIZE} should beat the move badge`);
  });
});

// ── countAttacksPerTarget ───────────────────────────────────────────────────

describe('Renderer3D attack arrow — countAttacksPerTarget()', () => {
  test('empty / non-array inputs return an empty map', () => {
    assert.equal(countAttacksPerTarget(null).size, 0);
    assert.equal(countAttacksPerTarget(undefined).size, 0);
    assert.equal(countAttacksPerTarget([]).size, 0);
    assert.equal(countAttacksPerTarget('bogus').size, 0);
  });

  test('ignores non-battle steps (MOVE / SUMMON / null)', () => {
    const steps = [
      { arrow: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 0 } },
      { summonInfo: { col: 2, row: 2, type: 'minion' } },
      { attackArrow: null },
      {},
    ];
    assert.equal(countAttacksPerTarget(steps).size, 0);
  });

  test('counts attacks against each unique target hex', () => {
    const steps = [
      { attackArrow: { fromCol: 0, fromRow: 0, toCol: 3, toRow: 3 } },
      { attackArrow: { fromCol: 1, fromRow: 1, toCol: 3, toRow: 3 } },
      { attackArrow: { fromCol: 4, fromRow: 4, toCol: 5, toRow: 5 } },
    ];
    const counts = countAttacksPerTarget(steps);
    assert.equal(counts.size, 2);
    assert.equal(counts.get('3,3'), 2);
    assert.equal(counts.get('5,5'), 1);
  });

  test('counts every attack including multiple from the same attacker', () => {
    const steps = [
      { attackArrow: { fromCol: 0, fromRow: 0, toCol: 2, toRow: 2 } },
      { attackArrow: { fromCol: 0, fromRow: 0, toCol: 2, toRow: 2 } },
      { attackArrow: { fromCol: 0, fromRow: 0, toCol: 2, toRow: 2 } },
    ];
    assert.equal(countAttacksPerTarget(steps).get('2,2'), 3);
  });
});

// ── attackBadgeLabel ────────────────────────────────────────────────────────

describe('Renderer3D attack arrow — attackBadgeLabel()', () => {
  test('1 attack renders the ⚔ glyph (single-attack hint, no ×1)', () => {
    assert.equal(attackBadgeLabel(1), '⚔');
  });

  test('2+ attacks collapse into ×N for stack-aware readout', () => {
    assert.equal(attackBadgeLabel(2), '×2');
    assert.equal(attackBadgeLabel(3), '×3');
    assert.equal(attackBadgeLabel(7), '×7');
  });
});

// ── attackBadgePosition ─────────────────────────────────────────────────────

describe('Renderer3D attack arrow — attackBadgePosition()', () => {
  test('badge floats directly above the target hex centre at ATTACK_BADGE_Y', () => {
    const target = hexToWorld(4, 3);
    const pos = attackBadgePosition(4, 3);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(pos.x, target.x), `x ${pos.x} ≠ ${target.x}`);
    assert.ok(near(pos.z, target.z), `z ${pos.z} ≠ ${target.z}`);
    assert.equal(pos.y, ATTACK_BADGE_Y);
  });

  test('explicit y override is honoured', () => {
    const pos = attackBadgePosition(1, 1, 2.5);
    assert.equal(pos.y, 2.5);
  });
});

// ── computeAttackArrowGeometry ──────────────────────────────────────────────

describe('Renderer3D attack arrow — computeAttackArrowGeometry()', () => {
  test('coincident source and target → null (degenerate zero-length arrow)', () => {
    assert.equal(computeAttackArrowGeometry(2, 2, 2, 2), null);
  });

  test('shaft endpoints sit between the two hex centres (trimmed both ends)', () => {
    const from = hexToWorld(0, 0);
    const to   = hexToWorld(3, 0);
    const geo  = computeAttackArrowGeometry(0, 0, 3, 0);
    assert.ok(geo);
    const totalLen = Math.hypot(to.x - from.x, to.z - from.z);
    const startDist = Math.hypot(geo.shaftStart.x - from.x, geo.shaftStart.z - from.z);
    const endDist   = Math.hypot(geo.shaftEnd.x   - to.x,   geo.shaftEnd.z   - to.z);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(startDist, ATTACK_ARROW_TRIM_FROM),
      `shaft start should sit ATTACK_ARROW_TRIM_FROM (${ATTACK_ARROW_TRIM_FROM}) wu from the attacker hex centre, got ${startDist}`);
    assert.ok(near(endDist, ATTACK_ARROW_TRIM_TO),
      `shaft end should sit ATTACK_ARROW_TRIM_TO (${ATTACK_ARROW_TRIM_TO}) wu from the target hex centre, got ${endDist}`);
    const shaftLen = Math.hypot(geo.shaftEnd.x - geo.shaftStart.x, geo.shaftEnd.z - geo.shaftStart.z);
    assert.ok(near(shaftLen, totalLen - ATTACK_ARROW_TRIM_FROM - ATTACK_ARROW_TRIM_TO),
      `shaft length should equal hex-to-hex distance minus both trims`);
  });

  test('all four vertices sit at ATTACK_ARROW_Y by default', () => {
    const geo = computeAttackArrowGeometry(0, 0, 2, 1);
    assert.ok(geo);
    for (const v of [geo.shaftStart, geo.shaftEnd, geo.headLeft, geo.headRight]) {
      assert.equal(v.y, ATTACK_ARROW_Y);
    }
  });

  test('explicit y override is honoured for all four vertices', () => {
    const geo = computeAttackArrowGeometry(0, 0, 2, 1, 1.25);
    assert.ok(geo);
    for (const v of [geo.shaftStart, geo.shaftEnd, geo.headLeft, geo.headRight]) {
      assert.equal(v.y, 1.25);
    }
  });

  test('head strokes spring from the shaft tip (not from elsewhere)', () => {
    const geo = computeAttackArrowGeometry(0, 0, 4, 0);
    assert.ok(geo);
    const headLen1 = Math.hypot(geo.headLeft.x  - geo.shaftEnd.x, geo.headLeft.z  - geo.shaftEnd.z);
    const headLen2 = Math.hypot(geo.headRight.x - geo.shaftEnd.x, geo.headRight.z - geo.shaftEnd.z);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(headLen1, ATTACK_ARROW_HEAD_LEN));
    assert.ok(near(headLen2, ATTACK_ARROW_HEAD_LEN));
  });

  test('head wedge is symmetric: left and right strokes mirror across the shaft axis', () => {
    // Horizontal shaft → head strokes should be mirror-symmetric about z.
    const geo = computeAttackArrowGeometry(0, 0, 5, 0);
    assert.ok(geo);
    const lx = geo.headLeft.x  - geo.shaftEnd.x;
    const rx = geo.headRight.x - geo.shaftEnd.x;
    const lz = geo.headLeft.z  - geo.shaftEnd.z;
    const rz = geo.headRight.z - geo.shaftEnd.z;
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(lx, rx),
      `head strokes should share the same backward-X component on a horizontal shaft, got ${lx} vs ${rx}`);
    assert.ok(near(lz, -rz),
      `head strokes should splay symmetrically (+z vs -z) on a horizontal shaft`);
  });

  test('head strokes point backward from the tip (negative dot with shaft direction)', () => {
    const geo = computeAttackArrowGeometry(0, 0, 4, 2);
    assert.ok(geo);
    const sx = geo.shaftEnd.x - geo.shaftStart.x;
    const sz = geo.shaftEnd.z - geo.shaftStart.z;
    const slen = Math.hypot(sx, sz);
    const ux = sx / slen;
    const uz = sz / slen;
    const lx = geo.headLeft.x - geo.shaftEnd.x;
    const lz = geo.headLeft.z - geo.shaftEnd.z;
    const rx = geo.headRight.x - geo.shaftEnd.x;
    const rz = geo.headRight.z - geo.shaftEnd.z;
    // Backward-pointing strokes have a negative dot with the shaft unit vector.
    assert.ok(lx * ux + lz * uz < 0, 'left head stroke should point backward from tip');
    assert.ok(rx * ux + rz * uz < 0, 'right head stroke should point backward from tip');
  });
});
