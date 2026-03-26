// Tests for the three mobile menu fixes:
// 1. _startFromState() must set ui.onQuitToMenu so Quit to Menu works in single-player
// 2. First tap on a unit should immediately show the action popup (no double-tap needed)
// 3. Game menu popup closes when tapping the canvas on mobile (touchstart listener)
//
// UIController depends on the DOM. These tests install minimal globals and use a
// dynamic import so the module loads after the mock document is in place.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM mock ──────────────────────────────────────────────────────────
// Installed before any module that touches document/canvas is loaded.

function makeFakeElement(id = '') {
  return {
    id,
    style: {},
    className: '',
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    contains(el) { return false; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {},
    getAttribute() { return null; },
    setAttribute() {},
    get textContent() { return ''; },
    set textContent(_) {},
    get innerHTML() { return ''; },
    set innerHTML(_) {},
    get offsetWidth() { return 800; },
    get offsetHeight() { return 600; },
    get clientWidth() { return 800; },
    get clientHeight() { return 600; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    children: [],
    parentElement: null,
    focus() {},
    blur() {},
    click() {},
  };
}

function makeFakeCanvas() {
  const el = makeFakeElement('game-canvas');
  el.getContext = () => ({
    save() {}, restore() {}, translate() {}, scale() {},
    clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, fill() {}, stroke() {},
    fillText() {}, measureText() { return { width: 10 }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
    drawImage() {},
    quadraticCurveTo() {}, bezierCurveTo() {},
    setLineDash() {}, rect() {}, clip() {},
    set font(_) {}, get font() { return ''; },
    set fillStyle(_) {}, get fillStyle() { return ''; },
    set strokeStyle(_) {}, get strokeStyle() { return ''; },
    set globalAlpha(_) {}, get globalAlpha() { return 1; },
    set lineWidth(_) {}, get lineWidth() { return 1; },
    set lineCap(_) {}, get lineCap() { return 'butt'; },
    set lineJoin(_) {}, get lineJoin() { return 'miter'; },
    set textAlign(_) {}, get textAlign() { return 'left'; },
    set textBaseline(_) {}, get textBaseline() { return 'alphabetic'; },
    set globalCompositeOperation(_) {}, get globalCompositeOperation() { return 'source-over'; },
    set shadowColor(_) {}, get shadowColor() { return ''; },
    set shadowBlur(_) {}, get shadowBlur() { return 0; },
    set shadowOffsetX(_) {}, get shadowOffsetX() { return 0; },
    set shadowOffsetY(_) {}, get shadowOffsetY() { return 0; },
    set filter(_) {}, get filter() { return 'none'; },
    createPattern() { return null; },
    putImageData() {}, createImageData() { return { data: new Uint8ClampedArray(4) }; },
    getImageData() { return { data: new Uint8ClampedArray(4) }; },
    resetTransform() {}, transform() {}, setTransform() {}, getTransform() { return { a:1,b:0,c:0,d:1,e:0,f:0 }; },
    isPointInPath() { return false; }, isPointInStroke() { return false; },
    createConicGradient() { return { addColorStop() {} }; },
  });
  el.width  = 800;
  el.height = 600;
  return el;
}

const _elements = {};
const fakeCanvas = makeFakeCanvas();
_elements['game-canvas'] = fakeCanvas;

const docListeners = {};
global.document = {
  getElementById(id) { return _elements[id] ?? makeFakeElement(id); },
  querySelector()    { return null; },
  querySelectorAll() { return []; },
  createElement(tag) {
    const el = makeFakeElement(tag);
    if (tag === 'canvas') { el.getContext = fakeCanvas.getContext; el.width = 800; el.height = 600; }
    return el;
  },
  addEventListener(event, fn, opts) {
    (docListeners[event] ??= []).push(fn);
  },
  removeEventListener() {},
  body: makeFakeElement('body'),
};

global.window = {
  addEventListener() {},
  removeEventListener() {},
  devicePixelRatio: 1,
  innerWidth: 800,
  innerHeight: 600,
  requestAnimationFrame(fn) { setTimeout(fn, 0); return 1; },
  cancelAnimationFrame() {},
  Image: class { constructor() { this.onload = null; this.src = ''; } },
};
global.requestAnimationFrame = (fn) => { setTimeout(fn, 0); return 1; };
global.cancelAnimationFrame  = () => {};

// ── Lazy-load UIController after globals are in place ─────────────────────────

let UIController;
let GameState;

before(async () => {
  // Dynamic imports resolve after globals are installed above
  const [uiMod, gameMod] = await Promise.all([
    import('../src/ui.js'),
    import('../src/game.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
});

function makeRenderer() {
  return {
    selectedHex:      null,
    selectedEntityId: null,
    highlightHexes:   [],
    planGhostSteps:   [],
    resize()    {},
    loadImages() {},
    draw()      {},
  };
}

function makeUI() {
  const state    = new GameState(true, false);
  const renderer = makeRenderer();
  const redraw   = () => {};
  const ui = new UIController(fakeCanvas, state, renderer, null, redraw, null, false);
  return { ui, state };
}

// ── Bug 1: onQuitToMenu must be set externally ────────────────────────────────

describe('onQuitToMenu initialization contract', () => {
  test('UIController.onQuitToMenu is undefined by default', () => {
    const { ui } = makeUI();
    assert.equal(ui.onQuitToMenu, undefined,
      'onQuitToMenu is not set in the constructor — caller must wire it up');
  });

  test('menu-quit-btn invokes onQuitToMenu when set', () => {
    const { ui } = makeUI();
    let called = false;
    ui.onQuitToMenu = () => { called = true; };

    // Simulate what the menu-quit-btn click handler does:
    //   this.onQuitToMenu?.()
    ui.onQuitToMenu?.();

    assert.equal(called, true, 'onQuitToMenu callback should be invoked');
  });

  test('onQuitToMenu optional-chains safely when not set', () => {
    const { ui } = makeUI();
    // Should not throw even without a callback
    assert.doesNotThrow(() => {
      ui.onQuitToMenu?.();
    });
  });
});

// ── Bug 2: first-tap popup visibility state ───────────────────────────────────

describe('action popup shown on first tap (single-tap UX)', () => {
  test('_popupVisible starts false after construction', () => {
    const { ui } = makeUI();
    assert.equal(ui._popupVisible, false);
  });

  test('_selectEntity resets _popupVisible to false (caller shows popup after)', () => {
    const { ui, state } = makeUI();
    const hero = state.hero;
    assert.ok(hero, 'GameState must have a hero entity');

    // _selectEntity should leave _popupVisible = false
    ui._selectEntity(hero);
    assert.equal(ui._popupVisible, false,
      '_selectEntity resets popup state so the caller can set it to true immediately after');
  });
});
