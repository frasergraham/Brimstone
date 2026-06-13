// Tests for the shared wrap-up battle-summary builders (src/wrapup-summary.js)
// and the combat tester's adapter that feeds them (battleWrapupPair).
//
// These pin the markup contract both consumers rely on: the in-game
// end-of-turn wrap-up card (ui.js) and the admin Combat tester log.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WRAPUP_GLYPHS, wrapupIconHtml, wrapupUnitCellHtml, buildWrapupCombatsHtml,
} from '../src/wrapup-summary.js';
import { createCombatTester, battleWrapupPair } from '../src/tools/combat-tester.js';

// Glyph-only icon builder — what a renderer-less caller produces.
const glyphIcon = (u) => wrapupIconHtml(u);

const unit = (over = {}) => ({
  id: 1, type: 'minion', title: null, name: 'minion',
  color: null, hpLost: 0, killed: false, ...over,
});

describe('wrapup-summary — wrapupIconHtml', () => {
  test('renders a portrait img with the unit colour border when src is given', () => {
    const html = wrapupIconHtml(unit({ color: '#abc' }), { src: 'data:image/png;base64,x' });
    assert.ok(html.startsWith('<img class="wrapup-unit-icon"'));
    assert.ok(html.includes('src="data:image/png;base64,x"'));
    assert.ok(html.includes('border-color:#abc'));
  });

  test('falls back to a coloured glyph badge without a src', () => {
    const html = wrapupIconHtml(unit({ type: 'zombie' }));
    assert.ok(html.startsWith('<span class="wrapup-unit-icon"'));
    assert.ok(html.includes(WRAPUP_GLYPHS.zombie));
  });

  test('unknown type falls back to "?" and the default colour', () => {
    const html = wrapupIconHtml({ type: 'mystery' });
    assert.ok(html.includes('?'));
    assert.ok(html.includes('#888'));
  });

  test('custom class is applied to both img and glyph forms', () => {
    assert.ok(wrapupIconHtml(unit(), { cls: 'wrapup-found-icon' }).includes('class="wrapup-found-icon"'));
    assert.ok(wrapupIconHtml(unit(), { src: 'x', cls: 'wrapup-found-icon' }).includes('class="wrapup-found-icon"'));
  });
});

describe('wrapup-summary — wrapupUnitCellHtml', () => {
  test('killed unit shows the skull badge with DIED label', () => {
    const html = wrapupUnitCellHtml(unit({ killed: true, hpLost: 3 }), '<i/>');
    assert.ok(html.includes('wrapup-dmg kill'));
    assert.ok(html.includes('☠ DIED'));
  });

  test('hurt unit shows −N', () => {
    const html = wrapupUnitCellHtml(unit({ hpLost: 2 }), '<i/>');
    assert.ok(html.includes('>−2<'));
    assert.ok(!html.includes('kill'));
  });

  test('untouched unit shows the muted dash', () => {
    const html = wrapupUnitCellHtml(unit(), '<i/>');
    assert.ok(html.includes('wrapup-dmg none'));
    assert.ok(html.includes('—'));
  });
});

describe('wrapup-summary — buildWrapupCombatsHtml', () => {
  const pair = (a = {}, b = {}) => ({
    a: unit({ id: 1, type: 'hero', ...a }),
    b: unit({ id: 2, type: 'witch', ...b }),
  });

  test('no combats yields empty string (caller picks the quiet-turn copy)', () => {
    assert.equal(buildWrapupCombatsHtml([], glyphIcon), '');
    assert.equal(buildWrapupCombatsHtml(null, glyphIcon), '');
  });

  test('≤3 pairs render one [icon] vs [icon] row each', () => {
    const html = buildWrapupCombatsHtml([pair({ hpLost: 1 }, { hpLost: 2 })], glyphIcon);
    assert.equal((html.match(/wrapup-combat/g) ?? []).length, 1);
    assert.ok(html.includes('wrapup-vs'));
    assert.ok(html.includes('>−1<'));
    assert.ok(html.includes('>−2<'));
  });

  test('>3 pairs condense into one casualties row of hurt units only', () => {
    const combats = [
      pair({ id: 1, hpLost: 1 }, { id: 2 }),
      pair({ id: 1, hpLost: 2 }, { id: 3 }),
      pair({ id: 4 }, { id: 5, killed: true }),
      pair({ id: 6 }, { id: 7 }),
    ];
    const html = buildWrapupCombatsHtml(combats, glyphIcon);
    assert.ok(html.includes('wrapup-casualties'));
    assert.ok(!html.includes('wrapup-combat'));
    // Unit 1 fought twice — its losses aggregate to −3.
    assert.ok(html.includes('>−3<'));
    // Kill skull for unit 5; unhurt units (2,3,4,6,7) are dropped entirely.
    assert.equal((html.match(/wrapup-unit"/g) ?? []).length, 2);
    assert.ok(html.includes('☠'));
  });

  test('>3 pairs with no damage report bloodless skirmishes', () => {
    const combats = [pair(), pair(), pair(), pair()];
    const html = buildWrapupCombatsHtml(combats, glyphIcon);
    assert.ok(html.includes('4 skirmishes — no casualties.'));
  });
});

describe('combat-tester — battleWrapupPair', () => {
  test('maps strike damage to the defender and counter damage to the attacker', () => {
    const out = {
      attackerSnap: { id: 10, type: 'paladin', title: null },
      defenderSnap: { id: 11, type: 'witch', title: null },
      result: { damage: 2, counterDmg: 1, killed: false },
      attackerKilled: false,
    };
    const { a, b } = battleWrapupPair(out);
    assert.equal(a.id, 10);
    assert.equal(a.hpLost, 1);
    assert.equal(a.killed, false);
    assert.equal(b.id, 11);
    assert.equal(b.hpLost, 2);
    assert.equal(b.killed, false);
  });

  test('defender kill and attacker counter-kill set the killed flags', () => {
    const out = {
      attackerSnap: { id: 10, type: 'minion' },
      defenderSnap: { id: 11, type: 'survivor', title: 'Nurse' },
      result: { damage: 3, counterDmg: 2, killed: true },
      attackerKilled: true,
    };
    const { a, b } = battleWrapupPair(out);
    assert.equal(a.killed, true);
    assert.equal(b.killed, true);
    assert.equal(b.title, 'Nurse');
  });

  test('missing damage fields default to 0 (clean miss renders dashes)', () => {
    const out = {
      attackerSnap: { id: 1, type: 'zombie' },
      defenderSnap: { id: 2, type: 'soldier' },
      result: { hit: false },
    };
    const { a, b } = battleWrapupPair(out);
    assert.equal(a.hpLost, 0);
    assert.equal(b.hpLost, 0);
    assert.equal(a.killed, false);
    assert.equal(b.killed, false);
  });

  test('runBattle output feeds battleWrapupPair end-to-end (real executeBattle)', () => {
    const t = createCombatTester();
    t.setAttacker('paladin');
    t.setDefender('minion');
    const out = t.runBattle();
    assert.ok(out, 'battle should resolve');
    assert.equal(typeof out.attackerKilled, 'boolean');
    const { a, b } = battleWrapupPair(out);
    assert.equal(a.type, 'paladin');
    assert.equal(b.type, 'minion');
    assert.equal(b.hpLost, out.result.damage ?? 0);
    assert.equal(a.hpLost, out.result.counterDmg ?? 0);
    // The summary html renders without a renderer (glyph fallback).
    const html = buildWrapupCombatsHtml([{ a, b }], glyphIcon);
    assert.ok(html.includes('wrapup-combat'));
  });
});

describe('wrapup-summary — splash row', () => {
  test('a pair with splash victims renders a splash sub-row with each victim', () => {
    const combats = [{
      a: unit({ id: 'h', name: 'Brute', hpLost: 0 }),
      b: unit({ id: 'm1', name: 'minion', hpLost: 4 }),
      splash: [
        unit({ id: 'm2', name: 'minion2', hpLost: 1 }),
        unit({ id: 'm3', name: 'minion3', hpLost: 1, killed: true }),
      ],
    }];
    const html = buildWrapupCombatsHtml(combats, glyphIcon);
    assert.ok(html.includes('wrapup-splash'), 'splash sub-row rendered');
    assert.ok(html.includes('💢'), 'splash glyph present');
    assert.ok(html.includes('☠'), 'splash kill skull shown');
  });

  test('no splash → no splash row', () => {
    const combats = [{ a: unit({ id: 1 }), b: unit({ id: 2, hpLost: 1 }) }];
    const html = buildWrapupCombatsHtml(combats, glyphIcon);
    assert.ok(!html.includes('wrapup-splash'));
  });

  test('condensed (>3 combats) casualties fold splash victims in', () => {
    const pair = (i, splash = []) => ({
      a: unit({ id: `a${i}`, name: `a${i}` }),
      b: unit({ id: `b${i}`, name: `b${i}`, hpLost: 1 }),
      splash,
    });
    const combats = [
      pair(1, [unit({ id: 'sv', name: 'sv', hpLost: 1 })]),
      pair(2), pair(3), pair(4),
    ];
    const html = buildWrapupCombatsHtml(combats, glyphIcon);
    assert.ok(html.includes('wrapup-casualties'));
    // The splash victim is among the aggregated casualties.
    assert.ok((html.match(/wrapup-unit\b/g) ?? []).length >= 5);
  });
});
