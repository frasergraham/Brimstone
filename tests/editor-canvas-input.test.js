// Tests for the mission-editor canvas input layer (pan / zoom / paint).
//
// The headline correctness check: a click must map to the RIGHT hex under a
// non-default zoom + pan offset. We exercise the real Renderer transform
// (src/renderer.js) — instantiated against a tiny fake canvas — so this verifies
// the genuine canvasToHex inverse, not a stand-in. The drag-vs-paint
// discrimination helper is pure and tested directly.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer } from '../src/renderer.js';
import {
  pointerToCanvas, hexFromPointer, isPanDrag, PAN_DRAG_THRESHOLD_PX,
} from '../src/tools/editor-canvas-input.js';
import { edgeButtonTargets, hitTestEdgeButton } from '../src/tools/mission-editor-ui.js';

// ── Minimal fake canvas the Renderer can lay out + transform against ──────────
function makeFakeCanvas(cssW = 800, cssH = 600, bufW = 800, bufH = 600) {
  const ctx = {
    fillStyle: '', fillRect() {}, clearRect() {}, save() {}, restore() {},
    measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
  };
  return {
    width: bufW,
    height: bufH,
    style: {},
    parentElement: { clientWidth: cssW, clientHeight: cssH },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssW, height: cssH }),
    addEventListener() {},
    removeEventListener() {},
  };
}

function makeRenderer(canvas) {
  // Renderer's constructor only reads canvas + (lazily) state; canvasToHex /
  // hexToCanvasPos depend purely on hexSize/pad (from _resize) + zoom/pan.
  return new Renderer(canvas, { entities: [], phase: 'day' });
}

describe('editor-canvas-input — pure helpers', () => {
  test('pointerToCanvas scales client coords into backing-store coords', () => {
    // CSS box 400×300 but backing store 800×600 → 2× scale.
    const rect = { left: 10, top: 20, width: 400, height: 300 };
    const canvas = { width: 800, height: 600 };
    const pt = pointerToCanvas(110, 170, rect, canvas);
    assert.equal(pt.x, (110 - 10) * (800 / 400)); // 200
    assert.equal(pt.y, (170 - 20) * (600 / 300)); // 300
  });

  test('pointerToCanvas returns null when the rect has no area', () => {
    assert.equal(pointerToCanvas(5, 5, { left: 0, top: 0, width: 0, height: 0 }, { width: 1, height: 1 }), null);
  });

  test('isPanDrag distinguishes a pan from a paint click', () => {
    assert.equal(isPanDrag(0, 0), false);
    assert.equal(isPanDrag(2, 2), false);             // ~2.8px < threshold
    assert.equal(isPanDrag(PAN_DRAG_THRESHOLD_PX, 0), false); // exactly at edge is not a drag
    assert.equal(isPanDrag(PAN_DRAG_THRESHOLD_PX + 1, 0), true);
    assert.equal(isPanDrag(10, 10), true);
  });
});

describe('editor-canvas-input — click→hex under zoom + pan', () => {
  test('a click maps to the correct hex at the default view', () => {
    const canvas = makeFakeCanvas();
    const r = makeRenderer(canvas);
    const col = 4, row = 5;
    const center = r.hexToCanvasPos(col, row); // backing-store coords
    // rect == backing store (scale 1, origin 0) so client == canvas coords.
    const rect = { left: 0, top: 0, width: canvas.width, height: canvas.height };
    const hex = hexFromPointer(r, center.x, center.y, rect, canvas);
    assert.deepEqual({ col: hex.col, row: hex.row }, { col, row });
  });

  test('a click maps to the correct hex under a non-default zoom + pan', () => {
    const canvas = makeFakeCanvas();
    const r = makeRenderer(canvas);
    // Non-default view: zoomed in, panned away from origin.
    r.zoomLevel = 2.3;
    r._panX = -137;
    r._panY = -82;
    for (const [col, row] of [[3, 4], [6, 2], [1, 9], [8, 8]]) {
      const center = r.hexToCanvasPos(col, row); // applies zoom + pan
      const rect = { left: 0, top: 0, width: canvas.width, height: canvas.height };
      const hex = hexFromPointer(r, center.x, center.y, rect, canvas);
      assert.deepEqual({ col: hex.col, row: hex.row }, { col, row },
        `hex ${col},${row} should round-trip through zoom+pan`);
    }
  });

  test('correct hex even when the canvas is CSS-scaled (rect ≠ backing store)', () => {
    // Backing store 800×600, displayed at 400×300 (2× device scale) offset by (12,7).
    const canvas = makeFakeCanvas(400, 300, 800, 600);
    const r = makeRenderer(canvas);
    r.zoomLevel = 1.7;
    r._panX = 40;
    r._panY = -25;
    const col = 5, row = 3;
    const center = r.hexToCanvasPos(col, row); // backing-store coords
    // Invert the rect scaling to get the equivalent client coords.
    const rect = { left: 12, top: 7, width: 400, height: 300 };
    const clientX = center.x * (rect.width / canvas.width) + rect.left;
    const clientY = center.y * (rect.height / canvas.height) + rect.top;
    const hex = hexFromPointer(r, clientX, clientY, rect, canvas);
    assert.deepEqual({ col: hex.col, row: hex.row }, { col, row });
  });
});

// The in-map resize buttons are laid out against the SAME renderer transform the
// click handler inverts. This exercises the real round-trip (renderer.hexToCanvasPos
// as the anchor) to confirm: (a) the buttons sit OFF the grid (so they never overlap
// a paintable hex) and (b) a click at a button centre hit-tests to the right
// (edge, delta) — the args fed verbatim to editor.resizeEdge.
describe('edge resize buttons — layout + hit-test against a real Renderer', () => {
  const dims = { cols: 9, rows: 9 };

  function targetsFor(r) {
    const hexPx = r.hexSize * r.zoomLevel;
    return edgeButtonTargets(dims, (c, rr) => r.hexToCanvasPos(c, rr), hexPx);
  }

  test('a click on a button resolves to its (edge, delta); none lands on a hex centre', () => {
    const canvas = makeFakeCanvas();
    const r = makeRenderer(canvas);
    r.zoomLevel = 1.6;
    r._panX = 30;
    r._panY = -20;
    const targets = targetsFor(r);
    assert.equal(targets.length, 8); // 4 edges × (−,+)

    for (const t of targets) {
      const hit = hitTestEdgeButton(targets, t.x, t.y);
      assert.equal(hit.edge, t.edge);
      assert.equal(hit.delta, t.delta);
      // The button centre sits outside every in-bounds hex (it's beyond the edge),
      // so routing it to resize rather than paint is unambiguous.
      const hex = r.canvasToHex(t.x, t.y);
      const inBounds = hex.col >= 0 && hex.col < dims.cols && hex.row >= 0 && hex.row < dims.rows;
      assert.equal(inBounds, false, `button ${t.edge}${t.delta > 0 ? '+' : '−'} is off the grid`);
    }
  });

  test('buttons track the map: re-laying out after a pan moves them with the grid', () => {
    const canvas = makeFakeCanvas();
    const r = makeRenderer(canvas);
    const before = targetsFor(r);
    r._panX += 100;
    r._panY += 40;
    const after = targetsFor(r);
    for (let i = 0; i < before.length; i++) {
      assert.ok(Math.abs(after[i].x - (before[i].x + 100)) < 1e-6, 'x shifts with pan');
      assert.ok(Math.abs(after[i].y - (before[i].y + 40)) < 1e-6, 'y shifts with pan');
    }
  });
});
