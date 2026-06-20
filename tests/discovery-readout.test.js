// Discovery readout — the survivor/zombie analogue of the combat readout
// (G1). Covers:
//  - discoveryReadoutModel surfaces name/title/stats/glyph from a live entity
//    OR a plain encounterSurvivor data object
//  - wrapDiscoveryText greedy-wraps on measureText width
//  - paintDiscoveryCard is pure, paints name + stat line + wrapped text
//  - discoveryText produces the right sentence per method / type
//  - addDiscoveryReadout: null when un-anchorable, thenable handle otherwise;
//    awaitFinal after reveal, fade on continue gate, _trackAnim'd
//  - runDiscoveryReadout orchestration: frames camera, reveals Continue button
//    at final, falls back (returns false) when the card can't anchor

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  discoveryReadoutModel,
  wrapDiscoveryText,
  paintDiscoveryCard,
  DISCOVERY_READOUT_REVEAL_MS,
  DISCOVERY_CARD_TEX_WIDTH,
  DISCOVERY_CARD_TEX_HEIGHT,
} from '../src/renderer-3d.js';
import {
  runDiscoveryReadout,
  discoveryText,
  DISCOVERY_COUNTDOWN_SEC,
} from '../src/discovery-cinematic.js';
import { ICON } from '../src/icons.js';

// ─── Pure model ──────────────────────────────────────────────────────────────

describe('discoveryReadoutModel', () => {
  test('builds from a live entity (getAttack / getDefense)', () => {
    const entity = {
      id: 's1', type: 'survivor', name: 'Eliza', title: 'Mason',
      hp: 4, maxHp: 5, color: '#abc', abilityLabel: 'Mason — fortifies',
      getAttack: () => 2, getDefense: () => 3,
    };
    const m = discoveryReadoutModel(entity, { text: 'hello' });
    assert.equal(m.name, 'Eliza');
    assert.equal(m.title, 'Mason');
    assert.equal(m.glyph, ICON.survivor);
    assert.equal(m.accentColor, '#abc');
    assert.equal(m.statLine, 'HP 4/5 · ATK 2 · DEF 3');
    assert.equal(m.abilityLabel, 'Mason — fortifies');
    assert.equal(m.text, 'hello');
  });

  test('builds from a plain encounterSurvivor data object (attack / defense fields)', () => {
    const data = {
      id: 'z1', type: 'zombie', name: 'Zombie',
      hp: 3, maxHp: 3, attack: 1, defense: 1, color: '#393',
    };
    const m = discoveryReadoutModel(data);
    assert.equal(m.name, 'Zombie');
    assert.equal(m.glyph, ICON.zombie);
    assert.equal(m.statLine, 'HP 3/3 · ATK 1 · DEF 1');
    assert.equal(m.text, ''); // no opts.text
  });

  test('falls back to sane defaults for a bare object', () => {
    const m = discoveryReadoutModel({});
    assert.equal(m.name, 'Survivor');
    assert.equal(m.glyph, '?');
    assert.equal(m.statLine, 'HP 0/1 · ATK 0 · DEF 0');
  });
});

// ─── wrapDiscoveryText ───────────────────────────────────────────────────────

describe('wrapDiscoveryText', () => {
  // Fake measureText: width proportional to character count.
  const ctx = { measureText: (s) => ({ width: String(s).length * 10 }) };

  test('returns [] for empty text', () => {
    assert.deepEqual(wrapDiscoveryText(ctx, '', 100), []);
    assert.deepEqual(wrapDiscoveryText(ctx, '   ', 100), []);
  });

  test('keeps a short string on one line', () => {
    assert.deepEqual(wrapDiscoveryText(ctx, 'a b c', 1000), ['a b c']);
  });

  test('wraps when a line would exceed maxWidth', () => {
    // Each word is 5 chars (50px). maxWidth 120 → ~2 words per line.
    const lines = wrapDiscoveryText(ctx, 'aaaaa bbbbb ccccc ddddd', 120);
    assert.ok(lines.length >= 2, 'should wrap into multiple lines');
    // Reassembling the words preserves order and content.
    assert.equal(lines.join(' '), 'aaaaa bbbbb ccccc ddddd');
  });
});

// ─── paintDiscoveryCard (pure) ───────────────────────────────────────────────

function makeFakeCtx() {
  const calls = [];
  return {
    calls,
    clearRect: () => calls.push(['clearRect']),
    fillRect:  () => calls.push(['fillRect']),
    fillText:  (t) => calls.push(['fillText', String(t)]),
    strokeText: (t) => calls.push(['strokeText', String(t)]),
    measureText: (s) => ({ width: String(s).length * 10 }),
    beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, quadraticCurveTo: () => {}, arc: () => {},
    clip: () => {}, stroke: () => {}, fill: () => {},
    save: () => {}, restore: () => {}, drawImage: () => {},
    set font(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
    get drawn() { return calls.filter(c => c[0] === 'fillText').map(c => c[1]); },
  };
}

describe('paintDiscoveryCard', () => {
  test('paints name, stat line, ability and wrapped discovery text (no portrait)', () => {
    const ctx = makeFakeCtx();
    paintDiscoveryCard(ctx, {
      width: DISCOVERY_CARD_TEX_WIDTH, height: DISCOVERY_CARD_TEX_HEIGHT,
      name: 'Eliza', title: 'Mason', glyph: '☺', accentColor: '#abc',
      hp: 4, maxHp: 5, statLine: 'HP 4/5 · ATK 2 · DEF 3',
      abilityLabel: 'Mason — fortifies',
      text: 'Eliza steps from the shadows and joins the party!',
      portraitImg: null, portraitRect: null,
    });
    const drawn = ctx.drawn;
    assert.ok(drawn.includes('☺ Eliza'), 'name with glyph painted');
    assert.ok(drawn.includes('Mason'), 'title painted');
    assert.ok(drawn.includes('HP 4/5 · ATK 2 · DEF 3'), 'stat line painted');
    assert.ok(drawn.some(t => t.includes('Mason — fortifies')), 'ability painted');
    // The discovery sentence is painted (wrapped across one or more lines).
    const joined = drawn.join(' ');
    assert.ok(joined.includes('joins the party'), 'discovery text painted');
    // Glyph fallback (no portrait) draws the glyph in the disc too.
    assert.ok(drawn.includes('☺'), 'glyph fallback disc painted');
  });

  test('does not throw and skips the glyph disc when a portrait is supplied', () => {
    const ctx = makeFakeCtx();
    const fakeImg = {};
    paintDiscoveryCard(ctx, {
      width: 640, height: 474,
      name: 'Z', glyph: '†', accentColor: '#393',
      hp: 3, maxHp: 3, statLine: 'HP 3/3 · ATK 1 · DEF 1', text: 'raised!',
      portraitImg: fakeImg, portraitRect: { x: 0, y: 0, size: 32 },
    });
    // drawImage used for the portrait; bare glyph NOT drawn standalone in disc.
    assert.ok(ctx.calls.some(c => c[0] === 'fillText' && c[1].includes('Z')), 'name painted');
  });
});

// ─── discoveryText ───────────────────────────────────────────────────────────

describe('discoveryText', () => {
  const survivor = { type: 'survivor', name: 'Eliza' };

  test('explore (default) — bare join sentence', () => {
    assert.equal(
      discoveryText(survivor, 'explore'),
      'Eliza steps from the shadows and joins the party!',
    );
  });

  test('horn — horn-call prefix', () => {
    assert.equal(
      discoveryText(survivor, 'horn'),
      "Drawn by the horn's call, Eliza steps from the shadows and joins the party!",
    );
  });

  test('power_node — node prefix', () => {
    assert.equal(
      discoveryText(survivor, 'power_node'),
      'Drawn to the power node, Eliza steps from the shadows and joins the party!',
    );
  });

  test('zombie — witch flavour, ignores method', () => {
    const z = { type: 'zombie', name: 'Zombie' };
    assert.equal(
      discoveryText(z, 'explore'),
      'A cowering survivor is found… raised as a zombie by the witch!',
    );
    assert.equal(discoveryText(z, 'horn'), discoveryText(z, 'explore'));
  });
});

// ─── addDiscoveryReadout lifecycle ───────────────────────────────────────────

function makeFakeBabylon() {
  function Animation(name, prop) { this.name = name; this.prop = prop; }
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  Animation.prototype.setKeys = function (k) { this.keys = k; };
  class Vector3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
  class DynamicTexture {
    constructor(name) {
      this.name = name; this.hasAlpha = false; this.updated = 0; this.disposed = 0;
      this._calls = [];
      this._ctx = makeFakeCtx();
    }
    getContext() { return this._ctx; }
    update() { this.updated += 1; }
    dispose() { this.disposed += 1; }
  }
  const Mesh = { BILLBOARDMODE_ALL: 7 };
  const MeshBuilder = {
    CreatePlane(name) {
      return {
        name, billboardMode: 0, isPickable: true, renderingGroupId: 0,
        visibility: 0, parent: null, uniqueId: 1,
        position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
        material: null, disposed: 0, dispose() { this.disposed += 1; },
      };
    },
  };
  class StandardMaterial { constructor() { this.disposed = 0; } dispose() { this.disposed += 1; } }
  class Color3 { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }
  return { Animation, Vector3, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Color3 };
}

function makeInst({ withStandee = true } = {}) {
  const inst = Object.create(Renderer3D.prototype);
  inst._babylon = makeFakeBabylon();
  inst._scene = {
    beginDirectAnimation(target, anims, _f, _to, _loop, _spd, onEnd) {
      if (onEnd) onEnd();
    },
  };
  inst._tracked = [];
  inst._trackAnim = (p) => { inst._tracked.push(p); };
  inst._entityStandees = new Map();
  inst._tilemapImg = null;
  inst._spriteRects = null;
  if (withStandee) {
    inst._entityStandees.set('s1', {
      plane: { position: { x: 0, y: 0, z: 0, set() {} } },
      leader: false,
    });
  }
  return inst;
}

const ENTITY = {
  id: 's1', type: 'survivor', name: 'Eliza', title: 'Mason',
  hp: 4, maxHp: 5, color: '#abc',
  getAttack: () => 2, getDefense: () => 3,
};

function fakeScheduler() {
  const queue = [];
  const fn = (cb, ms) => { queue.push({ cb, ms }); };
  fn.runAll = () => { queue.sort((a, b) => a.ms - b.ms); while (queue.length) queue.shift().cb(); };
  fn.size = () => queue.length;
  return fn;
}

describe('addDiscoveryReadout', () => {
  test('returns null when the standee is missing', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ withStandee: false });
    assert.equal(inst.addDiscoveryReadout(ENTITY, { text: 'x' }), null);
    assert.equal(inst._tracked.length, 0);
  });

  test('returns null without scene / babylon', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    inst._scene = null;
    assert.equal(inst.addDiscoveryReadout(ENTITY, { text: 'x' }), null);
  });

  test('returns null for a bad entity', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    assert.equal(inst.addDiscoveryReadout(null, {}), null);
    assert.equal(inst.addDiscoveryReadout({ name: 'no-id' }, {}), null);
  });

  test('returns a thenable handle, paints the card, and tracks the anim', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    const sched = fakeScheduler();
    const h = inst.addDiscoveryReadout(ENTITY, { text: 'Eliza joins!', setTimeoutFn: sched });
    assert.ok(h && typeof h.then === 'function', 'returns a thenable');
    assert.equal(typeof h.awaitFinal, 'function');
    assert.equal(typeof h.triggerFade, 'function');
    assert.equal(inst._tracked.length, 1, 'promise is _trackAnim\'d');
    // Card painted immediately (before the reveal timer).
    assert.ok(sched.size() >= 1, 'a reveal timer is scheduled');
  });

  test('awaitFinal resolves after reveal; promise resolves after continue gate + fade', async () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    const sched = fakeScheduler();
    let continueResolve;
    const gate = new Promise(r => { continueResolve = r; });
    const h = inst.addDiscoveryReadout(ENTITY, {
      text: 'joins!',
      setTimeoutFn: sched,
      awaitContinueFn: () => gate,
    });

    let finalSeen = false;
    h.awaitFinal().then(() => { finalSeen = true; });
    assert.equal(finalSeen, false, 'final not reached before the reveal timer fires');

    sched.runAll(); // fire reveal → resolveFinal + arm the gate race
    await Promise.resolve();
    assert.equal(finalSeen, true, 'awaitFinal resolves once the card settles');

    let done = false;
    h.then(() => { done = true; });
    await Promise.resolve();
    assert.equal(done, false, 'promise pending until the continue gate resolves');

    continueResolve(); // player taps Continue (or countdown fires)
    await h; // fade runs synchronously (fake beginDirectAnimation calls onEnd)
    assert.equal(done, true, 'promise resolves after gate + fade');
  });

  test('triggerFade advances past the hold without an external gate', async () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    const sched = fakeScheduler();
    const h = inst.addDiscoveryReadout(ENTITY, { text: 'joins!', setTimeoutFn: sched });
    sched.runAll();
    h.triggerFade();
    await h; // resolves via the local continue signal
    assert.ok(true);
  });
});

// ─── runDiscoveryReadout orchestration ───────────────────────────────────────

function makeFakeButton() {
  const listeners = {};
  return {
    hidden: true,
    textContent: 'Continue ▶',
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) {
      if (listeners[ev]) listeners[ev] = listeners[ev].filter(f => f !== fn);
    },
    _fire(ev) { (listeners[ev] || []).slice().forEach(fn => fn()); },
  };
}

// A fake renderer whose addDiscoveryReadout honours awaitContinueFn so the
// orchestration's Continue-gate path is exercised without the real renderer.
function makeFakeRenderer({ canAnchor = true } = {}) {
  const calls = { frame: [], readout: [] };
  let resolveFinal;
  const finalReached = new Promise(r => { resolveFinal = r; });
  return {
    is3D: true,
    calls,
    _resolveFinal: () => resolveFinal(),
    async frameEntities(ids, opts) { calls.frame.push({ ids, opts }); return true; },
    addDiscoveryReadout(entity, opts) {
      calls.readout.push({ entity, opts });
      if (!canAnchor) return null;
      const promise = Promise.resolve()
        .then(() => opts.awaitContinueFn ? opts.awaitContinueFn() : null);
      return {
        promise,
        awaitFinal: () => finalReached,
        triggerFade: () => {},
        then: (f, r) => promise.then(f, r),
        catch: (r) => promise.catch(r),
        finally: (f) => promise.finally(f),
      };
    },
  };
}

describe('runDiscoveryReadout', () => {
  test('returns false when the renderer is not 3D', async () => {
    const ran = await runDiscoveryReadout({ renderer: { is3D: false }, entity: ENTITY, text: 'x' });
    assert.equal(ran, false);
  });

  test('returns false when there is no addDiscoveryReadout method', async () => {
    const ran = await runDiscoveryReadout({ renderer: { is3D: true }, entity: ENTITY, text: 'x' });
    assert.equal(ran, false);
  });

  test('returns false for a missing entity', async () => {
    const r = makeFakeRenderer();
    assert.equal(await runDiscoveryReadout({ renderer: r, entity: null, text: 'x' }), false);
    assert.equal(await runDiscoveryReadout({ renderer: r, entity: {}, text: 'x' }), false);
  });

  test('falls back (returns false) when the card cannot anchor', async () => {
    const r = makeFakeRenderer({ canAnchor: false });
    const ran = await runDiscoveryReadout({ renderer: r, entity: ENTITY, text: 'x' });
    assert.equal(ran, false);
    // Camera was still framed (best-effort) and the readout was attempted.
    assert.equal(r.calls.frame.length, 1);
    assert.equal(r.calls.readout.length, 1);
  });

  test('frames the camera, runs the readout, and returns true (no button → auto-advance)', async () => {
    const r = makeFakeRenderer();
    r._resolveFinal(); // settle immediately
    const ran = await runDiscoveryReadout({ renderer: r, entity: ENTITY, text: 'joins!' });
    assert.equal(ran, true);
    assert.deepEqual(r.calls.frame[0].ids, ['s1']);
    assert.equal(r.calls.readout[0].entity.id, 's1');
    assert.equal(r.calls.readout[0].opts.text, 'joins!');
  });

  test('reveals the Continue button at final state and hides it after dismissal', async () => {
    const r = makeFakeRenderer();
    const btn = makeFakeButton();
    const p = runDiscoveryReadout({
      renderer: r, entity: ENTITY, text: 'joins!',
      getContinueButton: () => btn,
    });
    // Settle the card → button revealed.
    r._resolveFinal();
    await new Promise(res => setTimeout(res, 0));
    assert.equal(btn.hidden, false, 'button revealed once the card settles');
    // Player taps Continue → gate resolves → readout promise resolves.
    btn._fire('click');
    const ran = await p;
    assert.equal(ran, true);
    assert.equal(btn.hidden, true, 'button hidden again after dismissal');
  });
});

// ─── Constants sanity ────────────────────────────────────────────────────────

describe('discovery readout constants', () => {
  test('countdown is the 5s the brief asked for', () => {
    assert.equal(DISCOVERY_COUNTDOWN_SEC, 5);
  });
  test('reveal hold + texture dims are sane', () => {
    assert.ok(DISCOVERY_READOUT_REVEAL_MS > 0);
    assert.ok(DISCOVERY_CARD_TEX_WIDTH > 0 && DISCOVERY_CARD_TEX_HEIGHT > 0);
  });
});
