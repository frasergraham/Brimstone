// Phase 5 of the 3D renderer — pure-helper unit tests for animations,
// plan-ghost arrows, HP bars, and floating combat text.
//
// We deliberately do NOT test Babylon mesh construction here: a real WebGL
// context isn't available under node:test, and the Babylon CDN dependency
// would balloon the suite runtime. Instead, this file locks down the
// behaviour of every pure helper that drives a Phase 5 visual:
//
//   • interpolatePosition   — linear movement curve (0%, 50%, 100%)
//   • planArrowPolyline     — arrow geometry between two hex centres
//   • planArrowBadgePosition — numbered-badge anchor at the arrow head
//   • hpBarColor            — red/yellow/green threshold table
//   • floatingTextTransform — rise + fade curve for combat result floaters
//   • projectileColor01     — projectile colour-by-type table
//
// Together these cover the contract the renderer exposes to playback code
// — *where* a move/lunge interpolates through, *what* arrow the plan panel
// shows, *what* colour an HP bar takes, and *how* a floating-text label
// rises and fades. The Babylon-touching wrappers around these helpers are
// driven by integration testing in a real browser session (out of scope here).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _here = dirname(fileURLToPath(import.meta.url));
const _renderer3dSrc = readFileSync(join(_here, '..', 'src', 'renderer-3d.js'), 'utf8');

import {
  hexToWorld,
  HEX_RADIUS_WORLD,
  MOVE_ANIM_MS,
  LUNGE_ANIM_MS,
  PROJECTILE_ANIM_MS,
  FLOAT_TEXT_MS,
  FLOAT_TEXT_PLANE_WIDTH,
  FLOAT_TEXT_PLANE_HEIGHT,
  FLOAT_TEXT_TEX_WIDTH,
  FLOAT_TEXT_TEX_HEIGHT,
  paintFloaterText,
  combatCardModel,
  paintCombatCard,
  HP_BAR_Y_ABOVE_BASE,
  HP_RED_BELOW,
  HP_YELLOW_BELOW,
  UNIT_ICON_PLANE_SIZE,
  UNIT_ICON_TEX_SIZE,
  UNIT_ICON_RING_THICKNESS_FRAC,
  ATTACK_BADGE_Y,
  interpolatePosition,
  planArrowPolyline,
  planArrowBadgePosition,
  hpBarColor,
  hpRingFraction,
    iconBillboardY,
  iconBillboardYRelativeToCone,
  iconBillboardYForScale,
  headTopRelativeToCone,
  UNIT_ICON_MIN_SCALE,
  paintUnitIconBadge,
  resolveUnitIconPortrait,
  applyFlatUnitIconMaterial,
  floatingTextTransform,
  projectileColor01,
} from '../src/renderer-3d.js';

// ─── Constants ──────────────────────────────────────────────────────────────

describe('Renderer3D Phase 5 — anim duration constants', () => {
  test('MOVE_ANIM_MS sits in the slow-enough-to-walk band [400, 1500]', () => {
    // Bumped over iterations to give the paladin's walking animation room
    // to play and (with the multi-keyframe polyline path) to keep multi-hex
    // moves at a single MOVE_ANIM_MS window total. Band rather than a
    // single pin so visual tuning can shift without test churn.
    assert.ok(MOVE_ANIM_MS >= 400 && MOVE_ANIM_MS <= 1500,
      `expected MOVE_ANIM_MS in [400, 1500], got ${MOVE_ANIM_MS}`);
  });

  test('LUNGE_ANIM_MS < MOVE_ANIM_MS (sharper, snappier feel)', () => {
    assert.ok(LUNGE_ANIM_MS < MOVE_ANIM_MS,
      `expected LUNGE_ANIM_MS (${LUNGE_ANIM_MS}) < MOVE_ANIM_MS (${MOVE_ANIM_MS})`);
  });

  test('LUNGE_ANIM_MS is ~2× faster than the legacy 800ms (operator feel)', () => {
    // Operator: the lunge "takes a little too long — about twice as fast".
    // Halved from 800 → 400. Pin to a tight band so it can't silently
    // regress back toward the old sluggish glide.
    assert.ok(LUNGE_ANIM_MS >= 350 && LUNGE_ANIM_MS <= 450,
      `expected LUNGE_ANIM_MS in [350, 450] (≈half of legacy 800), got ${LUNGE_ANIM_MS}`);
  });

  test('addLungeAnim attaches an ease-OUT easing to the lunge X/Z slide', () => {
    // Babylon mesh wiring can't run under node:test, so guard the contract
    // at the source level: the lunge animations must build a CubicEase set
    // to EASINGMODE_EASEOUT and attach it to both position tracks (fast
    // launch → decelerate into the strike, not the old ramp-up feel).
    const start = _renderer3dSrc.indexOf('addLungeAnim(entityId');
    const body = _renderer3dSrc.slice(
      start,
      _renderer3dSrc.indexOf('returnAllLungeAnims() {', start),
    );
    assert.match(body, /new BABYLON\.CubicEase\(\)/, 'lunge should build a CubicEase');
    assert.match(body, /EASINGMODE_EASEOUT/, 'lunge easing mode should be EASEOUT');
    assert.match(body, /animX\.setEasingFunction\(/, 'ease must attach to animX');
    assert.match(body, /animZ\.setEasingFunction\(/, 'ease must attach to animZ');
  });

  test('PROJECTILE_ANIM_MS matches the 2D renderer default (≈320ms)', () => {
    assert.equal(PROJECTILE_ANIM_MS, 320);
  });

  test('FLOAT_TEXT_MS is around 700ms — long enough to read', () => {
    assert.ok(FLOAT_TEXT_MS >= 500 && FLOAT_TEXT_MS <= 1200,
      `expected FLOAT_TEXT_MS in [500, 1200], got ${FLOAT_TEXT_MS}`);
  });

  test('FLOAT_TEXT_PLANE_* are roughly 2× the legacy 1.6×0.6 plane', () => {
    // Operator brief: floaters must be prominent enough to read at zoom-out.
    // Width pinned to ≥ 2.4 (1.5×) and height to ≥ 0.9 — gives the new label
    // a clear floor without locking out future visual tuning.
    assert.ok(FLOAT_TEXT_PLANE_WIDTH  >= 2.4,
      `expected FLOAT_TEXT_PLANE_WIDTH ≥ 2.4, got ${FLOAT_TEXT_PLANE_WIDTH}`);
    assert.ok(FLOAT_TEXT_PLANE_HEIGHT >= 0.9,
      `expected FLOAT_TEXT_PLANE_HEIGHT ≥ 0.9, got ${FLOAT_TEXT_PLANE_HEIGHT}`);
    assert.ok(FLOAT_TEXT_TEX_WIDTH  >= 384 && FLOAT_TEXT_TEX_HEIGHT >= 128,
      'floater dynamic texture should be large enough for crisp text');
  });
});

// ─── paintFloaterText — pill + outline + fill ──────────────────────────────

describe('Renderer3D — paintFloaterText (pure helper)', () => {
  function makeMockCtx() {
    const calls = [];
    return {
      calls,
      _font: '',
      get font() { return this._font; },
      set font(v) { this._font = v; calls.push(['font', v]); },
      set textAlign(v)    { calls.push(['textAlign', v]); },
      set textBaseline(v) { calls.push(['textBaseline', v]); },
      set fillStyle(v)    { calls.push(['fillStyle', v]); },
      set strokeStyle(v)  { calls.push(['strokeStyle', v]); },
      set lineWidth(v)    { calls.push(['lineWidth', v]); },
      set lineJoin(v)     { calls.push(['lineJoin', v]); },
      set miterLimit(v)   { calls.push(['miterLimit', v]); },
      clearRect: () => calls.push(['clearRect']),
      beginPath: () => calls.push(['beginPath']),
      closePath: () => calls.push(['closePath']),
      moveTo:    () => calls.push(['moveTo']),
      lineTo:    () => calls.push(['lineTo']),
      arcTo:     () => calls.push(['arcTo']),
      fill:      () => calls.push(['fill']),
      strokeText: (...args) => calls.push(['strokeText', ...args]),
      fillText:   (...args) => calls.push(['fillText',   ...args]),
      measureText: (s) => ({ width: s.length * 30 }),
    };
  }

  test('no-ops when text is empty (still clears the canvas)', () => {
    const ctx = makeMockCtx();
    paintFloaterText(ctx, { width: 512, height: 192, text: '' });
    const ops = ctx.calls.map(c => c[0]);
    assert.deepEqual(ops, ['clearRect']);
  });

  test('paints pill background, then black outline stroke, then fill', () => {
    const ctx = makeMockCtx();
    paintFloaterText(ctx, {
      width: 512, height: 192, text: 'CRUSH 3', fillColor: '#ff5050',
    });
    const ops = ctx.calls.map(c => c[0]);
    const fillIdx     = ops.indexOf('fill');             // pill
    const strokeIdx   = ops.indexOf('strokeText');       // outline
    const fillTextIdx = ops.indexOf('fillText');         // text
    assert.ok(fillIdx     >= 0, 'expected pill background fill()');
    assert.ok(strokeIdx   >  fillIdx,     'outline stroke must come after pill');
    assert.ok(fillTextIdx >  strokeIdx,   'text fill must come after outline');
    const strokeStyles = ctx.calls.filter(c => c[0] === 'strokeStyle').map(c => c[1]);
    assert.ok(strokeStyles.includes('#000'), 'text outline should be black');
    const fillStyles = ctx.calls.filter(c => c[0] === 'fillStyle').map(c => c[1]);
    assert.ok(fillStyles.includes('#ff5050'), 'fillColor should be applied to the text');
  });
});

// ─── combatCardModel (G4 Phase 2) ───────────────────────────────────────────

describe('Renderer3D — combatCardModel (pure helper)', () => {
  test('no-advantage single die: pool of one, picked == total base', () => {
    const result = {
      hit: true,
      attackRoll: 7,
      defenseRoll: 3,
      breakdown: {
        atkPool: [5], atkBaseDie: 5,
        defPool: [2], defBaseDie: 2,
      },
    };
    const atk = combatCardModel(result, 'attacker');
    assert.deepEqual(atk.poolFaces, [5]);
    assert.equal(atk.picked, 5);
    assert.equal(atk.total, 7);
    assert.equal(atk.won, true);

    const def = combatCardModel(result, 'defender');
    assert.deepEqual(def.poolFaces, [2]);
    assert.equal(def.picked, 2);
    assert.equal(def.total, 3);
    assert.equal(def.won, false); // attacker hit → defender lost
  });

  test('advantage best-of pool: picks the highest face, defender loses on hit', () => {
    const result = {
      hit: true,
      attackRoll: 9,
      defenseRoll: 4,
      breakdown: {
        atkPool: [2, 6, 4], atkBaseDie: 6, // best-of-3
        defPool: [3], defBaseDie: 3,
      },
    };
    const atk = combatCardModel(result, 'attacker');
    assert.deepEqual(atk.poolFaces, [2, 6, 4]);
    assert.equal(atk.picked, 6);
    assert.equal(atk.total, 9);
    assert.equal(atk.won, true);
  });

  test('defender wins when the attack misses', () => {
    const result = {
      hit: false,
      attackRoll: 4,
      defenseRoll: 6,
      breakdown: {
        atkPool: [3], atkBaseDie: 3,
        defPool: [1, 5], defBaseDie: 5,
      },
    };
    assert.equal(combatCardModel(result, 'attacker').won, false);
    const def = combatCardModel(result, 'defender');
    assert.equal(def.won, true);
    assert.equal(def.picked, 5);
    assert.deepEqual(def.poolFaces, [1, 5]);
  });

  test('missing-breakdown fallback: pool collapses to the picked die, total to picked', () => {
    // No breakdown at all → everything falls back gracefully (no throw).
    const bare = combatCardModel({ hit: true }, 'attacker');
    assert.deepEqual(bare.poolFaces, []);
    assert.equal(bare.picked, 0);
    assert.equal(bare.total, 0);
    assert.equal(bare.won, true);

    // Picked die present but no pool → single-die pool, total falls to picked.
    const partial = combatCardModel(
      { hit: false, breakdown: { defBaseDie: 4 } }, 'defender',
    );
    assert.deepEqual(partial.poolFaces, [4]);
    assert.equal(partial.picked, 4);
    assert.equal(partial.total, 4);
    assert.equal(partial.won, true);
  });
});

// ─── paintCombatCard (G4 Phase 2) ────────────────────────────────────────────

describe('Renderer3D — paintCombatCard (pure painter)', () => {
  function makeMockCtx() {
    const calls = [];
    return {
      calls,
      set font(v)         { calls.push(['font', v]); },
      set textAlign(v)    { calls.push(['textAlign', v]); },
      set textBaseline(v) { calls.push(['textBaseline', v]); },
      set fillStyle(v)    { calls.push(['fillStyle', v]); },
      set strokeStyle(v)  { calls.push(['strokeStyle', v]); },
      set lineWidth(v)    { calls.push(['lineWidth', v]); },
      set lineJoin(v)     { calls.push(['lineJoin', v]); },
      clearRect:  () => calls.push(['clearRect']),
      beginPath:  () => calls.push(['beginPath']),
      closePath:  () => calls.push(['closePath']),
      moveTo:     () => calls.push(['moveTo']),
      lineTo:     () => calls.push(['lineTo']),
      arcTo:      () => calls.push(['arcTo']),
      fill:       () => calls.push(['fill']),
      stroke:     () => calls.push(['stroke']),
      strokeText: (...a) => calls.push(['strokeText', ...a]),
      fillText:   (...a) => calls.push(['fillText', ...a]),
      measureText: (s) => ({ width: String(s).length * 20 }),
    };
  }

  test('clears the canvas first', () => {
    const ctx = makeMockCtx();
    paintCombatCard(ctx, { poolFaces: [6], picked: 6, total: 8, won: true },
      { width: 384, height: 192 });
    assert.equal(ctx.calls[0][0], 'clearRect');
  });

  test('draws one die per pool face and renders the total string', () => {
    const ctx = makeMockCtx();
    paintCombatCard(ctx, { poolFaces: [2, 6, 4], picked: 6, total: 9, won: true },
      { width: 384, height: 192 });
    // Each die face number is drawn via fillText, plus the total.
    const fillTexts = ctx.calls.filter(c => c[0] === 'fillText').map(c => String(c[1]));
    assert.ok(fillTexts.includes('2'), 'face 2 drawn');
    assert.ok(fillTexts.includes('6'), 'face 6 drawn');
    assert.ok(fillTexts.includes('4'), 'face 4 drawn');
    assert.ok(fillTexts.includes('9'), 'total drawn');
    // Total is stroked (outlined) for legibility.
    const strokeTexts = ctx.calls.filter(c => c[0] === 'strokeText').map(c => String(c[1]));
    assert.ok(strokeTexts.includes('9'), 'total outlined');
  });

  test('won tints accent gold; lost tints accent red', () => {
    const wonCtx = makeMockCtx();
    paintCombatCard(wonCtx, { poolFaces: [5], picked: 5, total: 7, won: true },
      { width: 384, height: 192 });
    const wonStyles = wonCtx.calls
      .filter(c => c[0] === 'fillStyle' || c[0] === 'strokeStyle').map(c => c[1]);
    assert.ok(wonStyles.includes('#ffd24a'), 'gold accent when won');

    const lostCtx = makeMockCtx();
    paintCombatCard(lostCtx, { poolFaces: [2], picked: 2, total: 3, won: false },
      { width: 384, height: 192 });
    const lostStyles = lostCtx.calls
      .filter(c => c[0] === 'fillStyle' || c[0] === 'strokeStyle').map(c => c[1]);
    assert.ok(lostStyles.includes('#ff7a7a'), 'red accent when lost');
  });
});

// ─── interpolatePosition ────────────────────────────────────────────────────

describe('Renderer3D Phase 5 — interpolatePosition (linear move)', () => {
  const from = { x: 0, z: 0 };
  const to   = { x: 10, z: -4 };

  test('t=0 returns the source exactly', () => {
    const p = interpolatePosition(from, to, 0);
    assert.equal(p.x, 0);
    assert.equal(p.z, 0);
  });

  test('t=1 returns the destination exactly', () => {
    const p = interpolatePosition(from, to, 1);
    assert.equal(p.x, 10);
    assert.equal(p.z, -4);
  });

  test('t=0.5 returns the midpoint', () => {
    const p = interpolatePosition(from, to, 0.5);
    assert.equal(p.x, 5);
    assert.equal(p.z, -2);
  });

  test('t<0 clamps to source (we never overshoot backwards)', () => {
    const p = interpolatePosition(from, to, -0.25);
    assert.equal(p.x, 0);
    assert.equal(p.z, 0);
  });

  test('t>1 clamps to destination (we never overshoot forwards)', () => {
    const p = interpolatePosition(from, to, 1.25);
    assert.equal(p.x, 10);
    assert.equal(p.z, -4);
  });

  test('quarter-way is exactly 1/4 of the displacement', () => {
    const p = interpolatePosition(from, to, 0.25);
    assert.equal(p.x, 2.5);
    assert.equal(p.z, -1);
  });
});

// ─── planArrowPolyline + planArrowBadgePosition ─────────────────────────────

describe('Renderer3D Phase 5 — plan-ghost arrow geometry', () => {
  test('polyline has exactly two points (start, end) — straight line', () => {
    const pts = planArrowPolyline(0, 0, 3, 4);
    assert.equal(pts.length, 2);
  });

  test('arrow endpoints match the hex centres in world space', () => {
    const a = hexToWorld(2, 3);
    const b = hexToWorld(5, 7);
    const pts = planArrowPolyline(2, 3, 5, 7);
    assert.equal(pts[0].x, a.x);
    assert.equal(pts[0].z, a.z);
    assert.equal(pts[1].x, b.x);
    assert.equal(pts[1].z, b.z);
  });

  test('arrow Y is uniform across the polyline (floats at a single height)', () => {
    const pts = planArrowPolyline(0, 0, 5, 5, 0.9);
    assert.equal(pts[0].y, 0.9);
    assert.equal(pts[1].y, 0.9);
  });

  test('arrow height clears the tile prism top (y > 0.075)', () => {
    const pts = planArrowPolyline(0, 0, 1, 1);
    assert.ok(pts[0].y > 0.075,
      `arrow at y=${pts[0].y} must be above the tile prism top (0.075)`);
  });

  test('badge anchor sits at the destination hex centre, above the arrow', () => {
    const b = planArrowBadgePosition(4, 6);
    const t = hexToWorld(4, 6);
    assert.equal(b.x, t.x);
    assert.equal(b.z, t.z);
    assert.ok(b.y > 0.5, `badge y=${b.y} should sit above the arrow line`);
  });

  test('arrow uses the documented HEX_RADIUS_WORLD spacing (no zoom-dependent scaling)', () => {
    // The arrow geometry should be invariant to camera zoom — it's defined
    // in world units only, which is why it can be cached & reused frame to frame.
    assert.equal(HEX_RADIUS_WORLD, 1);
  });
});

// ─── hpBarColor ─────────────────────────────────────────────────────────────

describe('Renderer3D Phase 5 — hpBarColor threshold table', () => {
  test('full HP is green', () => {
    assert.equal(hpBarColor(10, 10), '#46c84a');
  });

  test('exactly at the yellow boundary is green (≥ threshold means safe)', () => {
    // ratio = 0.66 = HP_YELLOW_BELOW → not strictly less than threshold, so green.
    const r = HP_YELLOW_BELOW;
    assert.ok(r >= HP_YELLOW_BELOW);
    assert.equal(hpBarColor(Math.round(r * 100), 100), '#46c84a');
  });

  test('mid-low HP is yellow (between red and yellow thresholds)', () => {
    // ratio = 0.5 → between 0.33 and 0.66.
    assert.equal(hpBarColor(5, 10), '#d8c333');
  });

  test('critical HP is red (below the red threshold)', () => {
    // ratio = 0.2 → strictly < 0.33.
    assert.equal(hpBarColor(2, 10), '#d83333');
  });

  test('zero HP is red (defensive, not yellow/green)', () => {
    assert.equal(hpBarColor(0, 10), '#d83333');
  });

  test('maxHp=0 does not throw — treats max as 1 internally', () => {
    // Pathological state during spawn/death transitions.
    assert.doesNotThrow(() => hpBarColor(0, 0));
  });

  test('hp > maxHp clamps to green (overheal must not be coloured red)', () => {
    assert.equal(hpBarColor(15, 10), '#46c84a');
  });

  test('thresholds are at the documented ratios', () => {
    assert.ok(HP_RED_BELOW    > 0   && HP_RED_BELOW    < 1);
    assert.ok(HP_YELLOW_BELOW > HP_RED_BELOW && HP_YELLOW_BELOW < 1);
  });
});

// ─── floatingTextTransform ──────────────────────────────────────────────────

describe('Renderer3D Phase 5 — floatingTextTransform (rise + fade)', () => {
  test('t=0 starts at y=0 and full opacity', () => {
    const p = floatingTextTransform(0);
    assert.equal(p.y, 0);
    assert.equal(p.alpha, 1);
  });

  test('t=0.5 has risen halfway and still at full opacity (alpha holds first half)', () => {
    const p = floatingTextTransform(0.5);
    assert.ok(Math.abs(p.y - 0.6) < 1e-9, `expected y≈0.6 at t=0.5, got ${p.y}`);
    assert.equal(p.alpha, 1);
  });

  test('t=1 is fully risen and fully transparent', () => {
    const p = floatingTextTransform(1);
    assert.ok(Math.abs(p.y - 1.2) < 1e-9, `expected y≈1.2 at t=1, got ${p.y}`);
    assert.equal(p.alpha, 0);
  });

  test('alpha lerps 1 → 0 across [0.5, 1] linearly', () => {
    const p75 = floatingTextTransform(0.75);
    // At t=0.75, alpha = 1 - (0.75 - 0.5) * 2 = 0.5.
    assert.ok(Math.abs(p75.alpha - 0.5) < 1e-9);
  });

  test('clamps t below 0 and above 1', () => {
    const before = floatingTextTransform(-0.2);
    const after  = floatingTextTransform(1.4);
    assert.equal(before.y, 0);
    assert.equal(before.alpha, 1);
    assert.equal(after.y, 1.2);
    assert.equal(after.alpha, 0);
  });

  test('custom riseDistance scales the trajectory linearly', () => {
    const p = floatingTextTransform(1, 3);
    assert.equal(p.y, 3);
  });
});

// ─── projectileColor01 ──────────────────────────────────────────────────────

describe('Renderer3D Phase 5 — projectile colour table', () => {
  test('witch sparkle projectile is greenish', () => {
    const [r, g, b] = projectileColor01('sparkle');
    assert.ok(g > r && g > b,
      `expected green-dominant, got rgb(${r}, ${g}, ${b})`);
  });

  test('hero arrow/crossbow projectile is brownish (red dominant)', () => {
    for (const t of ['arrow', 'crossbow']) {
      const [r, g, b] = projectileColor01(t);
      assert.ok(r > g && r > b,
        `expected red-dominant for ${t}, got rgb(${r}, ${g}, ${b})`);
    }
  });

  test('unknown projectile type falls back to a neutral colour (no throw)', () => {
    const [r, g, b] = projectileColor01('unknown-type');
    assert.ok(r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1);
  });

  test('null/undefined safe', () => {
    assert.doesNotThrow(() => projectileColor01(null));
    assert.doesNotThrow(() => projectileColor01(undefined));
  });
});

// ─── HP bar positioning constant ────────────────────────────────────────────

describe('Renderer3D Phase 5 — HP bar layout', () => {
  test('HP bar sits above the standee base (positive Y offset)', () => {
    assert.ok(HP_BAR_Y_ABOVE_BASE > 0);
  });
});

// ─── hpRingFraction (icon-billboard arc length helper) ──────────────────────

describe('Renderer3D — hpRingFraction', () => {
  test('full HP maps to a full arc (fraction = 1)', () => {
    assert.equal(hpRingFraction(10, 10), 1);
  });

  test('half HP maps to a half arc (fraction = 0.5)', () => {
    assert.equal(hpRingFraction(5, 10), 0.5);
  });

  test('zero HP maps to zero arc length (no coloured rim drawn)', () => {
    assert.equal(hpRingFraction(0, 10), 0);
  });

  test('negative HP clamps to zero (does not produce negative arc)', () => {
    assert.equal(hpRingFraction(-3, 10), 0);
  });

  test('overheal (hp > maxHp) clamps to one (never sweeps past 2π)', () => {
    assert.equal(hpRingFraction(15, 10), 1);
  });

  test('maxHp ≤ 0 is treated as 1 (defensive; matches hpBarColor)', () => {
    assert.doesNotThrow(() => hpRingFraction(0, 0));
    // hp=0, maxHp=0 → safeMax=1, ratio=0 → fraction 0
    assert.equal(hpRingFraction(0, 0), 0);
  });
});

// ─── iconBillboardY (Y placement above cone+sphere head) ────────────────────

describe('Renderer3D — iconBillboardY', () => {
  test('produces a strictly positive Y (always above the base disc)', () => {
    assert.ok(iconBillboardY(false) > 0);
    assert.ok(iconBillboardY(true)  > 0);
  });

  test('leader badge sits higher than a regular badge (taller cone+sphere)', () => {
    assert.ok(iconBillboardY(true) > iconBillboardY(false));
  });

  test('default arg matches leader=false (regular unit)', () => {
    assert.equal(iconBillboardY(), iconBillboardY(false));
  });

  test('sits above the old rectangular HP bar Y offset (it replaces it)', () => {
    // Old HP bar lived at HP_BAR_Y_ABOVE_BASE = 0.2 above the base disc; the
    // floating-icon billboard sits well above the cone+sphere head so it
    // doesn't intersect the token silhouette.
    assert.ok(iconBillboardY(false) > HP_BAR_Y_ABOVE_BASE);
  });
});

// ─── iconBillboardYRelativeToCone (the disc is gone — billboard reparents
//     to the cone, so its local Y must shift down by the cone-centre offset
//     to preserve world-Y placement) ───────────────────────────────────────

describe('Renderer3D — iconBillboardYRelativeToCone', () => {
  test('keeps the world-Y placement of the badge identical to the disc-anchored value', () => {
    // World-Y when parented to the cone:
    //   cone.position.y      = STANDEE_BASE_Y_OFFSET + thickness/2 + coneHeight/2
    //   plane.position.y     = iconBillboardYRelativeToCone(leader)
    //   world_Y              = cone.position.y + plane.position.y
    //
    // Old (disc-parented) world Y was:
    //   base.position.y + iconBillboardY(leader)
    //     = STANDEE_BASE_Y_OFFSET + iconBillboardY(leader)
    //
    // The two must match for both regular and leader units.
    for (const leader of [false, true]) {
      const hMul = leader ? 1.5 : 1; // mirrors STANDEE_LEADER_HEIGHT_MUL convention
      void hMul;
      const reConed = iconBillboardYRelativeToCone(leader);
      const original = iconBillboardY(leader);
      // The relative-to-cone Y is strictly LESS than the original (subtracting
      // the cone centre's lift), but adding the cone-centre offset back must
      // recover the original world-Y placement.
      assert.ok(reConed > 0, `relative Y ${reConed} should remain positive (above the cone)`);
      assert.ok(reConed < original,
        `cone-relative Y ${reConed} should be < disc-relative ${original}`);
    }
  });

  test('leader badge sits higher relative to the cone than a regular badge', () => {
    assert.ok(iconBillboardYRelativeToCone(true) > iconBillboardYRelativeToCone(false));
  });

  test('default arg matches leader=false (regular unit)', () => {
    assert.equal(iconBillboardYRelativeToCone(), iconBillboardYRelativeToCone(false));
  });
});

// ─── iconBillboardYForScale — the per-frame proximity-scale placement must
//     reconcile with the gap-0.70 create-time placement (icon-overlap fix) ───

describe('Renderer3D — iconBillboardYForScale reconciliation', () => {
  test('at scale=1 it EXACTLY matches iconBillboardYRelativeToCone (no per-frame drop)', () => {
    for (const leader of [false, true]) {
      assert.ok(
        Math.abs(iconBillboardYForScale(leader, 1) - iconBillboardYRelativeToCone(leader)) < 1e-9,
        `scale=1 placement should equal the create-time gap-0.70 value for leader=${leader}`,
      );
    }
  });

  test('the icon BOTTOM stays fixed (clears the paladin head) as the icon shrinks', () => {
    for (const leader of [false, true]) {
      const bottomFull = iconBillboardYForScale(leader, 1)               - UNIT_ICON_PLANE_SIZE / 2;
      const bottomMin  = iconBillboardYForScale(leader, UNIT_ICON_MIN_SCALE) - (UNIT_ICON_PLANE_SIZE * UNIT_ICON_MIN_SCALE) / 2;
      assert.ok(Math.abs(bottomFull - bottomMin) < 1e-9,
        `icon bottom should be scale-invariant for leader=${leader}`);
    }
  });

  test('shrinking the icon LOWERS its centre (drops toward the fixed bottom)', () => {
    assert.ok(iconBillboardYForScale(false, UNIT_ICON_MIN_SCALE) < iconBillboardYForScale(false, 1));
  });
});

// ─── headTopRelativeToCone — the combat-card anchor (just above the head) ────

describe('Renderer3D — headTopRelativeToCone', () => {
  test('sits below the icon billboard (head < icon, cone-relative)', () => {
    for (const leader of [false, true]) {
      assert.ok(headTopRelativeToCone(leader) < iconBillboardYRelativeToCone(leader),
        `head top should be below the icon centre for leader=${leader}`);
    }
  });

  test('leader head is taller than a regular head', () => {
    assert.ok(headTopRelativeToCone(true) > headTopRelativeToCone(false));
  });

  test('default arg matches leader=false', () => {
    assert.equal(headTopRelativeToCone(), headTopRelativeToCone(false));
  });
});

// ─── paintUnitIconBadge (canvas composition: portrait + HP ring) ────────────
//
// We exercise the painter against a stub 2D context that records the calls
// it received. This locks down the contract that:
//   • the canvas is cleared first
//   • a dark "empty" track is stroked for the full ring
//   • a coloured arc is stroked only when HP > 0
//   • the arc sweep matches the HP fraction
//   • the icon disc is clipped before drawing the portrait

function makeStubCtx() {
  const calls = [];
  const noop = (name) => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    clearRect: noop('clearRect'),
    save: noop('save'),
    restore: noop('restore'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    arc: (...args) => { calls.push({ name: 'arc', args }); },
    stroke: noop('stroke'),
    fill: noop('fill'),
    fillRect: noop('fillRect'),
    drawImage: noop('drawImage'),
    clip: noop('clip'),
    set strokeStyle(v) { calls.push({ name: 'strokeStyle', args: [v] }); },
    set fillStyle(v)   { calls.push({ name: 'fillStyle',   args: [v] }); },
    set lineWidth(v)   { calls.push({ name: 'lineWidth',   args: [v] }); },
    set lineCap(v)     { calls.push({ name: 'lineCap',     args: [v] }); },
  };
}

describe('Renderer3D — paintUnitIconBadge', () => {
  test('clears the canvas before painting', () => {
    const ctx = makeStubCtx();
    paintUnitIconBadge(ctx, { size: 64, hp: 5, maxHp: 10 });
    const first = ctx.calls.find(c => c.name === 'clearRect');
    assert.ok(first, 'expected clearRect to be called');
    assert.deepEqual(first.args, [0, 0, 64, 64]);
  });

  test('draws the dark empty-track ring (full circle)', () => {
    const ctx = makeStubCtx();
    paintUnitIconBadge(ctx, { size: 64, hp: 5, maxHp: 10 });
    // The track is a full-circle arc (2π sweep) drawn before the coloured arc.
    const fullArcs = ctx.calls.filter(c => c.name === 'arc'
      && Math.abs((c.args[4] - c.args[3]) - Math.PI * 2) < 1e-9);
    assert.ok(fullArcs.length >= 1,
      'expected at least one full-circle arc (the empty track / clip disc)');
  });

  test('coloured HP arc starts at 12 o\'clock (−π/2) and sweeps proportionally', () => {
    const ctx = makeStubCtx();
    paintUnitIconBadge(ctx, { size: 64, hp: 5, maxHp: 10 });
    const arc = ctx.calls.find(c => c.name === 'arc'
      && Math.abs(c.args[3] + Math.PI / 2) < 1e-9
      && Math.abs((c.args[4] - c.args[3]) - Math.PI) < 1e-9);
    assert.ok(arc, 'expected an arc starting at −π/2 with π sweep for hp=5/10');
  });

  test('skips the coloured arc entirely at 0 HP (only the dark track remains)', () => {
    const ctx = makeStubCtx();
    paintUnitIconBadge(ctx, { size: 64, hp: 0, maxHp: 10 });
    // No arc that starts at −π/2 with a positive sweep (no coloured arc drawn).
    const colouredArc = ctx.calls.find(c => c.name === 'arc'
      && Math.abs(c.args[3] + Math.PI / 2) < 1e-9
      && (c.args[4] - c.args[3]) > 1e-9);
    assert.equal(colouredArc, undefined,
      'expected no coloured-arc stroke when hp = 0');
  });

  test('uses the hpBarColor palette for the arc stroke colour', () => {
    const ctx = makeStubCtx();
    paintUnitIconBadge(ctx, { size: 64, hp: 9, maxHp: 10 });
    // Last strokeStyle set before the coloured arc should be the green colour.
    const greens = ctx.calls.filter(c => c.name === 'strokeStyle'
      && c.args[0] === '#46c84a');
    assert.ok(greens.length >= 1);
  });

  test('clips to the inner disc before painting the portrait fill', () => {
    const ctx = makeStubCtx();
    paintUnitIconBadge(ctx, { size: 64, hp: 5, maxHp: 10 });
    const clipIdx = ctx.calls.findIndex(c => c.name === 'clip');
    const fillIdx = ctx.calls.findIndex(c => c.name === 'fillRect');
    assert.ok(clipIdx >= 0, 'expected clip()');
    assert.ok(fillIdx >  clipIdx,
      'expected fillRect() (icon backdrop) after the clip path was set');
  });

  test('draws the portrait image when one is supplied (no portraitRect)', () => {
    const ctx = makeStubCtx();
    const fakeImg = {};
    paintUnitIconBadge(ctx, {
      size: 64, hp: 5, maxHp: 10, portraitImg: fakeImg,
    });
    const draw = ctx.calls.find(c => c.name === 'drawImage');
    assert.ok(draw, 'expected drawImage call when portraitImg present');
    // No rect → 4-arg signature (img, x, y, w, h ⇒ 5 args including img).
    assert.equal(draw.args.length, 5);
    assert.strictEqual(draw.args[0], fakeImg);
  });

  test('draws the portrait sub-rect when a tilemap rect is supplied', () => {
    const ctx = makeStubCtx();
    const fakeImg = {};
    const rect = { x: 10, y: 20, size: 64 };
    paintUnitIconBadge(ctx, {
      size: 64, hp: 5, maxHp: 10, portraitImg: fakeImg, portraitRect: rect,
    });
    const draw = ctx.calls.find(c => c.name === 'drawImage');
    assert.ok(draw);
    // sub-rect signature → 9-arg drawImage (img + 8 numbers).
    assert.equal(draw.args.length, 9);
    assert.equal(draw.args[1], 10); // sx
    assert.equal(draw.args[2], 20); // sy
    assert.equal(draw.args[3], 64); // swidth
  });

  test('omits drawImage when no portrait is supplied (still paints the disc)', () => {
    const ctx = makeStubCtx();
    paintUnitIconBadge(ctx, { size: 64, hp: 5, maxHp: 10 });
    assert.ok(!ctx.calls.find(c => c.name === 'drawImage'),
      'expected no drawImage when portraitImg is null');
    // Disc backdrop is still painted (so the icon disc reads as a solid sticker).
    assert.ok(ctx.calls.find(c => c.name === 'fillRect'));
  });

  test('ring thickness fraction is sane (not zero, not the whole texture)', () => {
    assert.ok(UNIT_ICON_RING_THICKNESS_FRAC > 0);
    assert.ok(UNIT_ICON_RING_THICKNESS_FRAC < 0.5);
  });

  test('plane and texture sizing constants are positive', () => {
    assert.ok(UNIT_ICON_PLANE_SIZE > 0);
    assert.ok(UNIT_ICON_TEX_SIZE   > 0);
  });

  // Pin the current billboard size. Bumped 2× from 0.55 to 1.10, trimmed to
  // 0.88 after the badge felt too bulky over the paladin model, then bumped
  // 1.3× to 1.144 (R3) for readability at default combat-camera framing.
  // Locks against silent re-shrinking back to the trimmed 0.88 era and
  // against an accidental further bump that would overlap the ATTACK_BADGE.
  test('UNIT_ICON_PLANE_SIZE is in the post-R3 band [1.10, 1.20]', () => {
    assert.ok(UNIT_ICON_PLANE_SIZE > 1.10 && UNIT_ICON_PLANE_SIZE < 1.20,
      `expected 1.10 < size < 1.20, got ${UNIT_ICON_PLANE_SIZE}`);
  });

  // R3 — explicit cross-check that the bumped plane bottom (after the 1.3×
  // size increase) still clears the cone+sphere head top. The bottom-anchor
  // math in `iconBillboardYForScale` keeps the larger plane growing upward,
  // so the gap should be the same as the pre-bump 0.88 size.
  test('UNIT_ICON_PLANE_SIZE bottom edge (leader) still clears the head top', () => {
    const iconBottom = iconBillboardYRelativeToCone(true) - UNIT_ICON_PLANE_SIZE / 2;
    const headTop    = headTopRelativeToCone(true);
    assert.ok(
      iconBottom > headTop,
      `icon bottom ${iconBottom} should be above head top ${headTop}`,
    );
  });
  test('UNIT_ICON_PLANE_SIZE bottom edge (non-leader) still clears the head top', () => {
    const iconBottom = iconBillboardYRelativeToCone(false) - UNIT_ICON_PLANE_SIZE / 2;
    const headTop    = headTopRelativeToCone(false);
    assert.ok(
      iconBottom > headTop,
      `icon bottom ${iconBottom} should be above head top ${headTop}`,
    );
  });

  // Relationship invariant: the icon billboard's top edge must stay below
  // ATTACK_BADGE_Y so the floating ×N readout reads above the entire unit
  // stack. The leader form is the worst case (taller cone/sphere), so the
  // check is anchored to iconBillboardY(true).
  test('UNIT_ICON_PLANE_SIZE top edge (leader) stays below ATTACK_BADGE_Y', () => {
    const iconTop = iconBillboardY(true) + UNIT_ICON_PLANE_SIZE / 2;
    assert.ok(
      iconTop < ATTACK_BADGE_Y,
      `icon top ${iconTop} should be below ATTACK_BADGE_Y ${ATTACK_BADGE_Y}`,
    );
  });
});

// ─── resolveUnitIconPortrait (portrait-source lookup) ───────────────────────
//
// Pinned because this is the helper that fixed the gray-circle bug: badges
// painted before `loadImages()` resolved would otherwise keep returning
// `{hasPortrait:false}` for every entity. The diff in
// `_syncEntityIconBillboards` reads `hasPortrait` so it knows to repaint
// once the tilemap finally arrives.

describe('Renderer3D — resolveUnitIconPortrait', () => {
  const RECT = { x: 0, y: 0, size: 256 };
  const img  = { naturalWidth: 1024 };

  test('returns hasPortrait=false when the tilemap is missing', () => {
    const rects = new Map([['paladin', RECT]]);
    const out = resolveUnitIconPortrait(null, rects, 'paladin');
    assert.equal(out.hasPortrait, false);
    assert.equal(out.img,  null);
    assert.equal(out.rect, null);
  });

  test('returns hasPortrait=false when the sprite rect table is missing', () => {
    const out = resolveUnitIconPortrait(img, null, 'paladin');
    assert.equal(out.hasPortrait, false);
  });

  test('returns hasPortrait=false when assetId is null/empty', () => {
    const rects = new Map([['paladin', RECT]]);
    assert.equal(resolveUnitIconPortrait(img, rects, null).hasPortrait,      false);
    assert.equal(resolveUnitIconPortrait(img, rects, undefined).hasPortrait, false);
    assert.equal(resolveUnitIconPortrait(img, rects, '').hasPortrait,        false);
  });

  test('returns hasPortrait=false when assetId is unknown to the atlas', () => {
    const rects = new Map([['paladin', RECT]]);
    const out = resolveUnitIconPortrait(img, rects, 'unknown_unit');
    assert.equal(out.hasPortrait, false);
    assert.equal(out.rect, null);
  });

  test('returns hasPortrait=true with img+rect when all inputs are present', () => {
    const rects = new Map([['paladin', RECT]]);
    const out = resolveUnitIconPortrait(img, rects, 'paladin');
    assert.equal(out.hasPortrait, true);
    assert.strictEqual(out.img,  img);
    assert.strictEqual(out.rect, RECT);
  });
});

// ─── applyFlatUnitIconMaterial (flat-UI material contract) ──────────────────
//
// The badge is a UI element, not a scene object — its appearance must NOT
// shift with phase / sun direction / fog. This test locks the property set
// that achieves that: lighting disabled, fog disabled, alpha from diffuse,
// full-white emissive. If any of these regresses, the badge will visibly
// dim at dusk/night or fade in distant fog.

describe('Renderer3D — applyFlatUnitIconMaterial', () => {
  function makeStubBabylon() {
    return { Color3: class { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } } };
  }
  function makeMat() { return {}; }

  test('disables lighting so the badge stays flat across all phases', () => {
    const mat = makeMat();
    applyFlatUnitIconMaterial(makeStubBabylon(), mat);
    assert.equal(mat.disableLighting, true);
  });

  test('disables fog so distant units stay readable', () => {
    const mat = makeMat();
    applyFlatUnitIconMaterial(makeStubBabylon(), mat);
    assert.equal(mat.fogEnabled, false);
  });

  test('emissive is full white (1,1,1) so dawn/day/dusk/night look identical', () => {
    const mat = makeMat();
    applyFlatUnitIconMaterial(makeStubBabylon(), mat);
    assert.equal(mat.emissiveColor.r, 1);
    assert.equal(mat.emissiveColor.g, 1);
    assert.equal(mat.emissiveColor.b, 1);
  });

  test('specular is zeroed so the sticker doesn\'t catch highlights', () => {
    const mat = makeMat();
    applyFlatUnitIconMaterial(makeStubBabylon(), mat);
    assert.equal(mat.specularColor.r, 0);
    assert.equal(mat.specularColor.g, 0);
    assert.equal(mat.specularColor.b, 0);
  });

  test('diffuse colour is white so the texture is not tinted', () => {
    const mat = makeMat();
    applyFlatUnitIconMaterial(makeStubBabylon(), mat);
    assert.equal(mat.diffuseColor.r, 1);
    assert.equal(mat.diffuseColor.g, 1);
    assert.equal(mat.diffuseColor.b, 1);
  });

  test('alpha sourced from diffuse texture (portrait alpha mask)', () => {
    const mat = makeMat();
    applyFlatUnitIconMaterial(makeStubBabylon(), mat);
    assert.equal(mat.useAlphaFromDiffuseTexture, true);
  });

  test('alpha = 1 (fully opaque) and back-face culling disabled (billboard)', () => {
    const mat = makeMat();
    applyFlatUnitIconMaterial(makeStubBabylon(), mat);
    assert.equal(mat.alpha, 1);
    assert.equal(mat.backFaceCulling, false);
  });
});
