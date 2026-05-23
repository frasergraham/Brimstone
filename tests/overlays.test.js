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

describe('legacy field proxy', () => {
  function makeDouble() {
    const obj = {};
    installOverlayShims(obj);
    return obj;
  }

  test('highlightHexes setter creates a move-targets overlay', () => {
    const obj = makeDouble();
    obj.highlightHexes = [{ col: 1, row: 1, color: 'rgba(60,220,80,0.22)' }];
    assert.ok(obj._overlays.has('move-targets'));
    assert.ok(obj._overlays.get('move-targets').hexes.has('1,1'));
  });

  test('highlightHexes = [] clears the overlay', () => {
    const obj = makeDouble();
    obj.highlightHexes = [{ col: 1, row: 1, color: 'rgba(60,220,80,0.22)' }];
    obj.highlightHexes = [];
    assert.ok(!obj._overlays.has('move-targets'));
    assert.deepEqual(obj.highlightHexes, []);
  });

  test('highlightHexes getter round-trips col/row/color', () => {
    const obj = makeDouble();
    obj.highlightHexes = [{ col: 2, row: 3, color: 'rgba(220,60,60,0.55)' }];
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
