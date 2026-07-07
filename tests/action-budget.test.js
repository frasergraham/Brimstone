// Action budget: the faction breakdown math (Faction.computeBudgetBreakdown) and
// the top-bar pip / tooltip renderers (buildActionPipsHtml / buildActionBudgetTooltipHtml).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getFaction } from '../src/factions.js';
import { buildActionPipsHtml, buildActionBudgetTooltipHtml } from '../src/ui-render.js';
import { computeActions } from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { UIController } from '../src/ui.js';

describe('Faction.computeBudgetBreakdown', () => {
  const hero  = getFaction('hero');
  const witch = getFaction('witch');

  test('parts sum to total, and total equals computeBudget()', () => {
    for (const [f, phase, units, nodes] of [
      [hero, 'day', 2, 1], [hero, 'night', 10, 0], [witch, 'night', 1, 2], [witch, 'day', 0, 0],
    ]) {
      const { parts, total } = f.computeBudgetBreakdown(phase, units, nodes);
      assert.equal(parts.reduce((s, p) => s + p.value, 0), total, 'parts sum to total');
      assert.equal(total, f.computeBudget(phase, units, nodes), 'total matches computeBudget');
    }
  });

  test('hero: base 3, +1 favourable phase, survivors capped at unitBonusCap, +nodes', () => {
    const { parts } = hero.computeBudgetBreakdown('day', 2, 1);
    assert.deepEqual(parts.map(p => [p.key, p.value]), [['base', 3], ['phase', 1], ['unit', 2], ['node', 1]]);
    // 10 survivors clamp to the cap (5), unfavourable phase gives no time bonus.
    const capped = hero.computeBudgetBreakdown('night', 10, 0);
    assert.equal(capped.parts.find(p => p.key === 'unit').value, hero.unitBonusCap);
    assert.equal(capped.parts.find(p => p.key === 'phase').value, 0);
  });

  test('action cap trims later parts first (node, then unit) so parts never exceed the total', () => {
    // base3 + phase1 + unit5 + node3 = 12, capped to actionCap (8) → node 0, unit 4.
    const { parts, total } = hero.computeBudgetBreakdown('day', 5, 3);
    assert.equal(total, hero.actionCap);
    assert.equal(parts.find(p => p.key === 'node').value, 0, 'node trimmed first');
    assert.equal(parts.find(p => p.key === 'unit').value, 4, 'unit trimmed next');
    assert.equal(parts.find(p => p.key === 'base').value, 3, 'base never trimmed');
  });

  test('witch survivor cap differs from hero (regression: old breakdown hardcoded 3)', () => {
    // Witch unitBonusCap is 4; 4 minions must all count.
    const { parts } = witch.computeBudgetBreakdown('day', 4, 0);
    assert.equal(parts.find(p => p.key === 'unit').value, Math.min(4, witch.unitBonusCap));
    assert.ok(witch.unitBonusCap >= 4, 'witch cap is at least 4');
  });
});

describe('UIController._computeActionBudget — Budget Badge matches the real budget', () => {
  // The method touches no DOM: call it headlessly on a minimal `this`.
  const badge = (faction, entities, phase = 'day') =>
    UIController.prototype._computeActionBudget.call({
      _planFaction: faction,
      state: { phase, entities, inventory: { hero: {}, witch: {} }, witchObjectives: [] },
    });

  test('captain: badge resolves the CONCRETE faction — base 4, soldiers counted against CAPTAIN', () => {
    const entities = [
      { alive: true, owner: 'hero', type: EntityType.CAPTAIN, factionId: 'captain' },
      { alive: true, owner: 'hero', type: EntityType.SOLDIER },
      { alive: true, owner: 'hero', type: EntityType.SOLDIER },
    ];
    const { parts, total } = badge('hero', entities);
    assert.equal(parts.find(p => p.key === 'base').value, 4, 'captain base is 4, not the paladin 3');
    assert.equal(parts.find(p => p.key === 'unit').value, 2,
      'soldiers count as unit extras (leader excluded via the concrete leaderType)');
    assert.equal(total, computeActions('hero', 'day', entities, 0),
      'badge total equals the budget the game actually grants');
  });

  test('captain: action cap 9 applies (the side-faction badge used to clip at 8)', () => {
    const entities = [
      { alive: true, owner: 'hero', type: EntityType.CAPTAIN, factionId: 'captain' },
      ...Array.from({ length: 6 }, () => ({ alive: true, owner: 'hero', type: EntityType.SOLDIER })),
    ];
    // base 4 + day 1 + unit 5 (cap) = 10 → clipped to the captain's cap of 9.
    const { total } = badge('hero', entities, 'day');
    assert.equal(total, 9);
    assert.equal(total, computeActions('hero', 'day', entities, 0));
  });

  test('default factions unchanged: paladin and witch badges match computeActions', () => {
    for (const [faction, leaderType, unitType] of [
      ['hero', EntityType.HERO, EntityType.SURVIVOR],
      ['witch', EntityType.WITCH, EntityType.MINION],
    ]) {
      const entities = [
        { alive: true, owner: faction, type: leaderType },
        { alive: true, owner: faction, type: unitType },
      ];
      const { total } = badge(faction, entities, 'day');
      assert.equal(total, computeActions(faction, 'day', entities, 0), faction);
    }
  });
});

describe('buildActionPipsHtml', () => {
  const parts = [{ key: 'base', value: 3 }, { key: 'phase', value: 1 }];

  test('one pip per earned action, tinted by source, all filled when nothing used', () => {
    const html = buildActionPipsHtml(parts, 0);
    assert.equal((html.match(/act-pip--/g) || []).length, 4, '4 source-tinted pips');
    assert.equal((html.match(/act-pip--base/g) || []).length, 3);
    assert.equal((html.match(/act-pip--phase/g) || []).length, 1);
    assert.ok(!html.includes('act-pip--spent'), 'nothing spent');
    assert.ok(html.includes('◆') && !html.includes('◇'), 'all filled diamonds');
  });

  test('spent pips render hollow + dimmed, counted from the end', () => {
    const html = buildActionPipsHtml(parts, 2); // 4 total, 2 used → last 2 spent
    assert.equal((html.match(/act-pip--spent/g) || []).length, 2);
    assert.equal((html.match(/◇/g) || []).length, 2, 'two hollow');
    assert.equal((html.match(/◆/g) || []).length, 2, 'two filled');
  });

  test('actions beyond the budget append spent food pips', () => {
    const html = buildActionPipsHtml(parts, 6); // 4 budget (all spent) + 2 food
    assert.equal((html.match(/act-pip--food/g) || []).length, 2);
    assert.equal((html.match(/act-pip--spent/g) || []).length, 6, 'all spent');
  });

  test('empty / missing parts → no pips, no throw', () => {
    assert.equal(buildActionPipsHtml(undefined, 0), '');
    assert.equal(buildActionPipsHtml([], 0), '');
    // No budget but actions used ⇒ all food-powered overflow pips.
    assert.equal((buildActionPipsHtml([], 3).match(/act-pip--food/g) || []).length, 3);
  });
});

describe('buildActionBudgetTooltipHtml', () => {
  const rows = [{ key: 'base', label: 'Base', value: 3 }, { key: 'unit', label: 'Survivors (2)', value: 2 }];

  test('one shaded row per source + a Total row', () => {
    const html = buildActionBudgetTooltipHtml(rows, 5);
    assert.ok(html.includes('act-src--base'));
    assert.ok(html.includes('act-src--unit'));
    assert.ok(html.includes('+3') && html.includes('+2'));
    assert.match(html, /abkd-total[\s\S]*5/);
  });

  test('food label adds a trailing food-shaded row', () => {
    const html = buildActionBudgetTooltipHtml(rows, 5, 'Food ×2');
    assert.ok(html.includes('act-src--food'));
    assert.ok(html.includes('Food ×2'));
  });

  test('no food label → no food row', () => {
    assert.ok(!buildActionBudgetTooltipHtml(rows, 5).includes('act-src--food'));
  });
});
