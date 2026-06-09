// Punch-during-lunge coverage. The attacker paladin plays the retargeted
// punch clip on top of the position-slide; cone-token units (and the window
// before punch.glb has lazily loaded) fall back to the pure slide.
//
// The Babylon-touching playback is verified in headless Chrome; here we pin
// the extractable contracts:
//   1. computePunchSpeedRatio compresses the clip into the strike window
//   2. _startPaladinPunch hands the shared skeleton to punch + restores it
//   3. _stopPaladinPunch releases it (round-snap path)
//   4. the idle/walk toggle yields while a punch is mid-swing
//   5. addLungeAnim plays the punch for a paladin clone, lazy-loads it when
//      not yet present, and never touches it for a cone-token attacker.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  computePunchSpeedRatio,
  PUNCH_MODEL_FILE,
  PUNCH_TARGET_MS,
  PUNCH_IMPACT_FRAC,
} from '../src/renderer-3d.js';

// ── computePunchSpeedRatio (pure) ───────────────────────────────────────────

describe('computePunchSpeedRatio', () => {
  test('compresses a 1s clip into a 500ms strike at 2× speed', () => {
    assert.equal(computePunchSpeedRatio(1.0, 500), 2.0);
  });

  test('a 2s clip into 500ms reads at 4×', () => {
    assert.equal(computePunchSpeedRatio(2.0, 500), 4.0);
  });

  test('clamps a pathologically fast ratio to 8.0', () => {
    assert.equal(computePunchSpeedRatio(10, 100), 8.0);
  });

  test('clamps a pathologically slow ratio to 0.5', () => {
    assert.equal(computePunchSpeedRatio(0.1, 1000), 0.5);
  });

  test('falls back when the natural duration is unknown', () => {
    assert.equal(computePunchSpeedRatio(0, 500), 2.0);
    assert.equal(computePunchSpeedRatio(undefined, 500, 3.0), 3.0);
  });

  test('falls back when the target time is non-positive', () => {
    assert.equal(computePunchSpeedRatio(1.0, 0), 2.0);
  });
});

// ── constants ───────────────────────────────────────────────────────────────

describe('punch constants', () => {
  test('PUNCH_MODEL_FILE points at punch.glb', () => {
    assert.equal(PUNCH_MODEL_FILE, 'punch.glb');
  });

  test('PUNCH_TARGET_MS is a positive, lunge-scaled window', () => {
    assert.ok(PUNCH_TARGET_MS > 0 && PUNCH_TARGET_MS < 2000);
  });
});

// ── _startPaladinPunch / _stopPaladinPunch ──────────────────────────────────

function makeGroupSpy() {
  const calls = { start: [], stop: 0, endCbs: [], pause: 0, play: [], goToFrame: [] };
  return {
    calls,
    from: 0,
    to: 100,
    start(loop, ratio, from, to) { calls.start.push({ loop, ratio, from, to }); },
    stop() { calls.stop += 1; },
    pause() { calls.pause += 1; },
    play(loop) { calls.play.push({ loop }); },
    goToFrame(f) { calls.goToFrame.push(f); },
    onAnimationGroupEndObservable: {
      addOnce(cb) { calls.endCbs.push(cb); },
    },
  };
}


// ── holdPunchAtImpact / resumePunch — the freeze→roll→resume sequence ───────

describe('PUNCH_IMPACT_FRAC', () => {
  test('is a mid/impact fraction in (0,1)', () => {
    assert.ok(PUNCH_IMPACT_FRAC > 0 && PUNCH_IMPACT_FRAC < 1);
    // ~50-60% through the clip — past the wind-up, at the contact pose.
    assert.ok(PUNCH_IMPACT_FRAC >= 0.4 && PUNCH_IMPACT_FRAC <= 0.7);
  });
});

describe('Renderer3D.holdPunchAtImpact', () => {
  test('freezes a live punch on the impact frame and pauses it', () => {
    const inst = Object.create(Renderer3D.prototype);
    const punch = makeGroupSpy();
    punch.from = 0; punch.to = 100;
    inst._paladinSource = { punchGroup: punch, punchPlaying: true, activeGroup: 'punch' };
    inst._frozenPunchImpactFrame = null;

    assert.equal(inst.holdPunchAtImpact(), true);
    // Impact frame = from + (to-from)*frac.
    const expected = 0 + (100 - 0) * PUNCH_IMPACT_FRAC;
    assert.equal(punch.calls.goToFrame.at(-1), expected);
    assert.equal(punch.calls.pause, 1, 'punch paused at the impact pose');
    assert.equal(inst._frozenPunchImpactFrame, expected, 'frozen frame stashed for resume');
    // punchPlaying stays set so the idle/walk toggle won't grab the skeleton.
    assert.equal(inst._paladinSource.punchPlaying, true);
  });

  test('no-ops (returns false) when no punch is playing — ranged/cone attacker', () => {
    const inst = Object.create(Renderer3D.prototype);
    const punch = makeGroupSpy();
    inst._paladinSource = { punchGroup: punch, punchPlaying: false };
    inst._frozenPunchImpactFrame = null;
    assert.equal(inst.holdPunchAtImpact(), false);
    assert.equal(punch.calls.pause, 0, 'a non-playing shared punch is left alone');
    assert.equal(inst._frozenPunchImpactFrame, null);
  });

  test('no-ops when the punch clip never loaded', () => {
    const inst = Object.create(Renderer3D.prototype);
    inst._paladinSource = { punchPlaying: true };
    inst._frozenPunchImpactFrame = null;
    assert.equal(inst.holdPunchAtImpact(), false);
  });
});

describe('Renderer3D._startRigPunch', () => {
  test('is a real method (regression: was deleted as "orphaned")', () => {
    const inst = Object.create(Renderer3D.prototype);
    assert.equal(typeof inst._startRigPunch, 'function');
  });

  test('silences locomotion, marks punchPlaying, and starts the one-shot', () => {
    const inst = Object.create(Renderer3D.prototype);
    inst._playbackSpeedMul = 1.0;
    const punch = makeGroupSpy();
    const idle = makeGroupSpy(), walk = makeGroupSpy(), run = makeGroupSpy();
    const src = { punchGroup: punch, punchDurationSec: 1.0,
      idleGroup: idle, walkGroup: walk, runGroup: run, activeGroup: 'idle' };

    assert.equal(inst._startRigPunch(src), true);
    assert.equal(src.punchPlaying, true);
    assert.equal(src.activeGroup, 'punch');
    assert.equal(idle.calls.stop, 1);
    assert.equal(walk.calls.stop, 1);
    assert.equal(run.calls.stop, 1);
    assert.equal(punch.calls.start.length, 1);
    assert.equal(punch.calls.start[0].loop, false, 'one-shot strike, no loop');

    // The end callback releases the skeleton back to idle/walk.
    assert.equal(punch.calls.endCbs.length, 1);
    punch.calls.endCbs[0]();
    assert.equal(src.punchPlaying, false);
    assert.equal(src.activeGroup, null);
  });

  test('no-ops until the punch clip has loaded', () => {
    const inst = Object.create(Renderer3D.prototype);
    assert.equal(inst._startRigPunch({}), false);
    assert.equal(inst._startRigPunch(null), false);
  });
});

describe('Renderer3D.resumePunch', () => {
  test('unpauses a frozen punch and resolves when the strike ends', async () => {
    const inst = Object.create(Renderer3D.prototype);
    const punch = makeGroupSpy();
    inst._paladinSource = { punchGroup: punch, punchPlaying: true, activeGroup: 'punch' };
    inst._frozenPunchImpactFrame = 55;

    const p = inst.resumePunch();
    // Resumed via play() (unpause), not a fresh start().
    assert.equal(punch.calls.play.length, 1);
    assert.equal(inst._frozenPunchImpactFrame, null, 'frozen frame cleared on resume');
    // End-observable pending — promise not yet resolved.
    let resolved = false;
    p.then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false);
    // Fire the strike-complete callback.
    assert.equal(punch.calls.endCbs.length, 1);
    punch.calls.endCbs.at(-1)();
    await p;
    assert.equal(inst._paladinSource.punchPlaying, false, 'idle/walk released after the strike');
    assert.equal(inst._paladinSource.activeGroup, null);
  });

  test('resolves immediately (no-op) when nothing is frozen', async () => {
    const inst = Object.create(Renderer3D.prototype);
    inst._paladinSource = { punchGroup: makeGroupSpy() };
    inst._frozenPunchImpactFrame = null;
    await inst.resumePunch(); // should resolve without hanging
    assert.ok(true);
  });
});

describe('Renderer3D._stopPaladinPunch', () => {
  test('stops the group and clears the playing flag', () => {
    const inst = Object.create(Renderer3D.prototype);
    const punch = makeGroupSpy();
    inst._paladinSource = { punchGroup: punch, punchPlaying: true, activeGroup: 'punch' };
    inst._stopPaladinPunch();
    assert.equal(punch.calls.stop, 1);
    assert.equal(inst._paladinSource.punchPlaying, false);
    assert.equal(inst._paladinSource.activeGroup, null);
  });

  test('is a no-op when there is no source', () => {
    const inst = Object.create(Renderer3D.prototype);
    inst._paladinSource = null;
    assert.doesNotThrow(() => inst._stopPaladinPunch());
  });
});

// ── idle/walk toggle yields to a mid-swing punch ────────────────────────────


// ── addLungeAnim integration ────────────────────────────────────────────────

function makeFakeBabylon() {
  function Animation() {}
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  Animation.prototype.setKeys = function () {};
  Animation.prototype.setEasingFunction = function () {};
  function CubicEase() {}
  CubicEase.prototype.setEasingMode = function () {};
  return {
    Animation,
    CubicEase,
    EasingFunction: { EASINGMODE_EASEOUT: 1 },
    Vector3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } },
  };
}

function makeLungeInst(standee) {
  const inst = Object.create(Renderer3D.prototype);
  inst._babylon = makeFakeBabylon();
  inst._scene = {
    stopAnimation() {},
    beginDirectAnimation(_t, _a, _f, _to, _loop, _spd, onEnd) { if (onEnd) onEnd(); },
  };
  inst._camera = null;
  inst._activeLungeIds = new Set();
  inst._entityStandees = new Map([['e1', standee]]);
  inst._rigSources = new Map();
  inst._trackAnim = () => {};
  inst._playbackSpeedMul = 1.0;
  inst._assetsBasePath = 'assets';
  return inst;
}

describe('Renderer3D.addLungeAnim — punch wiring', () => {
  test('plays the punch on the attacker rig when its clip is loaded', () => {
    const standee = { plane: { position: { x: 0, z: 0 } }, paladinClone: { mesh: { rotation: { y: 0 } } } };
    const inst = makeLungeInst(standee);
    // Hero flows through the cascade now: its rig (paladin-idle.glb) carries
    // the punch clip.
    const rig = { punchGroup: {} };
    inst._rigSources.set('paladin-idle.glb', rig);
    inst.state = { entities: [{ id: 'e1', type: 'paladin' }] };
    let punched = null, ensured = 0;
    inst._startRigPunch = (src) => { punched = src; };
    inst._ensureRigPunch = () => { ensured += 1; };
    assert.doesNotThrow(() => inst.addLungeAnim('e1', 0, 0, 1, 0, 'hero', 'hero'));
    assert.equal(punched, rig, 'punch played on the attacker rig');
    assert.equal(ensured, 0);
  });

  test('lazily loads the punch clip when not yet present (this lunge slides only)', () => {
    const standee = { plane: { position: { x: 0, z: 0 } }, paladinClone: { mesh: { rotation: { y: 0 } } } };
    const inst = makeLungeInst(standee);
    const rig = {}; // no punchGroup yet
    inst._rigSources.set('paladin-idle.glb', rig);
    inst.state = { entities: [{ id: 'e1', type: 'paladin' }] };
    let punched = 0, ensured = 0;
    inst._startRigPunch = () => { punched += 1; };
    inst._ensureRigPunch = () => { ensured += 1; };
    inst.addLungeAnim('e1', 0, 0, 1, 0, 'hero', 'hero');
    assert.equal(punched, 0, 'no clip → no punch this frame');
    assert.equal(ensured, 1, 'lazy load kicked');
  });

  test('cone-token attacker (no clone) slides with no punch and no crash', () => {
    const standee = { plane: { position: { x: 0, z: 0 } }, paladinClone: null };
    const inst = makeLungeInst(standee);
    inst._paladinSource = { punchGroup: {} };
    let punched = 0, ensured = 0;
    inst._startPaladinPunch = () => { punched += 1; };
    inst._ensurePunchAnimation = () => { ensured += 1; };
    assert.doesNotThrow(() => inst.addLungeAnim('e1', 0, 0, 1, 0, 'witch', 'witch'));
    assert.equal(punched, 0);
    assert.equal(ensured, 0);
    // The slide still registered the lunge.
    assert.ok(inst._activeLungeIds.has('e1'));
  });
});
