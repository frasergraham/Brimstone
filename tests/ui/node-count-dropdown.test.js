// UI test: the Power Node dropdown's range follows the selected map size.
//
// The Ledger links the map-size dropdown to the node-count dropdown via
// `dropdown.setOptions(...)`, which re-clamps the current value into the new
// option set without firing onChange. This test drives the real `_dropdown`
// against a minimal DOM stub (no jsdom) — enough to exercise the closure logic.
//
// NOTE: a global `document`/`window` stub is installed at module load BEFORE
// importing ledger.js, since ledger.js's _dropdown reads them at call time.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM stub ──────────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tagName: tag,
    type: '',
    disabled: false,
    _children: [],
    _class: new Set(),
    _attrs: {},
    _innerHTML: '',
    _listeners: {},
    get className() { return [...this._class].join(' '); },
    set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v ?? ''); },
    classList: {
      add: (...c) => c.forEach((x) => el._class.add(x)),
      remove: (...c) => c.forEach((x) => el._class.delete(x)),
      contains: (x) => el._class.has(x),
      toggle: (x, force) => {
        if (force === true) el._class.add(x);
        else if (force === false) el._class.delete(x);
        else el._class.has(x) ? el._class.delete(x) : el._class.add(x);
        return el._class.has(x);
      },
    },
    setAttribute(k, v) { this._attrs[k] = v; },
    appendChild(c) { this._children.push(c); return c; },
    replaceChildren(...c) { this._children = c; },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    getBoundingClientRect() { return { top: 0, bottom: 100, left: 0, right: 100 }; },
    querySelectorAll() { return []; },
  };
  return el;
}

before(() => {
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    addEventListener() {},
    querySelectorAll() { return []; },
  };
  globalThis.window = { innerHeight: 800, addEventListener() {} };
});

let _dropdown, _nodeCountOpts, _clampNodeCount, MAP_SIZES;
before(async () => {
  ({ _dropdown, _nodeCountOpts, _clampNodeCount } = await import('../../src/menu/ledger.js'));
  ({ MAP_SIZES } = await import('../../src/map.js'));
});

describe('node-count dropdown — range follows map size via setOptions', () => {
  test('starts on the size default for the initial map size', () => {
    const dd = _dropdown(_nodeCountOpts('standard'), String(MAP_SIZES.standard.nodeCount));
    assert.equal(dd.value, String(MAP_SIZES.standard.nodeCount));
  });

  // The Ledger links the two dropdowns by passing the clamped value to
  // setOptions(opts, clamped) — mirror that real call shape here.
  const relink = (dd, size) =>
    dd.setOptions(_nodeCountOpts(size), _clampNodeCount(size, parseInt(dd.value, 10)));

  test('switching to a larger map widens the range and keeps an in-range value', () => {
    const dd = _dropdown(_nodeCountOpts('standard'), '5');   // standard max
    relink(dd, 'campaign');                                  // campaign reaches 7
    // 5 is still in campaign's range, so it's preserved.
    assert.equal(dd.value, '5');
    relink(dd, 'skirmish');                                  // skirmish max is 3
    // 5 is now out of range → clamps down into the skirmish band.
    assert.ok(parseInt(dd.value, 10) <= MAP_SIZES.skirmish.nodeCountMax);
    assert.ok(parseInt(dd.value, 10) >= MAP_SIZES.skirmish.nodeCountMin);
  });

  test('setOptions re-clamps WITHOUT firing onChange (silent)', () => {
    let fired = 0;
    const dd = _dropdown(_nodeCountOpts('campaign'), '7', () => { fired++; });
    fired = 0;                          // ignore any setup invocation
    relink(dd, 'skirmish');             // 7 → clamps to skirmish max
    assert.equal(fired, 0, 'silent re-clamp must not call onChange');
    assert.ok(parseInt(dd.value, 10) <= MAP_SIZES.skirmish.nodeCountMax);
  });

  test('selecting 7 then shrinking to skirmish lands on its max (3)', () => {
    const dd = _dropdown(_nodeCountOpts('battle'), '7');
    relink(dd, 'skirmish');
    assert.equal(dd.value, String(MAP_SIZES.skirmish.nodeCountMax));
  });
});
