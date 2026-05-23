import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYERS, Y_TABLE, yForLayer, OVERLAY_KINDS,
  makeOverlay, overlaySignature, installOverlayShims,
  ringPulseState, overlayMaterialKey,
} from '../src/overlays.js';

describe('LAYERS', () => {
  test('order is stable and frozen', () => {
    assert.deepEqual(LAYERS, [
      'objective-tint', 'fill', 'plan-line', 'outline', 'selection',
      'objective-ring', 'highlight-disc', 'plan-arrow', 'flash', 'spotlight',
    ]);
    assert.ok(Object.isFrozen(LAYERS));
    assert.ok(Object.isFrozen(Y_TABLE));
  });
});

describe('yForLayer', () => {
  test('base index returns band min', () => {
    assert.equal(yForLayer('fill', 0), 0.060);
  });
  test('large index clamps to band max', () => {
    assert.equal(yForLayer('fill', 100), 0.075);
  });
  test('unknown layer throws', () => {
    assert.throws(() => yForLayer('nonsense', 0));
  });
});

describe('makeOverlay', () => {
  test('unknown kind throws', () => {
    assert.throws(() => makeOverlay({ id: 'x', kind: 'bogus', layer: 'fill', hexes: [], style: {} }));
  });
  test('unknown layer throws', () => {
    assert.throws(() => makeOverlay({ id: 'x', kind: 'fill', layer: 'bogus', hexes: [], style: {} }));
  });
  test('empty id throws', () => {
    assert.throws(() => makeOverlay({ id: '', kind: 'fill', layer: 'fill', hexes: [], style: {} }));
  });
  test('normalises hexes to a Set of keys and freezes', () => {
    const ov = makeOverlay({
      id: 'x', kind: 'fill', layer: 'fill',
      hexes: [{ col: 1, row: 2 }, { col: 3, row: 4 }], style: { color: '#fff' },
    });
    assert.ok(ov.hexes instanceof Set);
    assert.ok(ov.hexes.has('1,2'));
    assert.ok(ov.hexes.has('3,4'));
    assert.ok(Object.isFrozen(ov));
    assert.ok(Object.isFrozen(ov.style));
  });
  test('plan-arrow keeps ordered path', () => {
    const ov = makeOverlay({
      id: 'p', kind: 'plan-arrow', layer: 'plan-arrow',
      path: [{ col: 0, row: 0 }, '1,1', { col: 2, row: 2 }], style: {},
    });
    assert.deepEqual(ov.path, ['0,0', '1,1', '2,2']);
  });
  test('OVERLAY_KINDS is exported and frozen', () => {
    assert.ok(Object.isFrozen(OVERLAY_KINDS));
    assert.ok(OVERLAY_KINDS.includes('fill'));
  });
});

describe('overlaySignature', () => {
  test('identical regardless of hex input order', () => {
    const a = makeOverlay({ id: 'a', kind: 'fill', layer: 'fill', hexes: [{ col: 1, row: 1 }, { col: 2, row: 2 }], style: { color: '#abc' } });
    const b = makeOverlay({ id: 'b', kind: 'fill', layer: 'fill', hexes: [{ col: 2, row: 2 }, { col: 1, row: 1 }], style: { color: '#abc' } });
    assert.equal(overlaySignature(a), overlaySignature(b));
  });
});

describe('target overlays (move / battle / battle-hex)', () => {
  function makeDouble() {
    const obj = {};
    installOverlayShims(obj);
    return obj;
  }

  const TARGETS = [
    { id: 'move-targets',       color: 'rgba(60,220,80,0.22)' },
    { id: 'battle-targets',     color: 'rgba(220,60,60,0.55)' },
    { id: 'battle-hex-targets', color: 'rgba(220,120,40,0.50)' },
    { id: 'guard-zone',         color: 'rgba(230,160,60,0.18)' },
    { id: 'misc-highlights',    color: 'rgba(100,100,200,0.30)' },
  ];

  function setTarget(obj, id, color, hexes) {
    obj.setOverlay(id, makeOverlay({ id, kind: 'fill', layer: 'highlight-disc', hexes, style: { color } }));
  }

  test('all 5 target ids round-trip through setOverlay/getOverlay with the right colour', () => {
    const obj = makeDouble();
    for (const { id, color } of TARGETS) {
      setTarget(obj, id, color, [{ col: 1, row: 1 }]);
      const ov = obj.getOverlay(id);
      assert.ok(ov, `${id} should exist`);
      assert.equal(ov.style.color, color);
      assert.equal(ov.layer, 'highlight-disc');
      assert.equal(ov.kind, 'fill');
      assert.ok(ov.hexes.has('1,1'));
    }
  });

  test("clearOverlaysByLayer('highlight-disc') removes all 5 but leaves other layers", () => {
    const obj = makeDouble();
    for (const { id, color } of TARGETS) setTarget(obj, id, color, [{ col: 0, row: 0 }]);
    // A selection overlay in a different layer must survive the clear.
    obj.setSelection({ entityId: 3, hex: { col: 9, row: 9 } });
    assert.ok(obj._overlays.has('selection'));

    obj.clearOverlaysByLayer('highlight-disc');
    for (const { id } of TARGETS) assert.ok(!obj._overlays.has(id), `${id} should be cleared`);
    assert.ok(obj._overlays.has('selection'), 'selection (other layer) survives');
  });

  test("removeOverlay('move-targets') removes only that id", () => {
    const obj = makeDouble();
    setTarget(obj, 'move-targets',   'rgba(60,220,80,0.22)', [{ col: 0, row: 0 }]);
    setTarget(obj, 'battle-targets', 'rgba(220,60,60,0.55)', [{ col: 1, row: 1 }]);
    obj.removeOverlay('move-targets');
    assert.ok(!obj._overlays.has('move-targets'));
    assert.ok(obj._overlays.has('battle-targets'));
  });

  test('setOverlay(id, null) is a removal', () => {
    const obj = makeDouble();
    setTarget(obj, 'move-targets', 'rgba(60,220,80,0.22)', [{ col: 0, row: 0 }]);
    obj.setOverlay('move-targets', null);
    assert.ok(!obj._overlays.has('move-targets'));
  });

  test('setOverlay rejects a non-frozen literal (must use makeOverlay)', () => {
    const obj = makeDouble();
    assert.throws(() => obj.setOverlay('x', { id: 'x', kind: 'fill', layer: 'highlight-disc' }));
  });

  test('setOverlay upserts: same id replaces, never duplicates', () => {
    const obj = makeDouble();
    setTarget(obj, 'move-targets', 'rgba(60,220,80,0.22)', [{ col: 0, row: 0 }]);
    setTarget(obj, 'move-targets', 'rgba(60,220,80,0.22)', [{ col: 5, row: 5 }]);
    const ids = [...obj._overlays.keys()].filter(k => k === 'move-targets');
    assert.equal(ids.length, 1);
    const ov = obj._overlays.get('move-targets');
    assert.ok(ov.hexes.has('5,5'));
    assert.ok(!ov.hexes.has('0,0'));
  });
});

describe('highlightHexes legacy getter', () => {
  function makeDouble() {
    const obj = {};
    installOverlayShims(obj);
    return obj;
  }

  test('highlightHexes setter is a deprecated no-op (does not mutate overlays)', () => {
    const obj = makeDouble();
    const origWarn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    try {
      obj.highlightHexes = [{ col: 1, row: 1, color: 'rgba(60,220,80,0.22)' }];
    } finally {
      console.warn = origWarn;
    }
    assert.ok(!obj._overlays.has('move-targets'), 'setter must not create overlays');
    // Warn fires at most once globally; allow 0 (already warned in a prior test).
    assert.ok(warned <= 1);
  });

  test('highlightHexes getter reconstructs from the overlay map', () => {
    const obj = makeDouble();
    obj.setOverlay('battle-targets', makeOverlay({
      id: 'battle-targets', kind: 'fill', layer: 'highlight-disc',
      hexes: [{ col: 2, row: 3 }], style: { color: 'rgba(220,60,60,0.55)' },
    }));
    assert.deepEqual(obj.highlightHexes, [{ col: 2, row: 3, color: 'rgba(220,60,60,0.55)' }]);
  });
});

describe('selection + hover API', () => {
  function makeDouble() {
    const obj = {};
    installOverlayShims(obj);
    return obj;
  }

  test('setSelection({entityId, hex}) creates the selection overlay with the right shape', () => {
    const obj = makeDouble();
    obj.setSelection({ entityId: 7, hex: { col: 4, row: 5 } });
    const ov = obj.getOverlay('selection');
    assert.ok(ov, 'selection overlay exists');
    assert.equal(ov.kind, 'outline');
    assert.equal(ov.layer, 'selection');
    assert.ok(ov.hexes.has('4,5'));
    assert.equal(ov.style.glow, true);
    assert.equal(ov.style.strokeWidth, 2);
    assert.equal(ov.style.color, '#f5c842');
    assert.equal(ov.meta.entityId, 7);
    assert.deepEqual(obj._selection, { entityId: 7, hex: { col: 4, row: 5 } });
  });

  test('setSelection({entityId:null, hex:null}) removes the selection overlay', () => {
    const obj = makeDouble();
    obj.setSelection({ entityId: 7, hex: { col: 4, row: 5 } });
    assert.ok(obj._overlays.has('selection'));
    obj.setSelection({ entityId: null, hex: null });
    assert.ok(!obj._overlays.has('selection'));
    assert.deepEqual(obj._selection, { entityId: null, hex: null });
  });

  test('selection without an entityId omits meta (tile-only selection)', () => {
    const obj = makeDouble();
    obj.setSelection({ entityId: null, hex: { col: 1, row: 1 } });
    const ov = obj.getOverlay('selection');
    assert.ok(ov);
    assert.equal(ov.meta, undefined);
    assert.equal(ov.style.color, '#f5c842');
  });

  test('setHover(hex) / setHover(null) is symmetric', () => {
    const obj = makeDouble();
    obj.setHover({ col: 6, row: 6 });
    const ov = obj.getOverlay('hover');
    assert.ok(ov, 'hover overlay exists');
    assert.equal(ov.kind, 'outline');
    assert.equal(ov.layer, 'selection');
    assert.ok(ov.hexes.has('6,6'));
    assert.equal(ov.style.glow, false);
    assert.equal(ov.style.strokeWidth, 1);
    assert.equal(ov.style.color, 'rgba(255,255,255,0.3)');
    assert.deepEqual(obj._hover, { col: 6, row: 6 });
    obj.setHover(null);
    assert.ok(!obj._overlays.has('hover'));
    assert.equal(obj._hover, null);
  });

  test('selection + hover coexist in the selection layer, selection sorts on top', () => {
    const obj = makeDouble();
    obj.setHover({ col: 1, row: 1 });
    obj.setSelection({ entityId: 2, hex: { col: 2, row: 2 } });
    const ids = [...obj._overlays.keys()]
      .filter(id => obj._overlays.get(id).layer === 'selection')
      .sort();
    // Alphabetical: 'hover' < 'selection' — selection is drawn last (on top).
    assert.deepEqual(ids, ['hover', 'selection']);
  });

  test('onSelectionChange fires after the overlay + _selection are updated', () => {
    const obj = makeDouble();
    const calls = [];
    obj.onSelectionChange = (next) => {
      calls.push({ next, hasOverlay: obj._overlays.has('selection'), sel: { ...obj._selection } });
    };
    obj.setSelection({ entityId: 9, hex: { col: 3, row: 3 } });
    obj.setSelection({ entityId: null, hex: null });
    assert.equal(calls.length, 2, 'hook fired on every setSelection');
    assert.deepEqual(calls[0].next, { entityId: 9, hex: { col: 3, row: 3 } });
    assert.equal(calls[0].hasOverlay, true, 'overlay present when hook fires');
    assert.deepEqual(calls[0].sel, { entityId: 9, hex: { col: 3, row: 3 } });
    assert.equal(calls[1].hasOverlay, false, 'overlay cleared when hook fires for null');
  });
});

describe('installOverlayShims idempotency', () => {
  test('second call preserves live overlays + selection/hover state', () => {
    const obj = {};
    installOverlayShims(obj);
    obj.setOverlay('move-targets', makeOverlay({
      id: 'move-targets', kind: 'fill', layer: 'highlight-disc',
      hexes: [{ col: 1, row: 1 }], style: { color: 'rgba(60,220,80,0.22)' },
    }));
    obj.setSelection({ entityId: 5, hex: { col: 2, row: 2 } });
    obj.setHover({ col: 7, row: 8 });
    const overlaysRef = obj._overlays;

    // Second install must not wipe the map or the selection / hover state.
    installOverlayShims(obj);

    assert.equal(obj._overlays, overlaysRef, 'overlay map identity preserved');
    assert.ok(obj._overlays.has('move-targets'), 'fill overlay survives');
    assert.ok(obj._overlays.has('selection'), 'selection overlay survives');
    assert.ok(obj._overlays.has('hover'), 'hover overlay survives');
    assert.deepEqual(obj._selection, { entityId: 5, hex: { col: 2, row: 2 } });
    assert.deepEqual(obj._hover, { col: 7, row: 8 });
  });
});

// ── ring-pulse animation curve ──────────────────────────────────────────────

describe('ringPulseState — animation curves for the ring-pulse builder', () => {
  test('null animation is the static case (full alpha, unit radius, never done)', () => {
    assert.deepEqual(ringPulseState(null, 1000), { radiusScale: 1, alpha: 1, done: false });
  });

  test('expand: radius grows over the duration while alpha fades', () => {
    const a = { kind: 'expand', startedAtMs: 0, durationMs: 1000, maxScale: 3 };
    const start = ringPulseState(a, 0);
    const mid   = ringPulseState(a, 500);
    const end   = ringPulseState(a, 1000);
    assert.equal(start.radiusScale, 1);
    assert.ok(mid.radiusScale > start.radiusScale, 'radius grows toward maxScale');
    assert.equal(end.radiusScale, 3, 'reaches maxScale at the end');
    assert.ok(end.alpha < start.alpha, 'alpha fades as the ring expands');
    assert.equal(start.alpha, 1);
    assert.equal(end.alpha, 0);
    assert.equal(end.done, true);
    assert.equal(start.done, false);
  });

  test('pulse: radius static, alpha oscillates across the cycle', () => {
    const a = { kind: 'pulse', startedAtMs: 0, durationMs: 1000, loop: true };
    const q0 = ringPulseState(a, 0);     // sin(0) = 0   → 0.5
    const q1 = ringPulseState(a, 250);   // sin(π/2) = 1 → 1.0
    const q3 = ringPulseState(a, 750);   // sin(3π/2)=-1 → 0.0
    assert.equal(q0.radiusScale, 1);
    assert.equal(q1.radiusScale, 1);
    assert.ok(Math.abs(q0.alpha - 0.5) < 1e-9);
    assert.ok(Math.abs(q1.alpha - 1.0) < 1e-9);
    assert.ok(Math.abs(q3.alpha - 0.0) < 1e-9);
    assert.equal(q1.done, false, 'a looping pulse never reports done');
  });

  test('fade: alpha decays to 0 and the overlay reports done at the end', () => {
    const a = { kind: 'fade', startedAtMs: 100, durationMs: 200 };
    const mid = ringPulseState(a, 200);  // halfway
    const end = ringPulseState(a, 300);  // complete
    assert.equal(mid.radiusScale, 1);
    assert.ok(Math.abs(mid.alpha - 0.5) < 1e-9);
    assert.equal(end.alpha, 0);
    assert.equal(end.done, true, 'caller removes the overlay once done');
  });

  test('loop wraps the phase instead of completing', () => {
    const a = { kind: 'expand', startedAtMs: 0, durationMs: 1000, loop: true, maxScale: 2 };
    const past = ringPulseState(a, 2500); // 2.5 cycles → phase 0.5
    assert.ok(past.radiusScale > 1 && past.radiusScale < 2, 'phase wrapped, mid-expand');
    assert.equal(past.done, false, 'looping animation is never done');
  });
});

// ── overlay material cache key ──────────────────────────────────────────────

describe('overlayMaterialKey — shared-material keying for ring-pulse', () => {
  test('identical (rgb, alpha, glow) produce the same key (materials share)', () => {
    const a = overlayMaterialKey([0.2, 0.4, 0.6], 1, true);
    const b = overlayMaterialKey([0.2, 0.4, 0.6], 1, true);
    assert.equal(a, b);
  });

  test('a different colour yields a different key (materials do not share)', () => {
    const a = overlayMaterialKey([0.2, 0.4, 0.6], 1, true);
    const b = overlayMaterialKey([0.9, 0.4, 0.6], 1, true);
    assert.notEqual(a, b);
  });

  test('alpha and glow are part of the key', () => {
    const base = overlayMaterialKey([0.2, 0.4, 0.6], 1, true);
    assert.notEqual(base, overlayMaterialKey([0.2, 0.4, 0.6], 0.5, true), 'alpha matters');
    assert.notEqual(base, overlayMaterialKey([0.2, 0.4, 0.6], 1, false), 'glow matters');
  });

  test('tiny float dust within 3 decimals collapses to one key', () => {
    const a = overlayMaterialKey([0.2000001, 0.4, 0.6], 1, true);
    const b = overlayMaterialKey([0.2000002, 0.4, 0.6], 1, true);
    assert.equal(a, b);
  });
});

// ── plan-arrow descriptor: path-based, not hex-set-based ─────────────────────

describe('plan-arrow overlays carry an ordered path', () => {
  test('makeOverlay stores path (ordered) for kind plan-arrow', () => {
    const ov = makeOverlay({
      id: 'plan-move-7-1', kind: 'plan-arrow', layer: 'plan-arrow',
      path: [{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }],
      style: { color: '#abcdef', alpha: 1 },
      meta: { entityId: 7, badge: '1' },
    });
    assert.deepEqual(ov.path, ['1,1', '2,1', '3,1']);
    assert.ok(ov.hexes instanceof Set);
  });

  test('signature folds in the path order (not just membership)', () => {
    const mk = path => makeOverlay({
      id: 'p', kind: 'plan-arrow', layer: 'plan-arrow', path,
      style: { color: '#fff', alpha: 1 },
    });
    const forward = overlaySignature(mk([{ col: 1, row: 1 }, { col: 2, row: 1 }]));
    const reverse = overlaySignature(mk([{ col: 2, row: 1 }, { col: 1, row: 1 }]));
    assert.notEqual(forward, reverse, 'path order changes the signature');
    // Signature uses `path` (joined with ">"), not a sorted hex set.
    assert.ok(forward.includes('1,1>2,1'));
  });

  test('a changed path rebuilds; an identical path does not', () => {
    const mk = path => makeOverlay({
      id: 'p', kind: 'plan-arrow', layer: 'plan-arrow', path,
      style: { color: '#fff', alpha: 1 },
    });
    const a = overlaySignature(mk([{ col: 1, row: 1 }, { col: 2, row: 1 }]));
    const aAgain = overlaySignature(mk([{ col: 1, row: 1 }, { col: 2, row: 1 }]));
    const moved = overlaySignature(mk([{ col: 1, row: 1 }, { col: 2, row: 2 }]));
    assert.equal(a, aAgain, 'identical path → identical signature → no rebuild');
    assert.notEqual(a, moved, 'destination moved → signature differs → rebuild');
  });
});

// ── plan-arrow Y placement regression (PLAN_MARKER_Y collision fix) ──────────

describe('plan-arrow layer sits above the per-unit outline band', () => {
  test('plan-arrow band min ≥ outline band min (waypoints no longer hide under unit rings)', () => {
    assert.ok(Y_TABLE['plan-arrow'].min >= Y_TABLE['outline'].min,
      'plan-arrow layer must elevate above the outline layer');
    assert.ok(yForLayer('plan-arrow', 0) >= 0.180);
  });
});
