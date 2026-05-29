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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  Renderer3D,
  selectMoveAnimKind,
  RUN_MIN_PATH_LEN,
  RUNNING_MODEL_FILE,
  computeRootStrideLength,
} from '../src/renderer-3d.js';

const _here = dirname(fileURLToPath(import.meta.url));
const _renderer3dSrc = readFileSync(join(_here, '..', 'src', 'renderer-3d.js'), 'utf8');

// ── selectMoveAnimKind (pure switch) ────────────────────────────────────────

describe('selectMoveAnimKind', () => {
  test('RUN_MIN_PATH_LEN is 3 (origin + 2 destination hexes)', () => {
    assert.equal(RUN_MIN_PATH_LEN, 3);
  });

  test('RUNNING_MODEL_FILE points at running.glb', () => {
    assert.equal(RUNNING_MODEL_FILE, 'running.glb');
  });

  test('single-hop path (length 2: origin + 1 dest) selects walking', () => {
    assert.equal(selectMoveAnimKind(2), 'walking');
  });

  test('two-hop path (length 3: origin + 2 dests) selects running', () => {
    assert.equal(selectMoveAnimKind(3), 'running');
  });

  test('longer multi-hop paths keep selecting running', () => {
    assert.equal(selectMoveAnimKind(4), 'running');
    assert.equal(selectMoveAnimKind(8), 'running');
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

describe('Renderer3D.addMoveAnim — running vs walking by hop count', () => {
  test('single-hop move does NOT flag a run and does not load running.glb', () => {
    const inst = makeMoveInst(makeStandee());
    let ensured = 0;
    inst._ensureRunningAnimation = () => { ensured += 1; };
    // path = one destination hex → waypoints [origin, dest] (length 2) → walk.
    inst.addMoveAnim('e1', 0, 0, 1, 0, 'hero', 'hero', null, [{ col: 1, row: 0 }]);
    assert.equal(ensured, 0, 'walk move should not kick the running load');
    // The move resolved synchronously, so the id is cleared from both sets.
    assert.equal(inst._activeRunMoveIds.has('e1'), false);
  });

  test('multi-hop move flags the run mid-flight and lazy-loads running.glb', () => {
    const standee = makeStandee();
    const inst = makeMoveInst(standee);
    let ensured = 0;
    inst._ensureRunningAnimation = () => { ensured += 1; };
    // Capture whether the entity was flagged as running WHILE the move was in
    // flight — beginDirectAnimation resolves synchronously here, so snapshot
    // the set inside the onEnd-free window by overriding beginDirectAnimation.
    let runFlaggedDuringMove = null;
    inst._scene.beginDirectAnimation = (_t, _a, _f, _to, _loop, _spd, onEnd) => {
      runFlaggedDuringMove = inst._activeRunMoveIds.has('e1');
      if (onEnd) onEnd();
    };
    // path = two destination hexes → waypoints length 3 → running.
    inst.addMoveAnim('e1', 0, 0, 2, 0, 'hero', 'hero', null,
      [{ col: 1, row: 0 }, { col: 2, row: 0 }]);
    assert.equal(ensured, 1, 'multi-hop move kicks the lazy running load');
    assert.equal(runFlaggedDuringMove, true,
      'entity is in _activeRunMoveIds while the multi-hop move plays');
    // Cleared once the move completes.
    assert.equal(inst._activeRunMoveIds.has('e1'), false);
  });

  test('a later single-hop move clears a stale run flag', () => {
    const inst = makeMoveInst(makeStandee());
    inst._ensureRunningAnimation = () => {};
    // Pre-seed a stale run flag (e.g. a prior interrupted move).
    inst._activeRunMoveIds.add('e1');
    inst._scene.beginDirectAnimation = () => {}; // leave move "in flight"
    inst.addMoveAnim('e1', 0, 0, 1, 0, 'hero', 'hero', null, [{ col: 1, row: 0 }]);
    assert.equal(inst._activeRunMoveIds.has('e1'), false,
      'single-hop move clears the run flag even before completion');
  });

  test('multi-hop run sets the RUN group speedRatio to its CONSTANT base (distance-independent)', () => {
    const inst = makeMoveInst(makeStandee());
    inst._ensureRunningAnimation = () => {};
    inst._scene.beginDirectAnimation = () => {}; // hold in flight
    const runGroup  = { speedRatio: 1.0 };
    const walkGroup = { speedRatio: 1.0 };
    inst._paladinSource = { runGroup, walkGroup };
    inst.addMoveAnim('e1', 0, 0, 2, 0, 'hero', 'hero', null,
      [{ col: 1, row: 0 }, { col: 2, row: 0 }]);
    // Running matches speed-to-distance via the cone-slide WINDOW (it scales by
    // hop count — see the duration test below), NOT the speedRatio. The run
    // clip plays at its per-hex base ratio (3.0) regardless of distance, so feet
    // stay planted without the multi-hop speed-up the old code produced.
    assert.equal(runGroup.speedRatio, 3.0,
      `run speedRatio ${runGroup.speedRatio} should equal the base ratio, not be scaled by distance`);
    assert.equal(walkGroup.speedRatio, 1.0, 'walk group untouched on a run move');
  });

  test('run cone-slide DURATION scales with distance (speed matched to distance)', () => {
    // Capture the end-frame (FRAMES_MOVE) handed to beginDirectAnimation — that
    // is the cone-slide window. A 4-hex run must take ~2× the frames of a 2-hex
    // run so ground-travel speed stays constant at a running pace (a longer run
    // takes longer in real time, it doesn't sprint faster). The run speedRatio
    // stays constant across both — distance lives entirely in the window.
    function runFramesFor(dests) {
      const inst = makeMoveInst(makeStandee());
      inst._ensureRunningAnimation = () => {};
      let toFrame = null;
      inst._scene.beginDirectAnimation = (_t, _a, _f, _to) => { toFrame = _to; };
      const runGroup  = { speedRatio: 1.0 };
      const walkGroup = { speedRatio: 1.0 };
      inst._paladinSource = { runGroup, walkGroup };
      const last = dests[dests.length - 1];
      inst.addMoveAnim('e1', 0, 0, last.col, last.row, 'hero', 'hero', null, dests);
      return { toFrame, runRatio: runGroup.speedRatio };
    }
    const twoHex  = runFramesFor([{ col: 1, row: 0 }, { col: 2, row: 0 }]);
    const fourHex = runFramesFor(
      [{ col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 4, row: 0 }]);
    assert.ok(twoHex.toFrame > 0 && fourHex.toFrame > 0, 'both runs got a frame window');
    const ratio = fourHex.toFrame / twoHex.toFrame;
    assert.ok(Math.abs(ratio - 2) < 0.05,
      `4-hex run window (${fourHex.toFrame}f) should be ~2× the 2-hex window (${twoHex.toFrame}f); ratio=${ratio.toFixed(3)}`);
    assert.equal(twoHex.runRatio, fourHex.runRatio,
      'run speedRatio is distance-independent (constant base across both moves)');
  });

  test('single-hop walk scales the WALK group speedRatio (not the run group)', () => {
    const inst = makeMoveInst(makeStandee());
    inst._ensureRunningAnimation = () => {};
    inst._scene.beginDirectAnimation = () => {};
    const runGroup  = { speedRatio: 1.0 };
    const walkGroup = { speedRatio: 1.0 };
    inst._paladinSource = { runGroup, walkGroup };
    inst.addMoveAnim('e1', 0, 0, 1, 0, 'hero', 'hero', null, [{ col: 1, row: 0 }]);
    assert.ok(walkGroup.speedRatio > 0 && walkGroup.speedRatio !== 1.0,
      'walk group speedRatio updated on a walk move');
    assert.equal(runGroup.speedRatio, 1.0, 'run group untouched on a walk move');
  });
});

// ── _activeMotionGroup — run only when active AND loaded ─────────────────────

describe('Renderer3D._activeMotionGroup', () => {
  function inst(paladinSource, runIds) {
    const i = Object.create(Renderer3D.prototype);
    i._paladinSource = paladinSource;
    i._activeRunMoveIds = new Set(runIds || []);
    return i;
  }

  test('no paladin source → walk kind, null group', () => {
    const out = inst(null, ['e1'])._activeMotionGroup();
    assert.deepEqual(out, { group: null, kind: 'walk' });
  });

  test('run move active + run clip loaded → run group', () => {
    const runGroup = {};
    const out = inst({ runGroup, walkGroup: {} }, ['e1'])._activeMotionGroup();
    assert.equal(out.kind, 'run');
    assert.strictEqual(out.group, runGroup);
  });

  test('run move active but run clip NOT loaded → walk fallback', () => {
    const walkGroup = {};
    const out = inst({ runGroup: null, walkGroup }, ['e1'])._activeMotionGroup();
    assert.equal(out.kind, 'walk');
    assert.strictEqual(out.group, walkGroup);
  });

  test('no run move active → walk group even if run clip is loaded', () => {
    const walkGroup = {};
    const out = inst({ runGroup: {}, walkGroup }, [])._activeMotionGroup();
    assert.equal(out.kind, 'walk');
    assert.strictEqual(out.group, walkGroup);
  });
});

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

describe('Renderer3D._maybeTogglePaladinAnimation — running', () => {
  test('a multi-hop run move drives the RUN clip (walk + idle silenced)', () => {
    const inst = makeToggleInst({ run: true });
    const { idleGroup, walkGroup, runGroup } = inst._paladinSource;
    inst._maybeTogglePaladinAnimation();
    assert.equal(inst._paladinSource.activeGroup, 'run');
    assert.equal(runGroup.calls.play.length, 1, 'run clip played');
    assert.equal(idleGroup.calls.stop, 1, 'idle silenced for the run');
    assert.equal(walkGroup.calls.stop, 1, 'walk silenced (other motion clip)');
  });

  test('a single-hop move drives the WALK clip (run untouched)', () => {
    const inst = makeToggleInst({ run: false });
    const { walkGroup, runGroup } = inst._paladinSource;
    inst._maybeTogglePaladinAnimation();
    assert.equal(inst._paladinSource.activeGroup, 'walk');
    assert.equal(walkGroup.calls.play.length, 1, 'walk clip played');
    assert.equal(runGroup.calls.stop, 1, 'run silenced (other motion clip)');
  });

  test('mid-chain (no motion, within sustain) freezes the clips → paused', () => {
    const inst = makeToggleInst({ run: true });
    // First play the run...
    inst._maybeTogglePaladinAnimation();
    assert.equal(inst._paladinSource.activeGroup, 'run');
    // ...then drop all motion but stay inside the sustain window.
    inst._activeMoveIds.clear();
    inst._activeRunMoveIds.clear();
    inst._maybeTogglePaladinAnimation();
    assert.equal(inst._paladinSource.activeGroup, 'paused',
      'no motion within sustain freezes rather than idling');
    assert.ok(inst._paladinSource.runGroup.calls.pause >= 1, 'run clip paused');
  });

  test('after the sustain window with no motion → idle', () => {
    const inst = makeToggleInst({ run: true });
    inst._maybeTogglePaladinAnimation(); // run
    // Force the last-walk timestamp far into the past so sustain has expired.
    inst._paladinLastWalkTs = performance.now() - 100000;
    inst._activeMoveIds.clear();
    inst._activeRunMoveIds.clear();
    inst._maybeTogglePaladinAnimation();
    assert.equal(inst._paladinSource.activeGroup, 'idle');
    assert.equal(inst._paladinSource.idleGroup.calls.play.length, 1, 'idle resumed');
  });

  test('an in-flight punch still owns the skeleton (no motion poke)', () => {
    const inst = makeToggleInst({ run: true });
    inst._paladinSource.punchPlaying = true;
    inst._paladinSource.activeGroup = 'punch';
    const { walkGroup, runGroup } = inst._paladinSource;
    inst._maybeTogglePaladinAnimation();
    assert.equal(inst._paladinSource.activeGroup, 'punch');
    assert.equal(runGroup.calls.play.length + runGroup.calls.stop, 0);
    assert.equal(walkGroup.calls.play.length + walkGroup.calls.stop, 0);
  });
});

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

// ── source-level guards (the Babylon-touching wiring we can't run headless) ──

describe('renderer-3d.js source — running wiring', () => {
  test('_loadRunningAnimation retargets onto the shared skeleton + strips root motion', () => {
    const start = _renderer3dSrc.indexOf('async _loadRunningAnimation(');
    assert.ok(start > 0, 'expected _loadRunningAnimation to be defined');
    // Bound the slice at the next method (the idle loader) so unrelated
    // ghost-skeleton code further down the file isn't pulled in.
    const end = _renderer3dSrc.indexOf('async _loadIdleAnimation(', start);
    assert.ok(end > start, 'expected _loadIdleAnimation to follow');
    const body = _renderer3dSrc.slice(start, end);
    assert.match(body, /RUNNING_MODEL_FILE/, 'imports running.glb via the model constant');
    assert.match(body, /stripRootBoneTranslation\(runForPaladin\)/,
      'strips root motion so the run animates in place');
    assert.match(body, /computeAnimSpeedRatioForStride/,
      'computes a stride-matched speedRatio from running’s own cycle');
    assert.match(body, /src\.runGroup\s*=\s*runForPaladin/,
      'stashes the retargeted group on _paladinSource.runGroup');
    // No skeleton clone — running shares the paladin rig like walk/idle/punch.
    assert.equal(/clone\(['"]ghost/.test(body), false,
      'running must not synthesize its own skeleton');
  });

  test('_ensureRunningAnimation is idempotent via _runningLoadPromise', () => {
    const start = _renderer3dSrc.indexOf("_ensureRunningAnimation(basePath = 'assets') {");
    assert.ok(start > 0, 'expected _ensureRunningAnimation method definition');
    const body = _renderer3dSrc.slice(start, start + 600);
    assert.match(body, /_runningLoadPromise/,
      'guards on _runningLoadPromise so the load fires at most once');
  });

  test('the paladin rig pre-warms running.glb off the critical path', () => {
    assert.match(_renderer3dSrc, /setTimeout\(\(\) => \{ this\._ensureRunningAnimation/,
      'running is pre-warmed via setTimeout like punch');
  });
});
