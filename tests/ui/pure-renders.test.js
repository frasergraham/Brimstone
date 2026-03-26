// Tests for pure render functions in src/ui-render.js.
// No DOM, no browser globals required.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describePlanAction,
  buildPlanStepsHtml,
  buildPlayerStatusHtml,
  buildObjectivesHtml,
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
    assert.equal(
      describePlanAction({ type: PlanActionType.SUMMON, entityId: 'w1', toCol: 7, toRow: 2 }, entities),
      'Witch summons at (7,2)',
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
    const html = buildPlanStepsHtml([], 3, 0, 0, false, []);
    assert.ok(html.includes('No actions queued'), `expected placeholder, got: ${html}`);
  });

  test('single MOVE step shows step number and description', () => {
    const plan = [{ type: PlanActionType.MOVE, entityId: 'h1', toCol: 4, toRow: 2 }];
    const html = buildPlanStepsHtml(plan, 3, 0, 0, false, entities);
    assert.ok(html.includes('plan-step'), 'should have plan-step class');
    assert.ok(html.includes('plan-step-num'), 'should have step number');
    assert.ok(html.includes('Hero'), 'should include entity name');
    assert.ok(html.includes('(4,2)'), 'should include coordinates');
  });

  test('remove button present when not submitted', () => {
    const plan = [{ type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 }];
    const html = buildPlanStepsHtml(plan, 3, 0, 0, false, entities);
    assert.ok(html.includes('plan-step-remove'), 'remove button should be present');
  });

  test('remove button absent when submitted', () => {
    const plan = [{ type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 }];
    const html = buildPlanStepsHtml(plan, 3, 0, 0, true, entities);
    assert.ok(!html.includes('plan-step-remove'), 'remove button should be absent after submit');
  });

  test('over-budget steps get over-budget class', () => {
    // budget=1, two moves → second is over budget
    const plan = [
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 2 },
    ];
    const html = buildPlanStepsHtml(plan, 1, 0, 0, false, entities);
    assert.ok(html.includes('over-budget'), 'second step should be over-budget');
  });

  test('food-powered steps get food-powered class and food tag', () => {
    const plan = [
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 1, toRow: 1 },
      { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 2 },
    ];
    // budget=1, foodEnabled=1 → second step is food-powered not over-budget
    const html = buildPlanStepsHtml(plan, 1, 1, 1, false, entities);
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
    const html = buildPlanStepsHtml(plan, 1, 0, 0, false, entities);
    assert.ok(!html.includes('over-budget'), 'free actions should not push move over budget');
  });

  test('multiple steps numbered correctly', () => {
    const plan = [
      { type: PlanActionType.EXPLORE, entityId: 'h1' },
      { type: PlanActionType.FORTIFY, entityId: 'h1' },
    ];
    const html = buildPlanStepsHtml(plan, 3, 0, 0, false, entities);
    // Check both step numbers appear
    assert.ok(html.includes('>1<'), `expected step 1 badge in: ${html.substring(0, 200)}`);
    assert.ok(html.includes('>2<'), `expected step 2 badge in: ${html.substring(0, 200)}`);
  });
});

// ── buildPlayerStatusHtml ─────────────────────────────────────────────────────

describe('buildPlayerStatusHtml', () => {
  test('empty players returns empty string', () => {
    assert.equal(buildPlayerStatusHtml([], null), '');
  });

  test('single player shows name and waiting state', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero' }];
    const html = buildPlayerStatusHtml(players, 'other');
    assert.ok(html.includes('Alice'), 'should include player name');
    assert.ok(html.includes('player-waiting'), 'unsubmitted player should be waiting');
    assert.ok(html.includes('⋯'), 'waiting indicator');
  });

  test('submitted player shows ready state', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero', _submitted: true }];
    const html = buildPlayerStatusHtml(players, 'other');
    assert.ok(html.includes('player-ready'), 'submitted player should be ready');
    assert.ok(html.includes('✓'), 'ready indicator');
  });

  test('local player gets (you) label', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero' }];
    const html = buildPlayerStatusHtml(players, 'p1');
    assert.ok(html.includes('Alice (you)'), 'local player should have (you) suffix');
  });

  test('hero faction gets hero CSS class', () => {
    const players = [{ playerId: 'p1', name: 'Alice', faction: 'hero' }];
    const html = buildPlayerStatusHtml(players, null);
    assert.ok(html.includes('faction-hero'), 'hero gets faction-hero class');
    assert.ok(html.includes('⚔'), 'hero glyph');
  });

  test('witch faction gets witch CSS class', () => {
    const players = [{ playerId: 'p1', name: 'Bob', faction: 'witch' }];
    const html = buildPlayerStatusHtml(players, null);
    assert.ok(html.includes('faction-witch'), 'witch gets faction-witch class');
    assert.ok(html.includes('✦'), 'witch glyph');
  });

  test('XSS chars in name are escaped', () => {
    const players = [{ playerId: 'p1', name: '<script>alert(1)</script>', faction: 'hero' }];
    const html = buildPlayerStatusHtml(players, null);
    assert.ok(!html.includes('<script>'), 'raw <script> should be escaped');
    assert.ok(html.includes('&lt;script&gt;'), 'should use HTML entities');
  });
});

// ── buildObjectivesHtml ───────────────────────────────────────────────────────

describe('buildObjectivesHtml', () => {
  const objectives = [
    { col: 3, row: 3, label: 'Node A' },
    { col: 7, row: 5, label: 'Node B' },
    { col: 5, row: 9, label: 'Node C' },
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

  test('witch sweeps all nodes → warning title', () => {
    const entities = [
      { alive: true, owner: 'witch', col: 3, row: 3 },
      { alive: true, owner: 'witch', col: 7, row: 5 },
      { alive: true, owner: 'witch', col: 5, row: 9 },
    ];
    const { title } = buildObjectivesHtml(objectives, entities, { hero: 0, witch: 0 });
    assert.ok(title.includes('Witch holds all nodes'), `expected sweep warning, got: ${title}`);
  });

  test('hero sweeps all nodes → star title', () => {
    const entities = [
      { alive: true, owner: 'hero', col: 3, row: 3 },
      { alive: true, owner: 'hero', col: 7, row: 5 },
      { alive: true, owner: 'hero', col: 5, row: 9 },
    ];
    const { title } = buildObjectivesHtml(objectives, entities, { hero: 0, witch: 0 });
    assert.ok(title.includes('Hero holds all nodes'), `expected hero sweep, got: ${title}`);
  });

  test('default title when no sweep', () => {
    const { title } = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 });
    assert.equal(title, 'Power Nodes');
  });
});
