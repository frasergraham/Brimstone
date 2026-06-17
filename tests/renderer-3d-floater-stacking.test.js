// Damage-floater stacking — concurrent floaters on the same hex must not
// overlap. Covers:
//   - pure claimFloaterSlot / releaseFloaterSlot semantics (lowest-free-slot)
//   - _spawnFloatingText integration: two live floaters on one hex spawn at
//     different heights; a finished floater frees its slot for the next one.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  claimFloaterSlot,
  releaseFloaterSlot,
  FLOAT_TEXT_STACK_DY,
} from '../src/renderer-3d.js';

// ─── Pure slot bookkeeping ───────────────────────────────────────────────────

describe('floater slot bookkeeping', () => {
  test('claims are lowest-free-slot; concurrent claims are distinct', () => {
    const slots = new Map();
    assert.equal(claimFloaterSlot(slots, '3,4'), 0);
    assert.equal(claimFloaterSlot(slots, '3,4'), 1);
    assert.equal(claimFloaterSlot(slots, '3,4'), 2);
    // Other hexes are independent.
    assert.equal(claimFloaterSlot(slots, '5,5'), 0);
  });

  test('releasing a middle slot makes it the next claim (no ever-growing stack)', () => {
    const slots = new Map();
    claimFloaterSlot(slots, '3,4');           // 0
    const s1 = claimFloaterSlot(slots, '3,4'); // 1
    claimFloaterSlot(slots, '3,4');           // 2
    releaseFloaterSlot(slots, '3,4', s1);
    assert.equal(claimFloaterSlot(slots, '3,4'), 1, 'freed slot reused');
  });

  test('releasing the last slot clears the hex entry entirely', () => {
    const slots = new Map();
    const s0 = claimFloaterSlot(slots, '3,4');
    releaseFloaterSlot(slots, '3,4', s0);
    assert.equal(slots.size, 0);
  });

  test('release of unknown hex/slot is a no-op', () => {
    const slots = new Map();
    assert.doesNotThrow(() => releaseFloaterSlot(slots, '9,9', 0));
  });
});

// ─── _spawnFloatingText integration (fake Babylon) ───────────────────────────

function makeFakeBabylon() {
  const ctxProxy = new Proxy({}, {
    get: (t, prop) => (prop in t ? t[prop] : () => {}),
    set: (t, prop, v) => { t[prop] = v; return true; },
  });
  class DynamicTexture {
    constructor() {}
    getContext() { return ctxProxy; }
    update() {}
    dispose() {}
  }
  class StandardMaterial { dispose() {} }
  class Color3 { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }
  class Animation {
    constructor(name, prop) { this.name = name; this.prop = prop; this.keys = []; }
    setKeys(k) { this.keys = k; }
  }
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  const MeshBuilder = {
    CreatePlane(name) {
      return {
        name,
        position: {
          x: 0, y: 0, z: 0,
          set(x, y, z) { this.x = x; this.y = y; this.z = z; },
        },
        dispose() {},
      };
    },
  };
  const Mesh = { BILLBOARDMODE_ALL: 7 };
  return { DynamicTexture, StandardMaterial, Color3, Animation, MeshBuilder, Mesh };
}

function makeInst() {
  const inst = Object.create(Renderer3D.prototype);
  inst._babylon = makeFakeBabylon();
  const pendingEnds = [];
  inst._pendingEnds = pendingEnds;
  inst._scene = {
    beginDirectAnimation(target, anims, _f, _to, _loop, _spd, onEnd) {
      pendingEnds.push({ target, anims, onEnd });
    },
  };
  inst._entityStandees = new Map();
  inst._trackAnim = (p) => p;
  return inst;
}

describe('_spawnFloatingText stacking', () => {
  test('two live floaters on the same hex spawn one stack slot apart', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    inst._spawnFloatingText(3, 4, '-2', '#ff5050', 900, 0.7, { variant: 'damage' });
    inst._spawnFloatingText(3, 4, '-1', '#ff5050', 900, 0.7, { variant: 'damage' });
    const [a, b] = inst._pendingEnds;
    assert.ok(a && b, 'two floater animations queued');
    const dy = b.target.position.y - a.target.position.y;
    assert.ok(Math.abs(dy - FLOAT_TEXT_STACK_DY) < 1e-9,
      `second floater one stack slot above the first (dy=${dy})`);
  });

  test('floaters on different hexes do not stack', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    inst._spawnFloatingText(3, 4, '-2', '#ff5050', 900, 0.7, { variant: 'damage' });
    inst._spawnFloatingText(5, 5, '-1', '#ff5050', 900, 0.7, { variant: 'damage' });
    const [a, b] = inst._pendingEnds;
    assert.ok(Math.abs(a.target.position.y - b.target.position.y) < 1e-9,
      'both at base height');
  });

  test('a finished floater frees its slot — next floater spawns back at base height', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    inst._spawnFloatingText(3, 4, '-2', '#ff5050', 900, 0.7, { variant: 'damage' });
    const first = inst._pendingEnds[0];
    first.onEnd(); // floater expires
    inst._spawnFloatingText(3, 4, '-1', '#ff5050', 900, 0.7, { variant: 'damage' });
    const next = inst._pendingEnds[1];
    assert.ok(Math.abs(next.target.position.y - first.target.position.y) < 1e-9,
      'slot reclaimed after expiry');
  });

  test('stack offset carries through the rise animation keys, not just the spawn point', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    inst._spawnFloatingText(3, 4, '-2', '#ff5050', 900, 0.7, { variant: 'damage' });
    inst._spawnFloatingText(3, 4, '-1', '#ff5050', 900, 0.7, { variant: 'damage' });
    const [a, b] = inst._pendingEnds;
    const yAnim = (entry) => entry.anims.find(an => an.prop === 'position.y');
    const dyStart = yAnim(b).keys[0].value - yAnim(a).keys[0].value;
    const dyEnd   = yAnim(b).keys.at(-1).value - yAnim(a).keys.at(-1).value;
    assert.ok(Math.abs(dyStart - FLOAT_TEXT_STACK_DY) < 1e-9);
    assert.ok(Math.abs(dyEnd - FLOAT_TEXT_STACK_DY) < 1e-9);
  });
});

// ─── clearFlashes() disposes loot flashes (explore loot does not stack) ───────
//
// Regression for t-4e9b1bf0: each round, the orchestrator calls
// renderer.clearFlashes() before an explore step so loot labels from earlier
// explores don't pile up on screen. The 3D clearFlashes() used to be a no-op,
// so every exploration's loot floater accumulated within a round — the operator
// saw "resources stacked across ALL explorations this round." The 2D-only fix
// (commit fca7c0f) relied on this method, which never worked in the shipping 3D
// renderer. clearFlashes() must now actually dispose the addFlash-spawned
// floaters (loot / fortify / ability) while leaving combat HP-delta / death
// floaters (addHpChangeFlash, variant 'damage') untouched.

describe('clearFlashes disposes loot flashes', () => {
  test('after clearFlashes, the next loot flash on the same hex spawns at base height', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    // Two explores' loot labels land on the same hex this round.
    inst.addFlash(3, 4, '+🪵', null, 1800, 0.72, '#e8d48a');
    inst.addFlash(3, 4, '+⚙',  null, 1800, 0.72, '#e8d48a');
    assert.equal(inst._pendingEnds.length, 2, 'two loot floaters queued');
    const base = inst._pendingEnds[0].target.position.y;

    // Orchestrator clears stale flashes before the next explore step.
    inst.clearFlashes();

    // The next explore's loot label must reclaim slot 0 (base height) — proving
    // the prior two floaters released their stack slots instead of piling up.
    inst.addFlash(3, 4, '+🥈', null, 1800, 0.72, '#e8d48a');
    const next = inst._pendingEnds[2];
    assert.ok(Math.abs(next.target.position.y - base) < 1e-9,
      'cleared floaters freed their slots; next flash spawns at base height');
  });

  test('clearFlashes disposes the floater meshes', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    inst.addFlash(3, 4, '+🪵', null, 1800, 0.72, '#e8d48a');
    const plane = inst._pendingEnds[0].target;
    let disposed = false;
    const orig = plane.dispose.bind(plane);
    plane.dispose = () => { disposed = true; orig(); };

    inst.clearFlashes();
    assert.ok(disposed, 'cleared loot floater plane disposed');
  });

  test('clearFlashes leaves combat damage floaters (addHpChangeFlash) untouched', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    // Damage floater goes through _spawnFloatingText WITHOUT register, so it is
    // not a "flash" and survives clearFlashes.
    inst._spawnFloatingText(3, 4, '-2', '#ff5050', 900, 0.7, { variant: 'damage' });
    const plane = inst._pendingEnds[0].target;
    let disposed = false;
    const orig = plane.dispose.bind(plane);
    plane.dispose = () => { disposed = true; orig(); };

    inst.clearFlashes();
    assert.equal(disposed, false, 'combat damage floater not disposed by clearFlashes');
  });
});
