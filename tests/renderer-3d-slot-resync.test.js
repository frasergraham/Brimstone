// _resyncTileSlotsForStandees — multi-occupant hexes must keep stable slot
// assignments while a hex-mate's move/lunge animation is still in flight.
// Regression: after a guard-attack's damage floater, the first ally whose
// lunge-return landed was packed as the hex's SOLE occupant (its still-
// animating hex-mate was dropped from the group), so it sat on the bare hex
// centre until the mate landed, then popped back to its slot.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D, TILE_SLOTS, hexToWorld, HEX_RADIUS_WORLD } from '../src/renderer-3d.js';

function makeInst(entities) {
  const inst = Object.create(Renderer3D.prototype);
  inst._babylon = { dummy: true };
  inst._scene = { dummy: true };
  inst._activeMoveIds = new Set();
  inst._activeLungeIds = new Set();
  inst._entityStandees = new Map();
  inst._staticOccupantsByKey = new Map();
  inst._roadBlockedSlotsByKey = new Map();
  inst._overflowBadges = new Map();
  inst.state = { entities, tiles: new Map() };
  inst._positioned = [];
  inst._positionStandee = (standee, e, opts) => { inst._positioned.push({ id: e.id, opts }); };
  inst._syncOverflowBadge = () => {};
  for (const e of entities) inst._entityStandees.set(e.id, { plane: {} });
  return inst;
}

const twoOnOneHex = () => ([
  { id: 'a', alive: true, col: 3, row: 3, slot: 0 },
  { id: 'b', alive: true, col: 3, row: 3, slot: 1 },
]);

describe('_resyncTileSlotsForStandees — animating hex-mates', () => {
  test('landed unit keeps a packed multi-occupant slot while its hex-mate is still lunging', () => {
    const inst = makeInst(twoOnOneHex());
    inst._activeLungeIds.add('b');
    inst._resyncTileSlotsForStandees();
    const a = inst._positioned.find(p => p.id === 'a');
    assert.ok(a, 'landed unit is re-slotted (not left on the bare hex centre)');
    assert.ok(a.opts && typeof a.opts.x === 'number', 'explicit packed position applied');
    assert.ok(!inst._positioned.some(p => p.id === 'b'),
      'the animating unit is never repositioned (its animation owns the transform)');
  });

  test('packed position is the SAME as when both occupants are idle (no pop on landing)', () => {
    const idle = makeInst(twoOnOneHex());
    idle._resyncTileSlotsForStandees();
    const idleA = idle._positioned.find(p => p.id === 'a');
    assert.ok(idleA);

    const mid = makeInst(twoOnOneHex());
    mid._activeLungeIds.add('b');
    mid._resyncTileSlotsForStandees();
    const midA = mid._positioned.find(p => p.id === 'a');
    assert.ok(midA);
    assert.ok(Math.abs(midA.opts.x - idleA.opts.x) < 1e-9, 'same packed x');
    assert.ok(Math.abs(midA.opts.z - idleA.opts.z) < 1e-9, 'same packed z');
  });

  test('single occupant on an empty hex still takes the cheap centre path', () => {
    const inst = makeInst([{ id: 'a', alive: true, col: 3, row: 3, slot: 0 }]);
    inst._resyncTileSlotsForStandees();
    assert.equal(inst._positioned.length, 0, 'no explicit repositioning needed');
  });
});

// Slot continuity across the round boundary: a unit that ended a round in a
// NON-centre slot (because it had a hex-mate when it arrived, or moved into an
// outer slot) must keep that slot when it later becomes the SOLE occupant of
// its hex on the next plan-mode draw. Regression: the lone-occupant early-exit
// snapped it back to the hex centre (via _positionStandee's default path),
// while the authoritative entity.slot stayed put — a visible jump from its slot
// to the centre the instant planning began.
describe('_resyncTileSlotsForStandees — lone occupant honors authoritative slot', () => {
  test('lone idle standee in an outer slot is positioned at that slot, not the bare centre', () => {
    const inst = makeInst([{ id: 'a', alive: true, col: 3, row: 3, slot: 3 }]);
    inst._resyncTileSlotsForStandees();
    const a = inst._positioned.find(p => p.id === 'a');
    assert.ok(a, 'lone non-centre standee is explicitly repositioned (not left on the bare centre)');
    const { x: cx, z: cz } = hexToWorld(3, 3, HEX_RADIUS_WORLD);
    const expected = TILE_SLOTS[3];
    assert.ok(a.opts && Math.abs(a.opts.x - (cx + expected.x)) < 1e-9,
      `x at slot-3 offset (got ${a.opts?.x}, want ${cx + expected.x})`);
    assert.ok(a.opts && Math.abs(a.opts.z - (cz + expected.z)) < 1e-9,
      `z at slot-3 offset (got ${a.opts?.z}, want ${cz + expected.z})`);
  });

  test('lone idle standee in slot 0 still takes the cheap centre path (no needless reposition)', () => {
    const inst = makeInst([{ id: 'a', alive: true, col: 3, row: 3, slot: 0 }]);
    inst._resyncTileSlotsForStandees();
    assert.equal(inst._positioned.length, 0, 'centre-slot lone standee needs no explicit reposition');
  });
});
