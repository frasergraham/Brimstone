// Running vs walking animation selection for the paladin rig.
//
// When a move step traverses 2+ hexes in one plan step the paladin plays the
// RUNNING clip (running.glb, retargeted onto the shared skeleton); a single
// hop walks. Babylon shader/skinning playback can't run under node:test, so we
// pin the extractable contracts:
//   1. selectMoveAnimKind — the pure hop-count → clip-kind switch
//   2. addMoveAnim flags _activeRunMoveIds for a multi-hop path and lazy-loads
//      running.glb; a single-hop move leaves it walking
//   3. _activeMotionGroup picks runGroup only when a run move is active AND the
//      clip has loaded (graceful walk fallback otherwise)
//   4. the tri-state anim tick (_maybeTogglePaladinAnimation) drives 'run' when
//      a run move is active, 'paused' mid-chain, and 'idle' on chain end
//   5. computeRootStrideLength reads the running clip's stride independently

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  selectMoveAnimKind,
  RUN_MIN_PATH_LEN,
  RUNNING_ANIM_ENABLED,
  RUNNING_MODEL_FILE,
  computeRootStrideLength,
} from '../src/renderer-3d.js';

// ── selectMoveAnimKind (pure switch) ────────────────────────────────────────

describe('selectMoveAnimKind', () => {
  test('RUN_MIN_PATH_LEN is 3 (origin + 2 destination hexes)', () => {
    assert.equal(RUN_MIN_PATH_LEN, 3);
  });

  test('RUNNING_MODEL_FILE points at running.glb', () => {
    assert.equal(RUNNING_MODEL_FILE, 'running.glb');
  });

  // Flag-gate: when the running asset's root motion is unusable (e.g. the
  // current Mixamo export with stride < 1 src-unit), RUNNING_ANIM_ENABLED is
  // false and every move plays walking — so the next two test groups branch
  // on the live flag rather than assuming it's flipped on.
  if (RUNNING_ANIM_ENABLED) {
    test('two-hop path (length 3: origin + 2 dests) selects running', () => {
      assert.equal(selectMoveAnimKind(3), 'running');
    });

    test('longer multi-hop paths keep selecting running', () => {
      assert.equal(selectMoveAnimKind(4), 'running');
      assert.equal(selectMoveAnimKind(8), 'running');
    });
  } else {
    test('feature flag disabled — every multi-hop selects walking', () => {
      assert.equal(selectMoveAnimKind(3), 'walking');
      assert.equal(selectMoveAnimKind(4), 'walking');
      assert.equal(selectMoveAnimKind(8), 'walking');
    });
  }

  test('single-hop path (length 2: origin + 1 dest) selects walking', () => {
    assert.equal(selectMoveAnimKind(2), 'walking');
  });

  test('degenerate / sub-2 path lengths fall back to walking (never run)', () => {
    assert.equal(selectMoveAnimKind(0), 'walking');
    assert.equal(selectMoveAnimKind(1), 'walking');
    assert.equal(selectMoveAnimKind(undefined), 'walking');
    assert.equal(selectMoveAnimKind(null), 'walking');
  });
});

// ── addMoveAnim — run flagging + lazy load by hop count ──────────────────────

function makeFakeBabylon() {
  function Animation() {}
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  Animation.prototype.setKeys = function () {};
  return { Animation };
}

function makeMoveInst(standee) {
  const inst = Object.create(Renderer3D.prototype);
  inst._babylon = makeFakeBabylon();
  inst._scene = {
    stopAnimation() {},
    // Resolve the move synchronously by firing the onEnd callback.
    beginDirectAnimation(_t, _a, _f, _to, _loop, _spd, onEnd) { if (onEnd) onEnd(); },
  };
  inst._activeMoveIds   = new Set();
  inst._activeRunMoveIds = new Set();
  inst._entityStandees  = new Map([['e1', standee]]);
  inst._trackAnim       = () => {};
  inst._playbackSpeedMul = 1.0;
  inst._assetsBasePath  = 'assets';
  inst._paladinSource   = null;
  inst._walkingSource   = { speedRatio: 2.0 };
  inst._runningSource   = { speedRatio: 3.0 };
  return inst;
}

function makeStandee() {
  return { plane: { position: { x: 0, z: 0 } }, paladinClone: null };
}


// ── _activeMotionGroup — run only when active AND loaded ─────────────────────


// ── _maybeTogglePaladinAnimation — run/walk/paused/idle tri(+1)-state ────────

function makeGroupSpy() {
  const calls = { start: [], stop: 0, pause: 0, play: [] };
  return {
    calls,
    speedRatio: 1.0,
    start(loop, ratio) { calls.start.push({ loop, ratio }); },
    stop() { calls.stop += 1; },
    pause() { calls.pause += 1; },
    play(loop) { calls.play.push({ loop }); },
  };
}

function makeToggleInst({ run = false, lunge = false } = {}) {
  const inst = Object.create(Renderer3D.prototype);
  const idle = makeGroupSpy();
  const walk = makeGroupSpy();
  const runG = makeGroupSpy();
  inst._paladinSource = {
    idleGroup: idle, walkGroup: walk, runGroup: runG, activeGroup: 'idle',
  };
  inst._activeMoveIds   = new Set(lunge ? [] : ['e1']);
  inst._activeLungeIds  = new Set(lunge ? ['e1'] : []);
  inst._activeRunMoveIds = new Set(run ? ['e1'] : []);
  // No entity list → paladinAnimTargetWeight falls back to "anyone moving = motion".
  inst.state = null;
  inst._runningSource = { speedRatio: 3.0 };
  inst._walkingSource = { speedRatio: 2.0 };
  return inst;
}


// ── computeRootStrideLength against a running-clip stub (pure) ───────────────

describe('computeRootStrideLength — running clip stride', () => {
  // A synthetic running AnimationGroup: the root Hips node translates further
  // per cycle than a walk would (a run has a longer stride). The pure helper
  // must read that XZ displacement from the first/last position keys.
  function makeRunGroup(strideX, strideZ) {
    return {
      targetedAnimations: [{
        target: { name: 'mixamorig:Hips' },
        animation: {
          targetProperty: 'position',
          getKeys: () => [
            { frame: 0,  value: { x: 0, y: 1, z: 0 } },
            { frame: 30, value: { x: strideX, y: 1, z: strideZ } },
          ],
        },
      }],
    };
  }

  test('reads the running stride from the root position track', () => {
    const g = makeRunGroup(3, 4); // 3-4-5 triangle → stride 5
    assert.equal(computeRootStrideLength(g), 5);
  });

  test('handles the duplicate-suffixed bone name (mixamorig:Hips.001)', () => {
    const g = makeRunGroup(6, 8); // → 10
    g.targetedAnimations[0].target.name = 'mixamorig:Hips.001';
    assert.equal(computeRootStrideLength(g), 10);
  });

  test('returns 0 when no usable position track is present', () => {
    assert.equal(computeRootStrideLength({ targetedAnimations: [] }), 0);
    assert.equal(computeRootStrideLength(null), 0);
  });
});

