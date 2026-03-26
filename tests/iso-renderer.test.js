// Tests for the isometric renderer toggle added to src/renderer.js.
//
// The Renderer class requires a browser canvas, so we test the coordinate
// math by constructing a minimal stub canvas and verifying that:
//   1. isoMode starts false and toggleIso() flips it.
//   2. _toCanvas / canvasToHex are inverses in both flat and iso modes.
//   3. _hexCorners returns 6 points; y-offsets are scaled in iso mode.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/renderer.js';
import { hexToPixel, hexKey, MAP_COLS, MAP_ROWS } from '../src/hex.js';

// ── Minimal canvas stub ───────────────────────────────────────────────────────

function makeStubCanvas(width = 800, height = 600) {
  // createRadialGradient / createLinearGradient need at least a stub so the
  // Renderer constructor (which calls _resize) doesn't throw.
  const ctx = {
    save: () => {}, restore: () => {}, scale: () => {}, translate: () => {},
    fillRect: () => {}, clearRect: () => {}, beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, arc: () => {}, fill: () => {}, stroke: () => {},
    clip: () => {}, drawImage: () => {}, quadraticCurveTo: () => {}, setLineDash: () => {},
    fillText: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1,
    font: '', textAlign: '', textBaseline: '', lineCap: '', lineJoin: '',
  };
  return {
    getContext: () => ctx,
    width,
    height,
    style: {},
    parentElement: { clientWidth: width, clientHeight: height },
  };
}

// Minimal state stub (Renderer only reads entities/tiles/fogOfWar in draw()).
function makeStubState() {
  return {
    entities: [],
    tiles: new Map(),
    fogOfWar: false,
    witchIsAI: true,
    heroIsAI: false,
    myFaction: undefined,
    witchObjectives: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Renderer iso mode', () => {
  let renderer;

  before(() => {
    const canvas = makeStubCanvas();
    const state  = makeStubState();
    renderer = new Renderer(canvas, state);
  });

  test('isoMode defaults to false', () => {
    assert.equal(renderer.isoMode, false);
  });

  test('toggleIso() flips isoMode', () => {
    renderer.toggleIso();
    assert.equal(renderer.isoMode, true);
    renderer.toggleIso();
    assert.equal(renderer.isoMode, false);
  });
});

describe('Renderer coordinate round-trip — flat mode', () => {
  let renderer;

  before(() => {
    renderer = new Renderer(makeStubCanvas(), makeStubState());
    renderer.isoMode = false;
    renderer.resize();
  });

  test('_toCanvas / canvasToHex round-trip for all interior hexes', () => {
    for (let row = 1; row < MAP_ROWS - 1; row++) {
      for (let col = 1; col < MAP_COLS - 1; col++) {
        const canvas = renderer._toCanvas(col, row);
        // Simulate the click path: canvasToHex receives raw canvas pixels.
        // Without zoom/pan offset the pan is zero, so we pass canvas coords directly.
        const recovered = renderer.canvasToHex(canvas.x, canvas.y);
        assert.equal(recovered.col, col, `flat round-trip col failed at (${col},${row})`);
        assert.equal(recovered.row, row, `flat round-trip row failed at (${col},${row})`);
      }
    }
  });
});

describe('Renderer coordinate round-trip — iso mode', () => {
  let renderer;

  before(() => {
    renderer = new Renderer(makeStubCanvas(), makeStubState());
    renderer.isoMode = true;
    renderer.resize();
  });

  test('_toCanvas / canvasToHex round-trip for all interior hexes', () => {
    for (let row = 1; row < MAP_ROWS - 1; row++) {
      for (let col = 1; col < MAP_COLS - 1; col++) {
        const canvas = renderer._toCanvas(col, row);
        const recovered = renderer.canvasToHex(canvas.x, canvas.y);
        assert.equal(recovered.col, col, `iso round-trip col failed at (${col},${row})`);
        assert.equal(recovered.row, row, `iso round-trip row failed at (${col},${row})`);
      }
    }
  });

  test('iso _toCanvas vertical span is compressed relative to flat', () => {
    // The total vertical distance between the top row and bottom row should be
    // smaller in iso mode — that is the core guarantee of the y-compression.
    renderer.isoMode = true;
    renderer.resize();
    const isoSpan = renderer._toCanvas(6, MAP_ROWS - 1).y - renderer._toCanvas(6, 0).y;

    renderer.isoMode = false;
    renderer.resize();
    const flatSpan = renderer._toCanvas(6, MAP_ROWS - 1).y - renderer._toCanvas(6, 0).y;

    assert.ok(isoSpan < flatSpan,
      `iso row span (${isoSpan.toFixed(1)}) should be less than flat row span (${flatSpan.toFixed(1)})`);

    // Restore iso for subsequent tests.
    renderer.isoMode = true;
    renderer.resize();
  });
});

describe('Renderer _hexCorners', () => {
  let renderer;

  before(() => {
    renderer = new Renderer(makeStubCanvas(), makeStubState());
  });

  test('always returns 6 corners', () => {
    renderer.isoMode = false;
    assert.equal(renderer._hexCorners(100, 100, 30).length, 6);
    renderer.isoMode = true;
    assert.equal(renderer._hexCorners(100, 100, 30).length, 6);
  });

  test('flat corners are symmetric about centre y', () => {
    renderer.isoMode = false;
    const corners = renderer._hexCorners(100, 100, 30);
    const topY    = Math.min(...corners.map(c => c.y));
    const bottomY = Math.max(...corners.map(c => c.y));
    // Centre is equidistant from top and bottom within floating-point tolerance.
    assert.ok(Math.abs((topY + bottomY) / 2 - 100) < 0.01,
      'flat corners should be vertically centred');
  });

  test('iso corners are vertically squashed compared to flat', () => {
    renderer.isoMode = false;
    const flatCorners = renderer._hexCorners(100, 100, 30);
    const flatSpan    = Math.max(...flatCorners.map(c => c.y)) - Math.min(...flatCorners.map(c => c.y));

    renderer.isoMode = true;
    const isoCorners = renderer._hexCorners(100, 100, 30);
    const isoSpan    = Math.max(...isoCorners.map(c => c.y)) - Math.min(...isoCorners.map(c => c.y));

    assert.ok(isoSpan < flatSpan,
      `iso vertical span (${isoSpan}) should be less than flat (${flatSpan})`);
  });
});
