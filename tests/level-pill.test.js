// Veterancy level pill: the small rounded badge that replaced the old
// "Name L2" string suffix. Two render paths:
//   • HTML — levelPillHtml() (Unit Stats Bar / arc portrait / battle dialog)
//   • Canvas — paintLevelPill() and paintUnitIconBadge({ level }) (3D over-unit
//     icon badge)
// Level 1 (or null) must render nothing in BOTH paths — matching the old
// behaviour where the suffix only appeared above level 1.
import { test, describe } from 'node:test';
import assert from 'node:assert';

import { levelPillHtml } from '../src/ui-render.js';
import {
  paintLevelPill,
  paintUnitIconBadge,
  UNIT_ICON_TEX_SIZE,
  UNIT_ICON_CARD_WIDTH_MUL,
  LEVEL_PILL_BORDER,
  LEVEL_PILL_TEXT,
} from '../src/renderer-3d.js';

describe('levelPillHtml — HTML pill', () => {
  test('level 1 renders nothing (bare default)', () => {
    assert.equal(levelPillHtml(1), '');
  });

  test('null / undefined / non-numeric renders nothing', () => {
    assert.equal(levelPillHtml(null), '');
    assert.equal(levelPillHtml(undefined), '');
    assert.equal(levelPillHtml(NaN), '');
  });

  test('level > 1 renders a .level-pill span carrying the number, no suffix text', () => {
    const html = levelPillHtml(2);
    assert.match(html, /class="level-pill"/, 'uses the .level-pill class');
    assert.match(html, />2<\/span>/, 'shows just the number');
    assert.doesNotMatch(html, /L2/, 'no "L2" text — the pill carries the bare number');
  });

  test('higher levels carry their own number', () => {
    assert.match(levelPillHtml(3), />3<\/span>/);
    assert.match(levelPillHtml(5), />5<\/span>/);
  });
});

// Recording canvas-ish stub — tracks style assignments + path/fill/stroke/text
// ops so we can prove the pill is (or isn't) drawn. Mirrors the stub in
// tests/mp-leader-color-propagation.test.js.
function makeRecordingCtx() {
  const calls = [];
  let style = { fillStyle: null, strokeStyle: null, lineWidth: 1, font: '' };
  return {
    calls,
    get fillStyle()   { return style.fillStyle; },
    set fillStyle(v)  { style.fillStyle   = v; calls.push({ op: 'setFill',   value: v }); },
    get strokeStyle() { return style.strokeStyle; },
    set strokeStyle(v){ style.strokeStyle = v; calls.push({ op: 'setStroke', value: v }); },
    get lineWidth()   { return style.lineWidth; },
    set lineWidth(v)  { style.lineWidth   = v; },
    get font()        { return style.font; }, set font(v) { style.font = v; },
    get lineCap()     { return ''; }, set lineCap(_)    {},
    get lineJoin()    { return ''; }, set lineJoin(_)   {},
    get textAlign()   { return ''; }, set textAlign(_)  {},
    get textBaseline(){ return ''; }, set textBaseline(_){},

    clearRect: () => calls.push({ op: 'clearRect' }),
    beginPath: () => calls.push({ op: 'beginPath' }),
    closePath: () => calls.push({ op: 'closePath' }),
    moveTo: (x, y) => calls.push({ op: 'moveTo', x, y }),
    lineTo: (x, y) => calls.push({ op: 'lineTo', x, y }),
    rect:   () => calls.push({ op: 'rect' }),
    arc: (cx, cy, r, sa, ea) => calls.push({
      op: 'arc', cx, cy, r, sa, ea, stroke: style.strokeStyle, fill: style.fillStyle,
    }),
    stroke: () => calls.push({ op: 'stroke', stroke: style.strokeStyle, lineWidth: style.lineWidth }),
    fill:   () => calls.push({ op: 'fill', fill: style.fillStyle }),
    fillRect: (x, y, w, h) => calls.push({ op: 'fillRect', x, y, w, h, fill: style.fillStyle }),
    save:    () => calls.push({ op: 'save' }),
    restore: () => calls.push({ op: 'restore' }),
    clip:    () => calls.push({ op: 'clip' }),
    drawImage: () => calls.push({ op: 'drawImage' }),
    strokeText: (t, x, y) => calls.push({ op: 'strokeText', text: t, x, y, fill: style.fillStyle }),
    fillText:   (t, x, y) => calls.push({ op: 'fillText',   text: t, x, y, fill: style.fillStyle, font: style.font }),
    measureText: (t) => ({ width: String(t).length * 8 }),
  };
}

describe('paintLevelPill — canvas pill', () => {
  test('draws a rounded pill (rounded caps via arc) + the number text', () => {
    const ctx = makeRecordingCtx();
    paintLevelPill(ctx, 100, 100, 40, 2);
    // Two arc calls form the rounded ends of the pill.
    const arcs = ctx.calls.filter(c => c.op === 'arc');
    assert.ok(arcs.length >= 2, 'pill body has two rounded-cap arcs');
    // Background fill + gold border stroke.
    const fills = ctx.calls.filter(c => c.op === 'fill');
    assert.ok(fills.length >= 1, 'pill background is filled');
    const goldStroke = ctx.calls.find(c => c.op === 'stroke' && c.stroke === LEVEL_PILL_BORDER);
    assert.ok(goldStroke, 'pill border stroked in the gold border colour');
    // The number text, drawn in the gold text colour.
    const text = ctx.calls.find(c => c.op === 'fillText' && c.text === '2');
    assert.ok(text, 'pill carries the level number');
    assert.equal(text.fill, LEVEL_PILL_TEXT, 'number painted in the gold text colour');
    assert.match(text.font, /BrimstoneIcons/, 'font stack keeps BrimstoneIcons (canvas icon-font convention)');
    assert.doesNotMatch(text.text, /L/, 'no "L" prefix — bare number');
  });
});

describe('paintUnitIconBadge — level pill integration', () => {
  const size  = UNIT_ICON_TEX_SIZE;
  const width = UNIT_ICON_TEX_SIZE * UNIT_ICON_CARD_WIDTH_MUL;

  test('level 1 (default) paints NO pill — no level number text', () => {
    const ctx = makeRecordingCtx();
    paintUnitIconBadge(ctx, { size, width, hp: 10, maxHp: 10, level: 1 });
    const pillText = ctx.calls.find(c => c.op === 'fillText' && c.text === '1');
    assert.ok(!pillText, 'no level-1 pill drawn (bare default)');
  });

  test('omitting level entirely also paints no pill', () => {
    const ctx = makeRecordingCtx();
    paintUnitIconBadge(ctx, { size, width, hp: 10, maxHp: 10 });
    const goldStroke = ctx.calls.find(c => c.op === 'stroke' && c.stroke === LEVEL_PILL_BORDER);
    assert.ok(!goldStroke, 'no gold pill border when level is unspecified');
  });

  test('level > 1 paints the pill — number text + gold border', () => {
    const ctx = makeRecordingCtx();
    paintUnitIconBadge(ctx, { size, width, hp: 10, maxHp: 10, level: 3 });
    const pillText = ctx.calls.find(c => c.op === 'fillText' && c.text === '3');
    assert.ok(pillText, 'level-3 pill carries the number 3');
    const goldStroke = ctx.calls.find(c => c.op === 'stroke' && c.stroke === LEVEL_PILL_BORDER);
    assert.ok(goldStroke, 'pill border drawn in gold for level > 1');
  });
});
