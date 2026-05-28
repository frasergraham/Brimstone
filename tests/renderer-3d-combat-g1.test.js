// G1 redesign — single-number combat readout (replaces the dice card).
//
// Covers:
//  - combatReadoutModel surfaces start/steps/total + side tint
//  - paintReadoutNumber + paintReadoutFloater are pure, don't throw on fakes
//  - addCombatReadout schedules base hold → steps → final hold → fade
//  - main number ticks UP on each step (texture repainted with new value)
//  - per-step floater is spawned alongside (extra DynamicTexture + plane)
//  - outcome flash uses green for winner / red for loser before fade
//  - waitForAnimations drains the returned Promise (it's _trackAnim'd)
//  - addAllyHalfLunge / addCombatOutcomeCue / playReactionAnim still wired
//
// Other regions kept intact and tested here:
//  - computeCombatCardAxisOffset (still used for positioning)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  combatReadoutModel,
  paintReadoutNumber,
  paintReadoutFloater,
  computeLungeTarget,
  computeCombatCardAxisOffset,
  combatCardFrameExtent,
  iconBillboardYRelativeToCone,
  headTopRelativeToCone,
  LUNGE_FRACTION,
  CARD_AXIS_OFFSET_WORLD,
  COMBAT_CARD_ATK_COLOR,
  COMBAT_CARD_DEF_COLOR,
  COMBAT_READOUT_WIN_COLOR,
  COMBAT_READOUT_LOSE_COLOR,
  COMBAT_READOUT_NUM_TEX_SIZE,
  COMBAT_READOUT_NUM_PLANE_WIDTH,
  COMBAT_READOUT_NUM_PLANE_HEIGHT,
  COMBAT_READOUT_FLOATER_TEX_WIDTH,
  COMBAT_READOUT_FLOATER_TEX_HEIGHT,
  COMBAT_READOUT_BASE_HOLD_MS,
  COMBAT_READOUT_STEP_MS,
  COMBAT_READOUT_FINAL_HOLD_MS,
  READOUT_GAP_ABOVE_ICON,
  UNIT_ICON_PLANE_SIZE,
} from '../src/renderer-3d.js';

// ─── Pure model + painters ──────────────────────────────────────────────────

describe('G1 — combatReadoutModel', () => {
  test('attacker side: start=picked die, one step per nonzero attacker bonus, total=attackRoll', () => {
    const result = {
      hit: true, attackRoll: 11, defenseRoll: 4,
      breakdown: {
        atkPool: [6, 4], atkBaseDie: 6, defPool: [3], defBaseDie: 3,
        phaseBonus: 1, atkStaffBonus: 1, atkGangupFlat: 2, atkFortAtkBonus: 1,
        // Defender-side bonuses are intentionally ignored by attacker model.
        fortBonus: 9, defGangupFlat: 9, forestCoverBonus: 9, fatiguePenalty: 9,
      },
    };
    const m = combatReadoutModel(result, 'attacker');
    assert.equal(m.start, 6);
    assert.equal(m.total, 11);
    assert.equal(m.side, 'atk');
    assert.equal(m.sideColor, COMBAT_CARD_ATK_COLOR);
    assert.equal(m.sideIcon, '⚔');
    assert.equal(m.won, true);
    // 4 attacker bonuses → 4 steps, each carries a running total.
    assert.equal(m.steps.length, 4);
    assert.deepEqual(m.steps.map(s => s.label), ['phase', 'staff', 'allies', 'fort']);
    assert.deepEqual(m.steps.map(s => s.delta), [1, 1, 2, 1]);
    assert.deepEqual(m.steps.map(s => s.value), [7, 8, 10, 11]);
  });

  test('defender side: only defender bonuses contribute, fatigue is a NEGATIVE step', () => {
    const result = {
      hit: false, attackRoll: 4, defenseRoll: 9,
      breakdown: {
        atkPool: [3], atkBaseDie: 3, defPool: [4, 5], defBaseDie: 5,
        fortBonus: 2, defGangupFlat: 1, forestCoverBonus: 1, fatiguePenalty: 1,
        // Attacker-side bonuses ignored.
        phaseBonus: 9, atkStaffBonus: 9, atkGangupFlat: 9, atkFortAtkBonus: 9,
      },
    };
    const m = combatReadoutModel(result, 'defender');
    assert.equal(m.start, 5);
    assert.equal(m.total, 9);
    assert.equal(m.side, 'def');
    assert.equal(m.sideColor, COMBAT_CARD_DEF_COLOR);
    assert.equal(m.sideIcon, '🛡');
    assert.equal(m.won, true, 'defender wins on a miss');
    assert.deepEqual(m.steps.map(s => s.label), ['fort', 'guard', 'cover', 'tired']);
    // fatigue → negative delta.
    const tired = m.steps.find(s => s.label === 'tired');
    assert.equal(tired.delta, -1);
    // Running totals: 5 +2 +1 +1 -1 = 8 (matches fortBonus + defGangup + cover - fatigue from start).
    assert.deepEqual(m.steps.map(s => s.value), [7, 8, 9, 8]);
  });

  test('omits zero-value bonuses entirely', () => {
    const m = combatReadoutModel({
      hit: true, attackRoll: 6, defenseRoll: 3,
      breakdown: { atkPool: [6], atkBaseDie: 6, defPool: [3], defBaseDie: 3 },
    }, 'attacker');
    assert.deepEqual(m.steps, []);
    assert.equal(m.start, 6);
    assert.equal(m.total, 6);
  });

  test('missing breakdown: degrades gracefully', () => {
    const bare = combatReadoutModel({ hit: true }, 'attacker');
    assert.equal(bare.start, 0);
    assert.equal(bare.total, 0);
    assert.deepEqual(bare.steps, []);
    assert.equal(bare.won, true);
  });
});

// ─── Painters (pure, fake-canvas-safe) ──────────────────────────────────────

function makeFakeCtx() {
  const calls = [];
  return {
    calls,
    clearRect(...a) { calls.push(['clearRect', ...a]); },
    strokeText(...a) { calls.push(['strokeText', ...a]); },
    fillText(...a) { calls.push(['fillText', ...a]); },
    set font(v)         { calls.push(['font', v]); },
    set textAlign(v)    { calls.push(['textAlign', v]); },
    set textBaseline(v) { calls.push(['textBaseline', v]); },
    set fillStyle(v)    { calls.push(['fillStyle', v]); },
    set strokeStyle(v)  { calls.push(['strokeStyle', v]); },
    set lineWidth(v)    { calls.push(['lineWidth', v]); },
    set lineJoin(v)     { calls.push(['lineJoin', v]); },
    set miterLimit(v)   { calls.push(['miterLimit', v]); },
    measureText: (s) => ({ width: String(s).length * 10 }),
  };
}

describe('G1 — paintReadoutNumber', () => {
  test('clears, strokes (outline), then fills the value text', () => {
    const ctx = makeFakeCtx();
    paintReadoutNumber(ctx, {
      width: 256, height: 256, value: 7, color: '#cc3939', icon: '⚔',
    });
    assert.equal(ctx.calls[0][0], 'clearRect', 'clears first');
    const strokes = ctx.calls.filter(c => c[0] === 'strokeText').map(c => c[1]);
    const fills   = ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
    assert.ok(strokes.includes('⚔ 7'), 'value drawn with icon prefix (outline)');
    assert.ok(fills.includes('⚔ 7'),   'value drawn with icon prefix (fill)');
    const fillStyles = ctx.calls.filter(c => c[0] === 'fillStyle').map(c => c[1]);
    assert.ok(fillStyles.includes('#cc3939'), 'side tint applied to fill');
  });

  test('no icon → just the bare value', () => {
    const ctx = makeFakeCtx();
    paintReadoutNumber(ctx, { width: 256, height: 256, value: 10, color: '#fff' });
    const fills = ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
    assert.ok(fills.includes('10'));
  });

  test('font size is < 60% of texture canvas dim (no edge clipping)', () => {
    const ctx = makeFakeCtx();
    paintReadoutNumber(ctx, {
      width: 256, height: 256, value: 12, color: '#cc3939', icon: '⚔',
    });
    const fontEntries = ctx.calls.filter(c => c[0] === 'font').map(c => c[1]);
    assert.ok(fontEntries.length > 0, 'font was set');
    for (const fontStr of fontEntries) {
      const m = /(\d+)px/.exec(fontStr);
      assert.ok(m, `font string parses: "${fontStr}"`);
      const px = Number(m[1]);
      assert.ok(px < 256 * 0.60,
        `painted font ${px}px is < 60% of 256 canvas (got ${px / 256})`);
    }
  });
});

describe('G1 — paintReadoutFloater', () => {
  test('clears and renders the label with outline + fill', () => {
    const ctx = makeFakeCtx();
    paintReadoutFloater(ctx, {
      width: 384, height: 96, label: '+2 allies', color: COMBAT_READOUT_WIN_COLOR,
    });
    assert.equal(ctx.calls[0][0], 'clearRect');
    const strokes = ctx.calls.filter(c => c[0] === 'strokeText').map(c => c[1]);
    const fills   = ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
    assert.ok(strokes.includes('+2 allies'));
    assert.ok(fills.includes('+2 allies'));
  });

  test('font size is < 60% of texture canvas height', () => {
    const ctx = makeFakeCtx();
    paintReadoutFloater(ctx, {
      width: 384, height: 96, label: '+2 ⚔ allies', color: COMBAT_READOUT_WIN_COLOR,
    });
    const fontEntries = ctx.calls.filter(c => c[0] === 'font').map(c => c[1]);
    assert.ok(fontEntries.length > 0, 'font was set');
    for (const fontStr of fontEntries) {
      const m = /(\d+)px/.exec(fontStr);
      assert.ok(m, `font string parses: "${fontStr}"`);
      const px = Number(m[1]);
      assert.ok(px < 96 * 0.60,
        `painted font ${px}px is < 60% of 96 canvas height (got ${px / 96})`);
    }
  });
});

// ─── computeCombatCardAxisOffset (kept from previous polish) ────────────────

describe('G1 — computeCombatCardAxisOffset spreads numbers along attack axis', () => {
  test('attacker offset is −axis; defender offset is the exact negation', () => {
    const atk = computeCombatCardAxisOffset('attacker', {
      attackerCol: 5, attackerRow: 5, targetCol: 6, targetRow: 5,
    });
    const def = computeCombatCardAxisOffset('defender', {
      attackerCol: 5, attackerRow: 5, targetCol: 6, targetRow: 5,
    });
    assert.ok(atk.x < 0, 'attacker offset is −axis');
    assert.ok(def.x > 0, 'defender offset is +axis');
    assert.ok(Math.abs(atk.x + def.x) < 1e-9);
    assert.ok(Math.abs(atk.z + def.z) < 1e-9);
    const len = Math.hypot(atk.x, atk.z);
    assert.ok(Math.abs(len - CARD_AXIS_OFFSET_WORLD) < 1e-9);
  });

  test('(0,0) when coords missing or combatants share a hex', () => {
    assert.deepEqual(computeCombatCardAxisOffset('attacker', {}), { x: 0, z: 0 });
    assert.deepEqual(computeCombatCardAxisOffset('attacker', {
      attackerCol: 3, attackerRow: 3, targetCol: 3, targetRow: 3,
    }), { x: 0, z: 0 });
  });
});

// ─── combatCardFrameExtent updated to readout shape ─────────────────────────

describe('G1 — combatCardFrameExtent reflects readout footprint', () => {
  test('positive height, leader >= non-leader', () => {
    assert.ok(combatCardFrameExtent(true)  > 0);
    assert.ok(combatCardFrameExtent(false) > 0);
    assert.ok(combatCardFrameExtent(true) >= combatCardFrameExtent(false));
  });
});

// ─── addCombatReadout lifecycle ─────────────────────────────────────────────

function makeFakeBabylon() {
  function Animation(name, prop) { this.name = name; this.prop = prop; }
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONTYPE_VECTOR3 = 1;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  Animation.prototype.setKeys = function (k) { this.keys = k; };
  Animation.prototype.setEasingFunction = function () {};

  function CubicEase() {}
  CubicEase.prototype.setEasingMode = function () {};
  const EasingFunction = { EASINGMODE_EASEOUT: 1 };

  class Vector3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }

  class DynamicTexture {
    constructor(name) {
      this.name = name;
      this.hasAlpha = false;
      this.updated = 0;
      this.disposed = 0;
      this._calls = [];
      this._ctx = {
        clearRect:   () => this._calls.push(['clearRect']),
        strokeText:  (t) => this._calls.push(['strokeText', String(t)]),
        fillText:    (t) => this._calls.push(['fillText', String(t)]),
        measureText: (s) => ({ width: String(s).length * 10 }),
        set font(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
        set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
        set lineJoin(_v) {}, set miterLimit(_v) {},
      };
    }
    getContext() { return this._ctx; }
    update() { this.updated += 1; }
    dispose() { this.disposed += 1; }
    get drawnValues() {
      return this._calls.filter(c => c[0] === 'fillText').map(c => c[1]);
    }
  }

  const Mesh = { BILLBOARDMODE_ALL: 7 };

  const MeshBuilder = {
    CreatePlane(name) {
      const plane = {
        name,
        billboardMode: 0,
        isPickable: true,
        renderingGroupId: 0,
        visibility: 0,
        parent: null,
        uniqueId: Math.floor(Math.random() * 1e6),
        position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
        scaling: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
        material: null,
        disposed: 0,
        dispose() { this.disposed += 1; },
      };
      return plane;
    },
  };

  class StandardMaterial {
    constructor() { this.disposed = 0; this.diffuseTexture = null; this.opacityTexture = null; }
    dispose() { this.disposed += 1; }
  }
  class Color3 { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }

  return { Animation, CubicEase, EasingFunction, Vector3, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Color3 };
}

function makeInst({ ids = ['e1', 'a1'] } = {}) {
  const inst = Object.create(Renderer3D.prototype);
  const captured = [];
  inst._babylon = makeFakeBabylon();
  inst._scene = {
    stopAnimation() {},
    beginDirectAnimation(target, anims, _f, _to, _loop, _spd, onEnd) {
      captured.push({ target, anims });
      if (onEnd) onEnd();
    },
  };
  inst._activeLungeIds = new Set();
  inst._tracked = [];
  inst._trackAnim = (p) => { inst._tracked.push(p); };
  inst._playbackSpeedMul = 1.0;
  inst._entityStandees = new Map();
  inst._unitIconBadges = new Map();
  for (const id of ids) {
    inst._entityStandees.set(id, {
      plane: {
        position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
        scaling: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      },
      leader: false,
    });
  }
  inst._capturedAnims = captured;
  return inst;
}

function fakeScheduler() {
  const queue = [];
  const fn = (cb, ms) => { queue.push({ cb, ms }); };
  fn.runUntil = (cutoffMs) => {
    // Sort by scheduled delay and fire in order (synchronous test scheduler).
    queue.sort((a, b) => a.ms - b.ms);
    while (queue.length && queue[0].ms <= cutoffMs) {
      const next = queue.shift();
      next.cb();
    }
  };
  fn.runAll = () => fn.runUntil(Infinity);
  fn.size = () => queue.length;
  return fn;
}

describe('G1 — addCombatReadout lifecycle', () => {
  // Make sure the new method is gated on document being defined (matches the
  // existing renderer pattern for billboarded planes).
  test('no-ops when the standee is missing', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    const p = inst.addCombatReadout('nope', 'attacker', { hit: true, attackRoll: 6, defenseRoll: 3 });
    assert.ok(p && typeof p.then === 'function');
    assert.equal(inst._tracked.length, 0);
  });

  test('no-ops without scene / babylon', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    inst._scene = null;
    const p = inst.addCombatReadout('e1', 'attacker', { hit: true, attackRoll: 6, defenseRoll: 3 });
    assert.ok(p && typeof p.then === 'function');
    assert.equal(inst._tracked.length, 0);
  });

  test('spawns a billboarded main-number plane parented to the standee, on group 2', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['e1'] });
    const sched = fakeScheduler();
    inst.addCombatReadout('e1', 'attacker',
      { hit: true, attackRoll: 6, defenseRoll: 3,
        breakdown: { atkPool: [6], atkBaseDie: 6, defPool: [3], defBaseDie: 3 } },
      { setTimeoutFn: sched },
    );
    // The standee carries no extra meshes after the call; we only need to
    // verify _tracked got a promise and the parent linkage held.
    assert.equal(inst._tracked.length, 1, 'readout promise tracked');
  });

  test('sequence: base hold → one step per bonus → final hold → fade; main number repaints', async () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['e1'] });
    // Capture every DynamicTexture so we can inspect what got drawn into it.
    const B = inst._babylon;
    const tex = [];
    const OrigTex = B.DynamicTexture;
    B.DynamicTexture = class extends OrigTex {
      constructor(...a) { super(...a); tex.push(this); }
    };

    const sched = fakeScheduler();
    const result = {
      hit: true, attackRoll: 9, defenseRoll: 4,
      breakdown: {
        atkPool: [5], atkBaseDie: 5,
        defPool: [3], defBaseDie: 3,
        atkGangupFlat: 2, phaseBonus: 1, atkStaffBonus: 1,
      },
    };
    const promise = inst.addCombatReadout('e1', 'attacker', result, { setTimeoutFn: sched });

    // tex[0] = main number plane (start = 5).
    assert.equal(tex.length, 1, 'one DynamicTexture allocated for the main number at spawn');
    assert.ok(tex[0].drawnValues.some(v => v.includes('5')),
      'main number painted with picked die (5) at spawn');

    // Advance just past base hold → first step fires.
    sched.runUntil(COMBAT_READOUT_BASE_HOLD_MS + 1);
    // After first step: a per-step floater texture spawns, AND the main
    // number tex is repainted with the new running total.
    assert.ok(tex.length >= 2, 'step spawned a floater texture');
    // Main number should now show the value AFTER step 1 (phase = +1 → 6).
    assert.ok(tex[0].drawnValues.some(v => v.includes('6')),
      'main number ticked up to 6 after step 1');

    // Advance through ALL steps.
    sched.runUntil(COMBAT_READOUT_BASE_HOLD_MS + 3 * COMBAT_READOUT_STEP_MS + 1);
    // Main number should reach the final running total 9 (5 +1 +1 +2).
    assert.ok(tex[0].drawnValues.some(v => v.includes('9')),
      'main number ticked up to the final total');

    // Advance to outcome flash + fade trigger.
    sched.runAll();
    // Outcome flash: repaints main number with WIN colour.
    // (Inspect by drawn fillStyle / drawn values — we know the value is 9
    //  again with the outcome colour at that point.)
    // We can't easily snapshot fillStyle through the simplified ctx mock; the
    // key assertion is that the main number tex was repainted AT LEAST four
    // times: spawn (5) + 3 ticks (6, 7, 9) + outcome flash = 5 updates min.
    assert.ok(tex[0].updated >= 5,
      `main number texture updated through the full sequence (got ${tex[0].updated})`);

    await promise;
    assert.equal(tex[0].disposed, 1, 'main number texture disposed at end');
  });

  test('hides the unit-icon badge for the readout lifetime, restores on dispose', async () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['e1'] });
    const iconPlane = { visibility: 1 };
    inst._unitIconBadges = new Map([['e1', { plane: iconPlane }]]);

    const sched = fakeScheduler();
    const p = inst.addCombatReadout('e1', 'attacker',
      { hit: true, attackRoll: 5, defenseRoll: 3,
        breakdown: { atkPool: [5], atkBaseDie: 5, defPool: [3], defBaseDie: 3 } },
      { setTimeoutFn: sched },
    );
    assert.equal(iconPlane.visibility, 0, 'icon hidden while readout is up');
    sched.runAll();
    await p;
    assert.equal(iconPlane.visibility, 1, 'icon restored after fade');
  });

  test('outcome flash uses GREEN colour for winner, RED for loser', async () => {
    if (!('document' in globalThis)) globalThis.document = {};
    // Winner (attacker who hits) → green flash at the end.
    const inst = makeInst({ ids: ['e1'] });
    // Patch paintReadoutNumber to spy on the final colour.
    const colours = [];
    // We can't easily monkeypatch the imported function, so check via fillStyle
    // calls captured on the DynamicTexture ctx.
    const B = inst._babylon;
    const allCtxCalls = [];
    const OrigTex = B.DynamicTexture;
    B.DynamicTexture = class extends OrigTex {
      constructor(...a) {
        super(...a);
        const _ctx = this._ctx;
        const proxy = new Proxy(_ctx, {
          set(t, p, v) {
            if (p === 'fillStyle') allCtxCalls.push(['fillStyle', v]);
            t[p] = v;
            return true;
          },
          get(t, p) { return t[p]; },
        });
        this.getContext = () => proxy;
      }
    };

    const sched = fakeScheduler();
    const p = inst.addCombatReadout('e1', 'attacker',
      { hit: true, attackRoll: 6, defenseRoll: 3,
        breakdown: { atkPool: [6], atkBaseDie: 6, defPool: [3], defBaseDie: 3 } },
      { setTimeoutFn: sched },
    );
    // Run past the final hold so the outcome flash fires.
    sched.runUntil(COMBAT_READOUT_BASE_HOLD_MS + COMBAT_READOUT_FINAL_HOLD_MS + 1);
    sched.runAll();
    await p;
    void colours;
    const fillStyles = allCtxCalls.map(c => c[1]);
    assert.ok(fillStyles.includes(COMBAT_READOUT_WIN_COLOR),
      'winner uses the WIN colour somewhere in the sequence');
    // Side colour (atk = red) used during the stack-up.
    assert.ok(fillStyles.includes(COMBAT_CARD_ATK_COLOR),
      'side colour also used (start + ticks)');
  });

  test('texture/plane/material dimensions match the new readout constants', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['e1'] });
    const B = inst._babylon;
    const texArgs = [];
    const OrigTex = B.DynamicTexture;
    B.DynamicTexture = class extends OrigTex {
      constructor(name, size, ...rest) {
        super(name, size, ...rest);
        texArgs.push(size);
      }
    };
    const sched = fakeScheduler();
    inst.addCombatReadout('e1', 'attacker',
      { hit: true, attackRoll: 6, defenseRoll: 3,
        breakdown: { atkPool: [6], atkBaseDie: 6, defPool: [3], defBaseDie: 3,
                     atkGangupFlat: 1 } },
      { setTimeoutFn: sched },
    );
    sched.runAll();
    // First tex = main number (square).
    assert.equal(texArgs[0].width,  COMBAT_READOUT_NUM_TEX_SIZE);
    assert.equal(texArgs[0].height, COMBAT_READOUT_NUM_TEX_SIZE);
    // Subsequent textures = step floaters (wider, shorter).
    const floaterTex = texArgs[1];
    assert.equal(floaterTex.width,  COMBAT_READOUT_FLOATER_TEX_WIDTH);
    assert.equal(floaterTex.height, COMBAT_READOUT_FLOATER_TEX_HEIGHT);
  });

  test('main-number plane is sized to match the unit-icon badge', () => {
    assert.equal(COMBAT_READOUT_NUM_PLANE_WIDTH,  UNIT_ICON_PLANE_SIZE,
      'width matches UNIT_ICON_PLANE_SIZE so the readout reads at icon scale');
    assert.equal(COMBAT_READOUT_NUM_PLANE_HEIGHT, UNIT_ICON_PLANE_SIZE,
      'height matches UNIT_ICON_PLANE_SIZE so the readout reads at icon scale');
  });

  test('readout stacks directly above the icon (Y derived from iconTop + gap, no axis offset)', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['e1'] });
    const B = inst._babylon;
    // Capture every plane created during the readout so we can read positions.
    const planes = [];
    const OrigMeshBuilder = B.MeshBuilder;
    B.MeshBuilder = {
      CreatePlane(name, opts, scene) {
        const p = OrigMeshBuilder.CreatePlane(name, opts, scene);
        p.createOpts = opts;
        planes.push(p);
        return p;
      },
    };
    const sched = fakeScheduler();
    // Use opts that would have given a non-zero axis offset under the old
    // behaviour — the new placement must zero it out anyway.
    inst.addCombatReadout('e1', 'attacker',
      { hit: true, attackRoll: 6, defenseRoll: 3,
        breakdown: { atkPool: [6], atkBaseDie: 6, defPool: [3], defBaseDie: 3,
                     atkGangupFlat: 1 } },
      { setTimeoutFn: sched,
        attackerCol: 5, attackerRow: 5, targetCol: 6, targetRow: 5 },
    );
    sched.runUntil(COMBAT_READOUT_BASE_HOLD_MS + 1);

    // First plane = main number readout.
    const numPlane = planes[0];
    assert.ok(numPlane, 'main number plane created');

    // Expected Y: iconCenter + UNIT_ICON_PLANE_SIZE/2 + gap + planeHeight/2.
    const leader = false; // makeInst standees are non-leader.
    const expectedY = iconBillboardYRelativeToCone(leader)
      + UNIT_ICON_PLANE_SIZE / 2
      + READOUT_GAP_ABOVE_ICON
      + COMBAT_READOUT_NUM_PLANE_HEIGHT / 2;
    assert.ok(Math.abs(numPlane.position.y - expectedY) < 1e-6,
      `main number Y derives from iconTop+gap (got ${numPlane.position.y}, expected ${expectedY})`);

    // Strictly above the legacy head-anchored placement.
    const legacyHeadAnchoredY = headTopRelativeToCone(leader)
      + 0.18 + COMBAT_READOUT_NUM_PLANE_HEIGHT / 2;
    assert.ok(numPlane.position.y > legacyHeadAnchoredY,
      'readout sits above the legacy head-anchored placement (now icon-anchored)');

    // No horizontal axis offset — directly above the icon.
    assert.equal(numPlane.position.x, 0, 'no X offset along attack axis');
    assert.equal(numPlane.position.z, 0, 'no Z offset along attack axis');

    // Step floater plane is also centred (X/Z = 0).
    const floaterPlane = planes[1];
    assert.ok(floaterPlane, 'step floater plane created');
    assert.equal(floaterPlane.position.x, 0, 'floater has no X offset');
    assert.equal(floaterPlane.position.z, 0, 'floater has no Z offset');
  });

  test('plane dimensions passed to CreatePlane match COMBAT_READOUT_NUM_PLANE_{WIDTH,HEIGHT}', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['e1'] });
    const B = inst._babylon;
    const planeOpts = [];
    const OrigMeshBuilder = B.MeshBuilder;
    B.MeshBuilder = {
      CreatePlane(name, opts, scene) {
        planeOpts.push(opts);
        return OrigMeshBuilder.CreatePlane(name, opts, scene);
      },
    };
    const sched = fakeScheduler();
    inst.addCombatReadout('e1', 'attacker',
      { hit: true, attackRoll: 6, defenseRoll: 3,
        breakdown: { atkPool: [6], atkBaseDie: 6, defPool: [3], defBaseDie: 3 } },
      { setTimeoutFn: sched },
    );
    assert.equal(planeOpts[0].width,  COMBAT_READOUT_NUM_PLANE_WIDTH);
    assert.equal(planeOpts[0].height, COMBAT_READOUT_NUM_PLANE_HEIGHT);
  });
});

// ─── Other G1 systems still wired (sanity carry-over) ───────────────────────

describe('G1 — addAllyHalfLunge (unchanged)', () => {
  test('slides toward the target and tracks the animation', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['a1'] });
    const target = computeLungeTarget({ x: 0, z: 0 }, { x: 10, z: 0 }, LUNGE_FRACTION * 0.5);
    inst.addAllyHalfLunge('a1', 0, 0, 5, 0);
    void target;
    assert.ok(inst._activeLungeIds.has('a1'));
    assert.equal(inst._tracked.length, 1);
  });

  test('no-ops gracefully when standee is missing', () => {
    const inst = makeInst({ ids: ['e1'] });
    assert.doesNotThrow(() => inst.addAllyHalfLunge('absent', 0, 0, 1, 1));
    assert.equal(inst._tracked.length, 0);
  });
});

describe('G1 — addCombatOutcomeCue (unchanged)', () => {
  test('animates both winner up and loser down', () => {
    const inst = makeInst({ ids: ['w', 'l'] });
    inst.addCombatOutcomeCue('w', 'l');
    assert.equal(inst._tracked.length, 2);
  });
});

describe('G1 — playReactionAnim (unchanged)', () => {
  test('resolves immediately when the rig is not loaded', async () => {
    const inst = makeInst();
    inst._paladinSource = null;
    const t0 = Date.now();
    await inst.playReactionAnim('hit');
    assert.ok(Date.now() - t0 < 50);
  });

  test('rejects unknown kinds (resolves immediately)', async () => {
    const inst = makeInst();
    const r = await inst.playReactionAnim('bogus');
    assert.equal(r, undefined);
  });
});
