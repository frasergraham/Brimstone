// Tests for the mission-editor CHROME/LAYOUT polish chunk (items 1–4, 11, 12):
//   • createToastHost   — show / auto-dismiss / [✕] dismiss / dismissAll (item 4)
//   • mapSizePreset     — standard-size → X/Y prefill mapping (item 12)
//   • edgeButtonTargets / hitTestEdgeButton — canvas-drawn in-map resize buttons:
//        layout tracks the map edges + clicks map back to resizeEdge args (item 1)
//   • buildMapControls  — fit-map button calls the injected renderer-fit (item 3)
//
// DOM-light per CLAUDE.md: a tiny fake `document` (createElement + append/remove/
// addEventListener) avoids a full jsdom for these thin wiring helpers. The pure
// resize / fit LOGIC is unchanged and already covered in mission-editor.test.js —
// here we only pin that the relocated controls call the SAME controller methods.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createToastHost,
  buildMapControls,
  edgeButtonTargets,
  hitTestEdgeButton,
  EDGE_BTN_HEX_SCALE,
} from '../src/tools/mission-editor-ui.js';
import { mapSizePreset, MAP_EDGES } from '../src/tools/mission-editor.js';
import { MAP_SIZES } from '../src/map.js';

// ── Minimal fake DOM ──────────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tag, children: [], parent: null,
    style: {}, dataset: {}, _listeners: {},
    className: '', title: '', textContent: '', type: '',
    setAttribute() {},
    addEventListener(ev, fn) { (el._listeners[ev] ??= []).push(fn); },
    append(...kids) { for (const k of kids) { k.parent = el; el.children.push(k); } },
    remove() {
      if (!el.parent) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    click() { (el._listeners.click ?? []).forEach(fn => fn()); },
    // Recursively collect descendants whose className contains `cls`.
    findAll(cls, out = []) {
      for (const k of el.children) {
        if (String(k.className).split(/\s+/).includes(cls)) out.push(k);
        k.findAll?.(cls, out);
      }
      return out;
    },
  };
  return el;
}
const fakeDoc = { createElement: (tag) => makeEl(tag) };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── createToastHost (item 4) ────────────────────────────────────────────────────
describe('createToastHost', () => {
  test('show() appends a toast carrying the message + an [✕] button', () => {
    const container = makeEl('div');
    const toast = createToastHost(fakeDoc, container);
    toast.show('Saved', { type: 'ok', timeout: 0 });
    const toasts = toast._host.findAll('e-toast');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].findAll('e-toast-msg')[0].textContent, 'Saved');
    assert.equal(toasts[0].findAll('e-toast-x').length, 1);
    assert.ok(toasts[0].className.includes('e-toast-ok'));
  });

  test('empty message is a no-op', () => {
    const container = makeEl('div');
    const toast = createToastHost(fakeDoc, container);
    toast.show('', { timeout: 0 });
    assert.equal(toast._host.findAll('e-toast').length, 0);
  });

  test('auto-dismisses after the timeout', async () => {
    const container = makeEl('div');
    const toast = createToastHost(fakeDoc, container);
    toast.show('transient', { timeout: 20 });
    assert.equal(toast._host.findAll('e-toast').length, 1);
    await delay(40);
    assert.equal(toast._host.findAll('e-toast').length, 0);
  });

  test('[✕] dismisses immediately and cancels the auto-dismiss timer', async () => {
    const container = makeEl('div');
    const toast = createToastHost(fakeDoc, container);
    toast.show('manual', { timeout: 1000 });
    const x = toast._host.findAll('e-toast-x')[0];
    x.click();
    assert.equal(toast._host.findAll('e-toast').length, 0);
    await delay(10); // double-dismiss from a stale timer must not throw
    assert.equal(toast._host.findAll('e-toast').length, 0);
  });

  test('dismissAll() clears every live toast', () => {
    const container = makeEl('div');
    const toast = createToastHost(fakeDoc, container);
    toast.show('a', { timeout: 0 });
    toast.show('b', { timeout: 0 });
    assert.equal(toast._host.findAll('e-toast').length, 2);
    toast.dismissAll();
    assert.equal(toast._host.findAll('e-toast').length, 0);
  });
});

// ── mapSizePreset (item 12) ───────────────────────────────────────────────────────
describe('mapSizePreset', () => {
  test('resolves each standard size to its MAP_SIZES dims', () => {
    for (const name of Object.keys(MAP_SIZES)) {
      const cfg = MAP_SIZES[name];
      assert.deepEqual(mapSizePreset(name), { cols: cfg.cols, rows: cfg.rows });
    }
  });
  test('standard → 13×13', () => {
    assert.deepEqual(mapSizePreset('standard'), { cols: 13, rows: 13 });
  });
  test('unknown / Custom → null (caller keeps manual X/Y)', () => {
    assert.equal(mapSizePreset('Custom'), null);
    assert.equal(mapSizePreset('nope'), null);
  });
});

// ── edgeButtonTargets / hitTestEdgeButton (item 1) ────────────────────────────────
// The per-edge resize −/+ buttons are now painted on the canvas; these pure helpers
// own the layout (canvas-pixel circles tracking each map edge) and the click→
// resizeEdge mapping. A trivial `anchor` (col,row → centre) lets us assert geometry
// without a real Renderer; the resize LOGIC itself is covered in mission-editor.test.js.
describe('edgeButtonTargets', () => {
  // anchor: hex (c,r) sits at pixel (c*10, r*10) — a clean grid for assertions.
  const anchor = (c, r) => ({ x: c * 10, y: r * 10 });
  const HEX_PX = 10;

  test('builds one −/+ pair per map edge, in (−,+) order', () => {
    const targets = edgeButtonTargets({ cols: 9, rows: 9 }, anchor, HEX_PX);
    assert.equal(targets.length, MAP_EDGES.length * 2);
    // Every edge appears exactly once at delta −1 and once at +1.
    for (const edge of MAP_EDGES) {
      assert.equal(targets.filter(t => t.edge === edge && t.delta === -1).length, 1, `−1 for ${edge}`);
      assert.equal(targets.filter(t => t.edge === edge && t.delta === 1).length, 1, `+1 for ${edge}`);
    }
    // Glyphs follow the delta sign.
    assert.ok(targets.every(t => t.glyph === (t.delta > 0 ? '+' : '−')));
  });

  test('right/left pairs sit beyond the map x-extent; top/bottom beyond the y-extent', () => {
    const targets = edgeButtonTargets({ cols: 9, rows: 9 }, anchor, HEX_PX);
    const maxX = 8 * 10, maxY = 8 * 10; // rightmost col / bottom row pixel
    const right = targets.filter(t => t.edge === 'right');
    const left = targets.filter(t => t.edge === 'left');
    const bottom = targets.filter(t => t.edge === 'bottom');
    const top = targets.filter(t => t.edge === 'top');
    assert.ok(right.every(t => t.x > maxX), 'right pair is past the right edge');
    assert.ok(left.every(t => t.x < 0), 'left pair is past the left edge');
    assert.ok(bottom.every(t => t.y > maxY), 'bottom pair is below the bottom edge');
    assert.ok(top.every(t => t.y < 0), 'top pair is above the top edge');
  });

  test('hitTestEdgeButton maps a click on a button back to its (edge, delta)', () => {
    const targets = edgeButtonTargets({ cols: 9, rows: 9 }, anchor, HEX_PX);
    for (const t of targets) {
      const hit = hitTestEdgeButton(targets, t.x, t.y);
      assert.ok(hit, 'centre of a button is a hit');
      assert.equal(hit.edge, t.edge);
      assert.equal(hit.delta, t.delta);
    }
  });

  test('hitTestEdgeButton respects the hex inradius (just inside hits, just outside misses)', () => {
    const targets = edgeButtonTargets({ cols: 9, rows: 9 }, anchor, HEX_PX);
    const t = targets[0];
    const inradius = t.size * Math.sqrt(3) / 2;
    assert.ok(hitTestEdgeButton(targets, t.x + inradius - 0.5, t.y), 'just inside the inradius');
    assert.equal(hitTestEdgeButton(targets, t.x + inradius + 2, t.y), null, 'just outside the inradius');
    assert.equal(hitTestEdgeButton(targets, t.x + 1000, t.y), null, 'far outside any button');
  });

  test('targets are in-world sized hexes (size scales with hexPx)', () => {
    const small = edgeButtonTargets({ cols: 9, rows: 9 }, anchor, HEX_PX);
    const large = edgeButtonTargets({ cols: 9, rows: 9 }, anchor, HEX_PX * 2);
    // Same scale factor → button size scales linearly with the on-screen hexPx.
    assert.equal(small[0].size, HEX_PX * EDGE_BTN_HEX_SCALE);
    assert.equal(large[0].size, HEX_PX * 2 * EDGE_BTN_HEX_SCALE);
  });

  test('buttons sit ~1.5 tile-widths beyond the outermost playable hex edge', () => {
    const targets = edgeButtonTargets({ cols: 9, rows: 9 }, anchor, HEX_PX);
    const maxX = 8 * 10; // rightmost col centre under the test anchor
    // Outer hex's right edge sits at maxX + sqrt(3)/2 * HEX_PX; the button's
    // near edge should sit at least 1.5 * tile-widths beyond that.
    const ROOT3 = Math.sqrt(3);
    const outerEdge = maxX + 0.5 * ROOT3 * HEX_PX;
    const buttonNearEdge = (() => {
      const right = targets.filter(t => t.edge === 'right');
      const minX = Math.min(...right.map(t => t.x - 0.5 * ROOT3 * t.size));
      return minX;
    })();
    assert.ok(
      buttonNearEdge - outerEdge >= 1.5 * ROOT3 * HEX_PX - 1e-6,
      `breathing room is at least 1.5 tile-widths (got ${(buttonNearEdge - outerEdge).toFixed(2)})`,
    );
  });
});

// ── buildMapControls (item 3) ─────────────────────────────────────────────────────
describe('buildMapControls', () => {
  test('the fit-map button invokes onFit (the renderer-fit callback)', () => {
    let fits = 0;
    const cluster = buildMapControls(fakeDoc, { onFit: () => { fits++; } });
    const btn = cluster.findAll('e-mapctl-btn')[0];
    assert.ok(btn, 'fit button present');
    btn.click();
    assert.equal(fits, 1);
  });
});
