// Tests for pure render functions in src/ui-render.js.
// No DOM, no browser globals required.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describePlanAction,
  buildPlanStepsHtml,
  buildPlayerStatusHtml,
  buildObjectivesHtml,
  buildNodeBadgeHtml,
  buildUnitDetailHtml,
  buildCycleInfoHtml,
} from '../../src/ui-render.js';
import { PlanActionType } from '../../src/planner.js';
import { EntityType } from '../../src/entities.js';

// ── describePlanAction ────────────────────────────────────────────────────────

describe('describePlanAction', () => {
  const hero = { id: 'h1', displayName: 'Hero' };
  const witch = { id: 'w1', displayName: 'Witch' };
  const entities = [hero, witch];

  test('MOVE action', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.MOVE, entityId: 'h1', toCol: 5, toRow: 3 }, entities),
      'Hero → (5,3)',
    );
  });

  test('BATTLE_UNIT action names the target', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.BATTLE_UNIT, entityId: 'h1', targetId: 'w1' }, entities),
      'Hero attacks Witch',
    );
  });

  test('BATTLE_UNIT with unknown target shows ?', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.BATTLE_UNIT, entityId: 'h1', targetId: 'missing' }, entities),
      'Hero attacks ?',
    );
  });

  test('BATTLE_HEX action', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.BATTLE_HEX, entityId: 'h1', targetCol: 2, targetRow: 4 }, entities),
      'Hero attacks (2,4)',
    );
  });

  test('EXPLORE action', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.EXPLORE, entityId: 'h1' }, entities),
      'Hero explores',
    );
  });

  test('FORTIFY action', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.FORTIFY, entityId: 'h1' }, entities),
      'Hero fortifies',
    );
  });

  test('SUMMON action', () => {
    // Summons spawn on the summoner's own tile now (no chosen hex), so the
    // description carries no coordinates.
    assert.equal(
      describePlanAction({ type: PlanActionType.SUMMON, entityId: 'w1' }, entities),
      'Witch summons',
    );
  });

  test('USE_ITEM action includes item name', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.USE_ITEM, entityId: 'h1', item: 'herbs' }, entities),
      'Hero uses herbs',
    );
  });

  test('EQUIP_WEAPON action', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.EQUIP_WEAPON, entityId: 'h1', weapon: 'sword' }, entities),
      'Hero equips sword',
    );
  });

  test('USE_ABILITY action', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.USE_ABILITY, entityId: 'h1' }, entities),
      'Hero uses ability',
    );
  });

  test('unknown entity falls back to "Unit"', () => {
    assert.equal(
      describePlanAction({ type: PlanActionType.EXPLORE, entityId: 'missing' }, entities),
      'Unit explores',
    );
  });

  test('unknown action type falls back to step number', () => {
    const result = describePlanAction({ type: 'UNKNOWN', entityId: 'h1' }, entities, 3);
    assert.equal(result, 'Step 4');
  });
});

// ── buildPlanStepsHtml ────────────────────────────────────────────────────────

describe('buildPlanStepsHtml', () => {
  const hero = { id: 'h1', displayName: 'Hero', type: EntityType.HERO };
  const entities = [hero];

  test('empty plan shows placeholder message', () => {
    const html = buildPlanStepsHtml([], 3, 0, false, []);
    assert.ok(html.includes('No actions queued'), `expected placeholder, got: ${html}`);
  });

  test('single MOVE step shows step number and description', () => {
    const plan = [{ type: PlanActionType.MOVE, entityId: 'h1', toCol: 4, toRow: 2 }];
    const html = buildPlanStepsHtml(plan, 3, 0, false, entities);
    assert.ok(html.includes('plan-step'), 'should have plan-step class');
    assert.ok(html.includes('plan-step-num'), 'should have step number');
    assert.ok(html.includes('Hero'), 'should include entity name');
    assert.ok(html.includes('(4,2)'), 'should include coordinates');
  });

  test('remove button present when not submitted', () => {
    const plan = [{ type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 }];
    const html = buildPlanStepsHtml(plan, 3, 0, false, entities);
    assert.ok(html.includes('plan-step-remove'), 'remove button should be present');
  });

  test('remove button absent when submitted', () => {
    const plan = [{ type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 }];
    const html = buildPlanStepsHtml(plan, 3, 0, true, entities);
    assert.ok(!html.includes('plan-step-remove'), 'remove button should be absent after submit');
  });

  test('over-budget steps get over-budget class', () => {
    // budget=1, two moves → second is over budget
    const plan = [
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 2 },
    ];
    const html = buildPlanStepsHtml(plan, 1, 0, false, entities);
    assert.ok(html.includes('over-budget'), 'second step should be over-budget');
  });

  test('food-powered steps get food-powered class and food tag', () => {
    const plan = [
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 2 },
    ];
    // budget=1, foodAvailable=1 → second step is food-powered not over-budget
    const html = buildPlanStepsHtml(plan, 1, 1, false, entities);
    assert.ok(html.includes('food-powered'), 'second step should be food-powered');
    assert.ok(html.includes('plan-food-tag'), 'food tag should be present');
    assert.ok(!html.includes('over-budget'), 'should not be over-budget when food covers it');
  });

  test('free actions (EQUIP_WEAPON, USE_ITEM) do not count against budget', () => {
    const plan = [
      { type: PlanActionType.EQUIP_WEAPON, entityId: 'h1', weapon: 'sword' },
      { type: PlanActionType.USE_ITEM, entityId: 'h1', item: 'herbs' },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 3, toRow: 3 },
    ];
    // budget=1, the two free actions should not count
    const html = buildPlanStepsHtml(plan, 1, 0, false, entities);
    assert.ok(!html.includes('over-budget'), 'free actions should not push move over budget');
  });

  test('multiple steps numbered correctly', () => {
    const plan = [
      { type: PlanActionType.EXPLORE, entityId: 'h1' },
      { type: PlanActionType.FORTIFY, entityId: 'h1' },
    ];
    const html = buildPlanStepsHtml(plan, 3, 0, false, entities);
    // Check both step numbers appear
    assert.ok(html.includes('>1<'), `expected step 1 badge in: ${html.substring(0, 200)}`);
    assert.ok(html.includes('>2<'), `expected step 2 badge in: ${html.substring(0, 200)}`);
  });
});

// ── buildPlayerStatusHtml ─────────────────────────────────────────────────────

describe('buildPlayerStatusHtml', () => {
  test('empty players returns empty string', () => {
    assert.equal(buildPlayerStatusHtml([]), '');
  });

  test('single player shows name and waiting state', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero' }];
    const html = buildPlayerStatusHtml(players);
    assert.ok(html.includes('Alice'), 'should include player name');
    assert.ok(html.includes('player-waiting'), 'unsubmitted player should be waiting');
    assert.ok(html.includes('⋯'), 'waiting indicator');
  });

  test('submitted player shows ready state', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero', _submitted: true }];
    const html = buildPlayerStatusHtml(players);
    assert.ok(html.includes('player-ready'), 'submitted player should be ready');
    assert.ok(html.includes('✓'), 'ready indicator');
  });

  test('hero faction gets hero CSS class', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero' }];
    const html = buildPlayerStatusHtml(players);
    assert.ok(html.includes('faction-hero'), 'hero gets faction-hero class');
    assert.ok(html.includes('⚔'), 'hero glyph');
  });

  test('witch faction gets witch CSS class', () => {
    const players = [{ playerId: 'p1', name: 'Bob', faction: 'witch' }];
    const html = buildPlayerStatusHtml(players);
    assert.ok(html.includes('faction-witch'), 'witch gets faction-witch class');
    assert.ok(html.includes('✦'), 'witch glyph');
  });

  test('XSS chars in name are escaped', () => {
    const players = [{ playerId: 'p1', name: '<script>alert(1)</script>', faction: 'hero' }];
    const html = buildPlayerStatusHtml(players);
    assert.ok(!html.includes('<script>'), 'raw <script> should be escaped');
    assert.ok(html.includes('&lt;script&gt;'), 'should use HTML entities');
  });

  test('per-player color is applied to name and icon when present', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero', color: '#d4a72c' }];
    const html = buildPlayerStatusHtml(players);
    // Both the icon span and the name span should get an inline color style.
    const matches = html.match(/style="color: #d4a72c"/g) ?? [];
    assert.equal(matches.length, 2, 'color applied to both icon and name spans');
    // Faction class is still present as a semantic marker / fallback.
    assert.ok(html.includes('faction-hero'), 'faction class still present alongside inline color');
  });

  test('missing color falls back to faction CSS class only', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero' }];
    const html = buildPlayerStatusHtml(players);
    assert.ok(!html.includes('style="color:'), 'no inline color style when color absent');
    assert.ok(html.includes('faction-hero'), 'faction class fallback present');
  });

  test('null color falls back to faction CSS class only', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'witch', color: null }];
    const html = buildPlayerStatusHtml(players);
    assert.ok(!html.includes('style="color:'), 'null color does not produce inline style');
    assert.ok(html.includes('faction-witch'), 'faction class fallback present');
  });

  test('invalid color values are rejected (injection defense)', () => {
    const badColors = [
      '"><script>alert(1)</script>',
      'red; background:url(evil)',
      'javascript:alert(1)',
      '#xyz',
      '#12',
      'rgb(255,0,0)',
      '#1234567890',
    ];
    for (const bad of badColors) {
      const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero', color: bad }];
      const html = buildPlayerStatusHtml(players);
      assert.ok(!html.includes(bad), `bad color "${bad}" should not appear in output`);
      assert.ok(!html.includes('<script>'), 'no raw <script> leaks through');
      assert.ok(!html.includes('style="color:'), `no inline color style for bad value "${bad}"`);
    }
  });
});

// ── buildObjectivesHtml ───────────────────────────────────────────────────────

describe('buildObjectivesHtml', () => {
  const objectives = [
    { col: 3, row: 3, label: 'Node A', hexes: [{ col: 3, row: 3 }, { col: 3, row: 2 }, { col: 4, row: 2 }] },
    { col: 7, row: 5, label: 'Node B', hexes: [{ col: 7, row: 5 }, { col: 7, row: 4 }, { col: 8, row: 4 }] },
    { col: 5, row: 9, label: 'Node C', hexes: [{ col: 5, row: 9 }, { col: 5, row: 8 }, { col: 6, row: 8 }] },
  ];

  test('neutral nodes get neutral class', () => {
    const { html } = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 });
    const matches = (html.match(/class="node-dot neutral"/g) || []).length;
    assert.equal(matches, 3, 'all 3 nodes should be neutral when no entities present');
  });

  test('hero presence on node gives hero class', () => {
    const entities = [{ alive: true, owner: 'hero', col: 3, row: 3 }];
    const { html } = buildObjectivesHtml(objectives, entities, { hero: 0, witch: 0 });
    assert.ok(html.includes('node-dot hero'), 'hero-occupied node should have hero class');
  });

  test('witch presence on node gives witch class', () => {
    const entities = [{ alive: true, owner: 'witch', col: 7, row: 5 }];
    const { html } = buildObjectivesHtml(objectives, entities, { hero: 0, witch: 0 });
    assert.ok(html.includes('node-dot witch'), 'witch-occupied node should have witch class');
  });

  test('score pips render correctly', () => {
    const { html } = buildObjectivesHtml(objectives, [], { hero: 2, witch: 1 });
    const heroFilled   = (html.match(/score-pip hero filled/g) || []).length;
    const witchFilled  = (html.match(/score-pip witch filled/g) || []).length;
    assert.equal(heroFilled, 2, 'hero should have 2 filled pips');
    assert.equal(witchFilled, 1, 'witch should have 1 filled pip');
  });

  test('no native title tooltips — the cycle/score panel explains scoring instead', () => {
    const entities = [
      { alive: true, owner: 'witch', col: 3, row: 3 },
      { alive: true, owner: 'hero', col: 7, row: 5 },
    ];
    const { html, title } = buildObjectivesHtml(objectives, entities, { hero: 1, witch: 2 });
    assert.ok(!html.includes('title='), 'score bar HTML must carry no title attributes');
    assert.equal(title, undefined, 'no title is returned — tapping the bar opens the info panel');
  });

  test('contested node gets contested class when both factions occupy equal hexes', () => {
    const entities = [
      { alive: true, owner: 'hero', col: 3, row: 3 },
      { alive: true, owner: 'witch', col: 3, row: 2 },
    ];
    const { html } = buildObjectivesHtml(objectives, entities, { hero: 0, witch: 0 });
    assert.ok(html.includes('node-dot contested'), 'equally occupied node should have contested class');
  });
});

// ── buildNodeBadgeHtml ────────────────────────────────────────────────────────

describe('buildNodeBadgeHtml', () => {
  const node = {
    col: 3, row: 3, label: 'Ancient Altar', color: '#22c55e',
    hexes: [{ col: 3, row: 3 }, { col: 3, row: 2 }, { col: 4, row: 3 }],
  };
  const objectives = [node];

  test('hex outside any node → empty string', () => {
    assert.equal(buildNodeBadgeHtml(objectives, [], 9, 9), '');
  });

  test('no objectives → empty string', () => {
    assert.equal(buildNodeBadgeHtml([], [], 3, 3), '');
    assert.equal(buildNodeBadgeHtml(undefined, [], 3, 3), '');
  });

  test('uncontrolled node shows name, color and Uncontrolled', () => {
    const html = buildNodeBadgeHtml(objectives, [], 3, 3);
    assert.ok(html.includes('Ancient Altar'), 'shows node name');
    assert.ok(html.includes('#22c55e'), 'shows node color');
    assert.ok(html.includes('Uncontrolled'), 'shows uncontrolled state');
  });

  test('hero-controlled node shows Hero in hero color', () => {
    const entities = [{ alive: true, owner: 'hero', col: 3, row: 3 }];
    const html = buildNodeBadgeHtml(objectives, entities, 4, 3);
    assert.ok(html.includes('Hero'), 'shows Hero');
    assert.ok(html.includes('#4488ff'), 'shows hero highlight color');
  });

  test('witch-controlled node shows Witch', () => {
    const entities = [{ alive: true, owner: 'witch', col: 3, row: 2 }];
    const html = buildNodeBadgeHtml(objectives, entities, 3, 3);
    assert.ok(html.includes('Witch'), 'shows Witch');
    assert.ok(html.includes('#cc3333'), 'shows witch highlight color');
  });

  test('contested node (equal occupation) shows Contested', () => {
    const entities = [
      { alive: true, owner: 'hero', col: 3, row: 3 },
      { alive: true, owner: 'witch', col: 3, row: 2 },
    ];
    const html = buildNodeBadgeHtml(objectives, entities, 4, 3);
    assert.ok(html.includes('Contested'), 'shows Contested');
  });
});

// ── buildUnitDetailHtml (plan-panel per-unit detail) ──────────────────────────

describe('buildUnitDetailHtml', () => {
  test('renders HP, equipped weapon, and ATK/DEF/RNG from fallback fields', () => {
    const e = { hp: 14, maxHp: 14, attack: 4, defense: 2, range: 1, weapon: 'sword', items: {} };
    const html = buildUnitDetailHtml(e, e.items);
    assert.ok(html.includes('14/14'), 'shows HP');
    assert.ok(html.includes('Sword'), 'shows equipped weapon label');
    assert.ok(html.includes('<span class="usb-stat-val">4</span>'), 'ATK 4');
    assert.ok(html.includes('<span class="usb-stat-val">2</span>'), 'DEF 2');
    assert.ok(html.includes('<span class="usb-stat-val">1</span>'), 'RNG 1');
  });

  test('prefers getAttack/getDefense/getRange methods when present', () => {
    const e = {
      hp: 10, maxHp: 10, weapon: null, items: {},
      getAttack: () => 9, getDefense: () => 5, getRange: () => 3,
    };
    const html = buildUnitDetailHtml(e, e.items);
    assert.ok(html.includes('<span class="usb-stat-val">9</span>'), 'effective ATK 9');
    assert.ok(html.includes('<span class="usb-stat-val">5</span>'), 'effective DEF 5');
    assert.ok(html.includes('<span class="usb-stat-val">3</span>'), 'effective RNG 3');
  });

  test('lists carried pack items with counts (weapons and consumables)', () => {
    const e = { hp: 10, maxHp: 10, attack: 3, defense: 1, range: 3, weapon: 'bow',
                items: { dagger: 1, herbs: 2 } };
    const html = buildUnitDetailHtml(e, e.items);
    assert.ok(html.includes('Dagger'), 'weapon item labelled via WEAPON_LABEL');
    assert.ok(html.includes('Herbs'),  'consumable labelled via RESOURCE_LABEL');
    assert.ok(html.includes('×1'), 'dagger count');
    assert.ok(html.includes('×2'), 'herbs count');
    assert.ok(!html.includes('No spare items'), 'not empty');
  });

  test('falls back to entity.items when items arg omitted', () => {
    const e = { hp: 10, maxHp: 10, attack: 3, defense: 1, range: 1, weapon: null,
                items: { sword: 1 } };
    const html = buildUnitDetailHtml(e);
    assert.ok(html.includes('Sword'), 'reads entity.items');
    assert.ok(html.includes('×1'));
  });

  test('shows "No spare items" when the unit carries no spare (unequipped) items', () => {
    // The equipped sword lives in the vitals weapon line, not the pack — the
    // pack lists only spare/unequipped items.
    const e = { hp: 10, maxHp: 10, attack: 3, defense: 1, range: 1, weapon: 'sword', items: {} };
    const html = buildUnitDetailHtml(e, {});
    assert.ok(html.includes('No spare items'), 'pack empty state');
    assert.ok(html.includes('Sword'), 'equipped weapon still shown in vitals');
  });

  test('shows Unarmed when no weapon is equipped', () => {
    const e = { hp: 10, maxHp: 10, attack: 1, defense: 1, range: 1, weapon: null, items: {} };
    assert.ok(buildUnitDetailHtml(e, {}).includes('👊 Unarmed'));
  });
});

// ── buildCycleInfoHtml (cycle & scoring info panel) ───────────────────────────

describe('buildCycleInfoHtml', () => {
  const baseState = {
    round: 6,            // round 6 of the default 8-round cycle → NIGHT
    cycleConfig: null,
    gameMode: 'standard',
    nodeScore: { hero: 1, witch: 2 },
    nodeScoreThreshold: 4,
    entities: [{ alive: true, owner: 'witch', col: 3, row: 3 }],
    witchObjectives: [
      { col: 3, row: 3, label: 'Whispering Stone', color: '#22c55e', hexes: [{ col: 3, row: 3 }] },
    ],
  };

  test('shows current and next phase with their effects', () => {
    const html = buildCycleInfoHtml(baseState);
    assert.ok(html.includes('Night'), 'current phase named');
    assert.ok(html.includes('Witch +2 ATK'), 'current phase effects shown');
    assert.ok(html.includes('Next:'), 'next phase preview present');
  });

  test('explains the scoring rule and the win threshold', () => {
    const html = buildCycleInfoHtml(baseState);
    assert.ok(html.includes('dawn'), 'mentions dawn scoring');
    assert.ok(html.includes('dusk'), 'mentions dusk scoring');
    assert.ok(html.includes('4 points'), 'states the win threshold');
  });

  test('lists each node with its current holder', () => {
    const html = buildCycleInfoHtml(baseState);
    assert.ok(html.includes('Whispering Stone'));
    assert.ok(html.includes('Witch'), 'holder shown');
  });

  test('cycle strip highlights the current round chip', () => {
    const html = buildCycleInfoHtml(baseState);
    const chips = (html.match(/cip-chip/g) || []).length;
    assert.equal(chips, 8, 'one chip per round of the default cycle');
    assert.equal((html.match(/cip-chip[^"]*current/g) || []).length, 1, 'exactly one current chip');
  });

  test('battle mode swaps in the every-round scoring rule', () => {
    const html = buildCycleInfoHtml({ ...baseState, gameMode: 'battle' });
    assert.ok(html.includes('every round'));
    assert.ok(!html.includes('4 points'));
  });

  test('score renders as pips matching the bar, not numbers', () => {
    const html = buildCycleInfoHtml(baseState);
    assert.equal((html.match(/score-pip hero filled/g) || []).length, 1);
    assert.equal((html.match(/score-pip witch filled/g) || []).length, 2);
    assert.equal((html.match(/score-pip hero/g) || []).length, 4, 'threshold pips per side');
    assert.ok(!html.includes('1/4'), 'no numeric x/4 display');
  });

  test('uses the game cycle sprites when icon data URLs are supplied', () => {
    const icons = { night: 'data:night', dawn: 'data:dawn', day: 'data:day', dusk: 'data:dusk' };
    const html = buildCycleInfoHtml(baseState, icons);
    assert.ok(html.includes('class="cip-icon" src="data:night"'), 'current phase uses its sprite');
    assert.ok((html.match(/cip-icon/g) || []).length >= 10, 'strip chips use sprites too');
    const plain = buildCycleInfoHtml(baseState);
    assert.ok(!plain.includes('cip-icon'), 'emoji fallback without icons');
  });

  test('disableScoring hides the scoring rule and the score pips', () => {
    // Campaign missions with disableScoring never award node points — the
    // panel must not show the rule text or a score readout for them.
    const html = buildCycleInfoHtml({ ...baseState, disableScoring: true });
    assert.ok(!html.includes('cip-rule'), 'no scoring rule text');
    assert.ok(!html.includes('cip-score'), 'no score pips row');
    assert.ok(!html.includes('score-pip'), 'no pips at all');
    // Phase cycle info and node holders stay — they're still meaningful.
    assert.ok(html.includes('Night'));
    assert.ok(html.includes('Whispering Stone'));
  });

  test('disableScoring in battle mode hides the numeric score too', () => {
    const html = buildCycleInfoHtml({ ...baseState, gameMode: 'battle', disableScoring: true });
    assert.ok(!html.includes('cip-rule'));
    assert.ok(!html.includes('cip-score'));
  });

  test('disableScoring strips the scoring mention from dawn/dusk phase blurbs', () => {
    // Round 8 of the default cycle → DAWN next is... use round 1 (DAWN current).
    const html = buildCycleInfoHtml({ ...baseState, round: 1, disableScoring: true });
    assert.ok(!html.toLowerCase().includes('node scoring'), 'no scoring mention in phase descs');
    assert.ok(html.includes('attrition rises'), 'rest of the dawn blurb kept');
  });
});

// ── Effect letter badges + selected-unit panel parity ─────────────────────────

describe('buildEffectsHtml — letter-in-circle badges', () => {
  test('every effect renders its badge letter in a circle span', async () => {
    const { buildEffectsHtml } = await import('../../src/ui-render.js');
    const html = buildEffectsHtml({ effects: [{ id: 'wounded', duration: 1 }] });
    assert.match(html, /usb-effect-letter/);
    assert.match(html, />W</);
    assert.match(html, /data-kind="bad"/);
    assert.match(html, /usb-effect-pip-dur">1</);
  });

  test('good effects carry data-kind good; stacks render', async () => {
    const { buildEffectsHtml } = await import('../../src/ui-render.js');
    const html = buildEffectsHtml({ effects: [{ id: 'inspired', duration: 2, stacks: 2 }] });
    assert.match(html, /data-kind="good"/);
    assert.match(html, />I</);
    assert.match(html, /×2/);
  });

  test('every EFFECTS entry has a UNIQUE single-letter badge', async () => {
    const { EFFECTS } = await import('../../src/effects.js');
    const badges = Object.values(EFFECTS).map(d => d.badge);
    assert.ok(badges.every(b => typeof b === 'string' && b.length === 1),
      'each effect declares a one-letter badge');
    assert.equal(new Set(badges).size, badges.length, 'badges are unique');
  });
});

describe('buildUnitDetailHtml — plan panel mirrors the Unit Stats Bar', () => {
  test('includes AGI alongside ATK/DEF/RNG (USB expanded-stats parity)', async () => {
    const { buildUnitDetailHtml } = await import('../../src/ui-render.js');
    const entity = {
      hp: 10, maxHp: 14, weapon: null, effects: [],
      getAttack: () => 3, getDefense: () => 2, getRange: () => 1, getAgility: () => 4,
    };
    const html = buildUnitDetailHtml(entity, {});
    assert.match(html, /AGI/);
    assert.match(html, />4</);
  });
});
