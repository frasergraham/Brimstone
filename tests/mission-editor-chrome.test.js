// Tests for the mission-editor CHROME/LAYOUT polish chunk (items 1–4, 11, 12):
//   • createToastHost   — show / auto-dismiss / [✕] dismiss / dismissAll (item 4)
//   • mapSizePreset     — standard-size → X/Y prefill mapping (item 12)
//   • buildEdgeButtons  — relocated in-map edge controls still drive resizeEdge (item 1)
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
  buildEdgeButtons,
  buildMapControls,
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

// ── buildEdgeButtons (item 1) ─────────────────────────────────────────────────────
describe('buildEdgeButtons', () => {
  function fakeEditor() {
    const calls = [];
    return {
      calls,
      resizeEdge(edge, delta) { calls.push({ edge, delta }); return { ok: true, warning: '' }; },
    };
  }

  test('builds one −/+ pair per map edge', () => {
    const editor = fakeEditor();
    const wrap = buildEdgeButtons(fakeDoc, editor, {});
    const btns = wrap.findAll('e-edge-btn');
    assert.equal(btns.length, MAP_EDGES.length * 2);
  });

  test('+ drives resizeEdge(edge, +1); − drives resizeEdge(edge, −1)', () => {
    const editor = fakeEditor();
    const wrap = buildEdgeButtons(fakeDoc, editor, {});
    const btns = wrap.findAll('e-edge-btn');
    for (const b of btns) b.click();
    // Every edge appears once at +1 and once at −1.
    for (const edge of MAP_EDGES) {
      assert.ok(editor.calls.some(c => c.edge === edge && c.delta === 1), `+1 for ${edge}`);
      assert.ok(editor.calls.some(c => c.edge === edge && c.delta === -1), `−1 for ${edge}`);
    }
  });

  test('onResize receives the resizeEdge result', () => {
    const editor = fakeEditor();
    let got = null;
    const wrap = buildEdgeButtons(fakeDoc, editor, { onResize: (r) => { got = r; } });
    wrap.findAll('e-edge-btn')[0].click();
    assert.equal(got.ok, true);
  });

  test('a blocked resize surfaces a toast', () => {
    const editor = {
      resizeEdge() { return { ok: false, warning: 'Cannot remove that edge.' }; },
    };
    const shown = [];
    const toast = { show: (msg, opts) => shown.push({ msg, opts }) };
    const wrap = buildEdgeButtons(fakeDoc, editor, { toast });
    wrap.findAll('e-edge-btn')[0].click();
    assert.equal(shown.length, 1);
    assert.equal(shown[0].opts.type, 'err');
    assert.match(shown[0].msg, /Cannot remove/);
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
