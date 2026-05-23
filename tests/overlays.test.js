import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYERS, Y_TABLE, yForLayer, OVERLAY_KINDS,
  makeOverlay, overlaySignature, installOverlayShims,
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

describe('legacy field proxy', () => {
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

  test('setSelection with nulls clears the selection overlay', () => {
    const obj = makeDouble();
    obj.setSelection({ entityId: 7, hex: { col: 4, row: 5 } });
    assert.ok(obj._overlays.has('selection'));
    assert.equal(obj.selectedEntityId, 7);
    assert.deepEqual(obj.selectedHex, { col: 4, row: 5 });
    obj.setSelection({ entityId: null, hex: null });
    assert.ok(!obj._overlays.has('selection'));
    assert.equal(obj.selectedHex, null);
  });

  test('selectedHex / selectedEntityId setters preserve the other field', () => {
    const obj = makeDouble();
    obj.selectedEntityId = 9;
    obj.selectedHex = { col: 1, row: 2 };
    assert.equal(obj.selectedEntityId, 9);
    assert.deepEqual(obj.selectedHex, { col: 1, row: 2 });
  });

  test('hoveredHex proxies through setHover', () => {
    const obj = makeDouble();
    obj.hoveredHex = { col: 6, row: 6 };
    assert.ok(obj._overlays.has('hover'));
    obj.hoveredHex = null;
    assert.ok(!obj._overlays.has('hover'));
    assert.equal(obj.hoveredHex, null);
  });
});
