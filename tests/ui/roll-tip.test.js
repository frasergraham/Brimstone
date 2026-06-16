// Turn-card roll-breakdown popup (pure renders in src/ui-render.js):
//   - buildRollRowsTipHtml puts each combatant's icon + name at the top of
//     its column (operator brief: the popup never named the sides)
//   - computeGameTooltipPos keeps the popup clear of the hovered turn card
//     (below it, or docked beside it when there's no room below)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRollRowsTipHtml, computeGameTooltipPos } from '../../src/ui-render.js';

function makeRows() {
  const side = (roll) => ({
    dice: { pool: [4, 2], picked: 4, advantage: 1 },
    terms: [{ label: 'Attack', val: 2 }],
    roll,
  });
  return { atk: side(6), def: side(3), notes: ['note'], rule: 'higher total wins' };
}

function makeEntry() {
  return {
    actor:  { name: 'Mary Reed', type: 'hero',   color: '#d4a72c', glyph: '⚔' },
    target: { name: 'Zombie',    type: 'zombie', color: '#9b59b6', glyph: '†' },
    outcomeKind: 'hit', label: 'BATTLE', atkRoll: 6, defRoll: 3,
    attackerWon: true, targetDmg: 1, actorDmg: 0,
  };
}

describe('buildRollRowsTipHtml — combatant headers', () => {
  test('each column is headed by its combatant name', () => {
    const html = buildRollRowsTipHtml(makeRows(), makeEntry());
    assert.match(html, /Mary Reed/);
    assert.match(html, /Zombie/);
    // Names appear inside the attack/defense columns, before the dice rows.
    const atkCol = html.slice(html.indexOf('gtt-atk'), html.indexOf('gtt-def'));
    assert.match(atkCol, /Mary Reed/, 'attacker named in the ATTACK column');
    const defCol = html.slice(html.indexOf('gtt-def'));
    assert.match(defCol, /Zombie/, 'defender named in the DEFENSE column');
  });

  test('portraitFor supplies the icon image; fallback is a glyph chip', () => {
    const calls = [];
    const html = buildRollRowsTipHtml(makeRows(), makeEntry(), {
      portraitFor: (u) => { calls.push(u.type); return u.type === 'hero' ? 'data:hero-img' : null; },
    });
    assert.deepEqual(calls.sort(), ['hero', 'zombie']);
    assert.match(html, /<img class="gtt-combatant-icon" src="data:hero-img"/);
    // Defender has no portrait — glyph chip fallback.
    assert.match(html, /<span class="gtt-combatant-icon"[^>]*>†<\/span>/);
  });

  test('no combatant refs → no header, columns still render', () => {
    const html = buildRollRowsTipHtml(makeRows(), { outcomeKind: 'hit', targetDmg: 1 });
    assert.doesNotMatch(html, /gtt-combatant/);
    assert.match(html, /ATTACK/);
  });

  test('names are HTML-escaped', () => {
    const entry = makeEntry();
    entry.actor.name = '<b>x</b>';
    const html = buildRollRowsTipHtml(makeRows(), entry);
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  });
});

describe('computeGameTooltipPos', () => {
  const vp = { viewportW: 1200, viewportH: 800 };

  test('plain target (no card): above the target, centred', () => {
    const { x, y } = computeGameTooltipPos({
      targetRect: { left: 500, top: 400, width: 100, height: 20, right: 600, bottom: 420 },
      cardRect: null, tipW: 200, tipH: 100, ...vp,
    });
    assert.equal(x, 500 + 50 - 100);
    assert.equal(y, 400 - 100 - 10);
  });

  test('plain target with no headroom flips below', () => {
    const { y } = computeGameTooltipPos({
      targetRect: { left: 500, top: 40, width: 100, height: 20, right: 600, bottom: 60 },
      cardRect: null, tipW: 200, tipH: 100, ...vp,
    });
    assert.equal(y, 60 + 10);
  });

  test('inside a turn card: popup sits BELOW the whole card, never over it', () => {
    const cardRect = { left: 100, top: 76, width: 280, height: 300, right: 380, bottom: 376 };
    const { y } = computeGameTooltipPos({
      targetRect: { left: 120, top: 150, width: 200, height: 24, right: 320, bottom: 174 },
      cardRect, tipW: 240, tipH: 220, ...vp,
    });
    assert.ok(y >= cardRect.bottom, `below the card (y=${y} >= ${cardRect.bottom})`);
  });

  test('no room below the card: docks beside it instead', () => {
    const cardRect = { left: 100, top: 76, width: 280, height: 640, right: 380, bottom: 716 };
    const { x, y } = computeGameTooltipPos({
      targetRect: { left: 120, top: 150, width: 200, height: 24, right: 320, bottom: 174 },
      cardRect, tipW: 240, tipH: 220, ...vp,
    });
    assert.ok(x >= cardRect.right, `beside the card (x=${x} >= ${cardRect.right})`);
    assert.ok(y + 220 <= 800 - 6, 'clamped to the viewport');
  });
});
