// Shared test fixture for UIController DOM tests.
//
// Usage:
//   import { makeUIFixture, makeState, makeFakeElement } from './setup.js';
//
// Pattern: call installGlobalMocks() ONCE at the top of your test file
// (before any dynamic imports), then createUIFixture() for each test.

// ── Trackable fake element ────────────────────────────────────────────────────
//
// Unlike a plain stub, a trackable element records className changes and
// innerHTML so tests can assert on DOM state without a real browser.

export function makeFakeElement(id = '') {
  const _classList = new Set();

  const el = {
    id,
    // ── style ──────────────────────────────────────────────────────────────
    style: {
      display: '', visibility: '', cursor: '',
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
      removeProperty(k) { delete this._props[k]; },
      getPropertyValue(k) { return this._props[k] ?? ''; },
    },
    // ── class ─────────────────────────────────────────────────────────────
    get className() { return [..._classList].join(' '); },
    set className(v) {
      _classList.clear();
      v.split(/\s+/).filter(Boolean).forEach(c => _classList.add(c));
    },
    classList: {
      add(...cls)         { cls.forEach(c => _classList.add(c)); },
      remove(...cls)      { cls.forEach(c => _classList.delete(c)); },
      contains(c)         { return _classList.has(c); },
      toggle(c, force) {
        if (force === true)       _classList.add(c);
        else if (force === false) _classList.delete(c);
        else _classList.has(c)    ? _classList.delete(c) : _classList.add(c);
        return _classList.has(c);
      },
    },
    // Expose the underlying Set for assertions: el._classList.has('collapsed')
    get _classList() { return _classList; },
    // ── content ───────────────────────────────────────────────────────────
    _innerHTML: '',
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = String(v ?? ''); },
    _textContent: '',
    get textContent() { return el._textContent; },
    set textContent(v) { el._textContent = String(v ?? ''); },
    // ── dataset ───────────────────────────────────────────────────────────
    dataset: {},
    // ── layout ────────────────────────────────────────────────────────────
    offsetWidth: 800, offsetHeight: 600,
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    // ── DOM ops ───────────────────────────────────────────────────────────
    addEventListener()    {},
    removeEventListener() {},
    // Return a stub so callers can chain .addEventListener() without throwing.
    querySelector()       { return makeFakeElement('queried'); },
    querySelectorAll()    { return []; },
    appendChild()         {},
    remove()              {},
    contains()            { return false; },
    getAttribute()        { return null; },
    setAttribute()        {},
    focus()               {},
    blur()                {},
    click()               {},
    title: '',
    disabled: false,
    children: [],
    parentElement: null,
  };
  return el;
}

// ── Canvas stub ───────────────────────────────────────────────────────────────

export function makeFakeCanvas() {
  const el = makeFakeElement('game-canvas');
  el.width  = 800;
  el.height = 600;
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
    set font(_) {},       get font()       { return ''; },
    set fillStyle(_) {},  get fillStyle()  { return ''; },
    set strokeStyle(_) {},get strokeStyle(){ return ''; },
    set globalAlpha(_) {},get globalAlpha(){ return 1; },
    set lineWidth(_) {},  get lineWidth()  { return 1; },
    set lineCap(_) {},    get lineCap()    { return 'butt'; },
    set lineJoin(_) {},   get lineJoin()   { return 'miter'; },
    set textAlign(_) {},  get textAlign()  { return 'left'; },
    set textBaseline(_) {},get textBaseline(){ return 'alphabetic'; },
    set globalCompositeOperation(_) {}, get globalCompositeOperation() { return 'source-over'; },
    set shadowColor(_) {},  get shadowColor()  { return ''; },
    set shadowBlur(_) {},   get shadowBlur()   { return 0; },
    set shadowOffsetX(_) {},get shadowOffsetX(){ return 0; },
    set shadowOffsetY(_) {},get shadowOffsetY(){ return 0; },
    set filter(_) {},       get filter()       { return 'none'; },
    createPattern() { return null; },
    putImageData() {}, createImageData() { return { data: new Uint8ClampedArray(4) }; },
    getImageData()  { return { data: new Uint8ClampedArray(4) }; },
    resetTransform() {}, transform() {}, setTransform() {},
    getTransform() { return { a:1,b:0,c:0,d:1,e:0,f:0 }; },
    isPointInPath() { return false; }, isPointInStroke() { return false; },
    createConicGradient() { return { addColorStop() {} }; },
  });
  return el;
}

// ── Renderer stub ─────────────────────────────────────────────────────────────

export function makeFakeRenderer() {
  return {
    selectedHex:      null,
    selectedEntityId: null,
    highlightHexes:   [],
    planGhostSteps:   [],
    insetRight:       0,
    hexSize:          30,
    zoomLevel:        1,
    hoveredHex:       null,
    _panX: 0, _panY: 0,
    _zoomAnim: null,
    resize()          {},
    loadImages()      {},
    draw()            {},
    resetView()       {},
    setZoom()         {},
    frameHexes()      {},
    _clampPan()       {},
    getPortraitDataURL() { return null; },
    getTileDataURL() { return null; },
    hexToCanvasPos(col, row) { return { x: col * 50, y: row * 50 }; },
    canvasToHex()     { return { col: 0, row: 0 }; },
  };
}

// ── Global browser mock ───────────────────────────────────────────────────────
//
// Call once BEFORE any dynamic imports that touch document/window/canvas.
// Returns an `elements` bag so individual tests can register trackable stubs.

export function installGlobalMocks() {
  const fakeCanvas = makeFakeCanvas();
  const _elements  = { 'game-canvas': fakeCanvas };

  const docListeners = {};

  global.document = {
    getElementById(id) { return _elements[id] ?? makeFakeElement(id); },
    querySelector()    { return null; },
    querySelectorAll() { return []; },
    createElement(tag) {
      const el = makeFakeElement(tag);
      if (tag === 'canvas') {
        el.getContext = fakeCanvas.getContext;
        el.width  = 800;
        el.height = 600;
      }
      return el;
    },
    addEventListener(event, fn) {
      (docListeners[event] ??= []).push(fn);
    },
    removeEventListener() {},
    body: makeFakeElement('body'),
  };

  global.window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    innerWidth:  1200,
    innerHeight: 800,
    requestAnimationFrame(fn) { setTimeout(fn, 0); return 1; },
    cancelAnimationFrame() {},
    Image: class { constructor() { this.onload = null; this.src = ''; } },
  };

  global.requestAnimationFrame = fn => { setTimeout(fn, 0); return 1; };
  global.cancelAnimationFrame  = () => {};

  return { fakeCanvas, _elements, docListeners };
}

// ── Fixture factory ───────────────────────────────────────────────────────────
//
// Creates a pre-wired elements bag where each element is a trackable fake.
// Pass the result as `els` to the UIController constructor.

export function createElementsBag(overrides = {}) {
  const ids = [
    'zoom-in','zoom-out','zoom-fit','zoom-me','speed-toggle','speed-popup','canvas-wrapper',
    'menu-btn','menu-quit-btn','menu-close-btn','game-menu-backdrop','game-screen',
    'end-turn-btn','turn-info','cycle-bar','node-status','node-status-bar','online-status',
    'plan-panel','plan-tab','plan-tab-count','plan-toggle-btn',
    'plan-steps','plan-budget-badge','plan-status','plan-players',
    'plan-food-row','plan-submit-btn','plan-clear-btn','plan-inventory',
    'plan-menu-btn','plan-return-btn','replay-turn-btn',
    'grace-dialog','grace-seconds','grace-submit-current','grace-submit-empty',
    'unit-stats-bar','action-popup','cancel-action-btn','cancel-wrap','target-hint',
    'chronicle-close','chronicle-overlay','chronicle-sidebar-close',
    'chronicle-sidebar','chronicle-sidebar-log','chronicle-mini','event-log',
    'tile-zoom-close','tile-zoom-overlay','tile-zoom-poly','tile-zoom-fort',
    'tile-zoom-icon','tile-zoom-tile-name','tile-zoom-info-lines','tile-zoom-units',
    'encounter-dialog','encounter-card',
    'result-dialog','result-messages','result-dismiss-hint','result-buttons','result-portrait',
    'battle-dialog','battle-footer','battle-summary',
    'battle-attacker','battle-defender',
    'battle-outcome','battle-pause-btn','battle-redo-btn',
    'battle-atk-breakdown','battle-def-breakdown','battle-toast-container',
    'phase-modal','phase-modal-continue',
    'round-summary','round-summary-events','round-summary-speed-row',
    'round-summary-next','round-summary-replay',
  ];
  const bag = {};
  for (const id of ids) bag[id] = makeFakeElement(id);
  return Object.assign(bag, overrides);
}

// ── Minimal state factory ─────────────────────────────────────────────────────

export function makeState(overrides = {}) {
  return {
    phase:           'day',
    round:           1,
    activePlayer:    'hero',
    actionsLeft:     3,
    heroActionsLeft: 3,
    witchActionsLeft: 4,
    heroIsAI:        false,
    witchIsAI:       true,
    planningPhase:   false,
    resolving:       false,
    gameOver:        false,
    winner:          null,
    fogOfWar:        'none',
    attritionLevel:  1,
    attritionChanged: false,
    entities:        [],
    hero:            null,
    witch:           null,
    witchObjectives: [],
    nodeScore:       { hero: 0, witch: 0 },
    inventory:       { shared: {} },
    log:             [],
    addLog()         {},
    spendAction()    {},
    ...overrides,
  };
}
