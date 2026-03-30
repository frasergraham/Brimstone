// Tests that the game version is displayed on the main menu.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

describe('menu version display', () => {
  /** @type {Map<string, {textContent: string}>} */
  const elements = new Map();

  before(async () => {
    // Minimal DOM mock — capture textContent written to #menu-version.
    function makeFakeElement(id = '') {
      return {
        id,
        style: { display: '', setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
        className: '',
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        contains() { return false; },
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        appendChild() {},
        remove() {},
        getAttribute() { return null; },
        setAttribute() {},
        focus() {},
        blur() {},
        click() {},
        _textContent: '',
        get textContent() { return this._textContent; },
        set textContent(v) { this._textContent = String(v ?? ''); },
        get innerHTML() { return ''; },
        set innerHTML(_) {},
        get offsetWidth() { return 800; },
        get offsetHeight() { return 600; },
        getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
        children: [],
        parentElement: null,
        dataset: {},
        disabled: false,
        title: '',
        width: 800,
        height: 600,
        getContext() {
          return new Proxy({}, { get: () => (..._a) => ({ addColorStop() {}, width: 10 }) });
        },
      };
    }

    global.document = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeFakeElement(id));
        return elements.get(id);
      },
      querySelector()    { return null; },
      querySelectorAll() { return []; },
      createElement(tag) { return makeFakeElement(tag); },
      addEventListener() {},
      removeEventListener() {},
      body: makeFakeElement('body'),
    };

    global.window = {
      addEventListener() {},
      removeEventListener() {},
      devicePixelRatio: 1,
      innerWidth: 1200,
      innerHeight: 800,
      requestAnimationFrame(fn) { setTimeout(fn, 0); return 1; },
      cancelAnimationFrame() {},
      Image: class { constructor() { this.onload = null; this.src = ''; } },
    };
    global.requestAnimationFrame = fn => { setTimeout(fn, 0); return 1; };
    global.cancelAnimationFrame  = () => {};
    global.location = { search: '', hostname: 'localhost', href: '', hash: '' };
    global.window.location = global.location;

    // Importing main.js triggers the version assignment.
    await import('../src/main.js');
  });

  test('menu-version element contains the version string', async () => {
    const { VERSION } = await import('../src/version.js');
    const el = elements.get('menu-version');
    assert.ok(el, '#menu-version element should have been accessed');
    assert.equal(el.textContent, `v${VERSION}`);
  });

  test('version string matches semver format', async () => {
    const el = elements.get('menu-version');
    assert.match(el.textContent, /^v\d+\.\d+\.\d+$/);
  });
});
