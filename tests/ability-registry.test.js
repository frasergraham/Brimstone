// Phase 4 of the units/items/abilities refactor — ABILITIES registry
// is the runtime source of truth for passive statMods + active
// validate/execute dispatchers.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ABILITIES, SurvivorAbility } from '../src/abilities.js';
import { GameState } from '../src/game.js';
import { Entity, EntityType, createHero, createSurvivor } from '../src/entities.js';
import { executeUseAbility } from '../src/actions.js';

// Small helper — fresh empty state with a single hero on (5,5).
function _freshState() {
  const gs = new GameState(false, false);
  // Collapse to a predictable single-entity setup.
  gs.entities = [];
  const hero = createHero(5, 5);
  gs.entities.push(hero);
  gs.hero = hero;
  return { gs, hero };
}

describe('ABILITIES registry — passive statMods', () => {
  test('brawler statMods grants +1 attack', () => {
    assert.equal(ABILITIES.brawler.kind, 'passive');
    assert.equal(ABILITIES.brawler.statMods?.attack, 1);
  });

  test('sturdy statMods grants +1 defense', () => {
    assert.equal(ABILITIES.sturdy.kind, 'passive');
    assert.equal(ABILITIES.sturdy.statMods?.defense, 1);
  });

  test('other passives have no statMods (hook-driven or metadata-only)', () => {
    for (const id of ['fortify_double', 'herbalist', 'scout']) {
      assert.equal(ABILITIES[id].kind, 'passive');
      assert.equal(ABILITIES[id].statMods ?? null, null);
    }
  });
});

describe('ABILITIES registry — active dispatchers', () => {
  test('heal.execute heals the co-located leader and costs 1 action', () => {
    const { gs, hero } = _freshState();
    hero.hp = hero.maxHp - 2;
    const healer = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    healer.abilities = [SurvivorAbility.HEAL];
    gs.entities.push(healer);

    const r = ABILITIES.heal.execute(gs, healer);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1);
    assert.equal(hero.hp, hero.maxHp - 1, 'hero healed 1 HP');
  });

  test('heal.validate returns false with no leader on the hex', () => {
    const { gs } = _freshState();
    const healer = new Entity(EntityType.SURVIVOR, 'hero', 0, 0);
    healer.abilities = [SurvivorAbility.HEAL];
    gs.entities.push(healer);
    assert.equal(ABILITIES.heal.validate(gs, healer), false);
  });

  test('heal.validate returns false at full HP', () => {
    const { gs, hero } = _freshState();
    const healer = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    healer.abilities = [SurvivorAbility.HEAL];
    gs.entities.push(healer);
    // hero starts at full HP by default
    assert.equal(ABILITIES.heal.validate(gs, healer), false);
  });

  test('inspire.execute grants leader +1 attackBonus and costs 0', () => {
    const { gs, hero } = _freshState();
    hero.attackBonus = 0;
    const inspirer = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    inspirer.abilities = [SurvivorAbility.INSPIRE];
    gs.entities.push(inspirer);

    const r = ABILITIES.inspire.execute(gs, inspirer);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0);
    assert.equal(hero.attackBonus, 1);
  });

  test('rally.execute returns budgetBonus +1 and costs 0', () => {
    const { gs, hero } = _freshState();
    const rallier = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    rallier.abilities = [SurvivorAbility.RALLY];
    gs.entities.push(rallier);

    const r = ABILITIES.rally.execute(gs, rallier);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0);
    assert.equal(r.budgetBonus, 1);
  });
});

describe('executeUseAbility dispatcher', () => {
  test('routes through ABILITIES[abilityId].execute', () => {
    const { gs, hero } = _freshState();
    hero.hp = hero.maxHp - 1;
    const healer = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    healer.abilities = [SurvivorAbility.HEAL];
    gs.entities.push(healer);

    const r = executeUseAbility(gs, healer, SurvivorAbility.HEAL);
    assert.equal(r.success, true);
    assert.equal(hero.hp, hero.maxHp);
  });

  test('unknown ability id returns failure', () => {
    const { gs, hero } = _freshState();
    const e = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    e.abilities = ['not-a-real-ability'];
    gs.entities.push(e);
    const r = executeUseAbility(gs, e, 'not-a-real-ability');
    assert.equal(r.success, false);
  });

  test('missing abilityId returns failure (caller must thread it through)', () => {
    const { gs, hero } = _freshState();
    const e = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    e.abilities = [SurvivorAbility.RALLY];
    gs.entities.push(e);
    // No third arg — dispatcher must not guess; it errors so callers that
    // fail to plumb the plan-action's `ability` field get a loud signal.
    const r = executeUseAbility(gs, e);
    assert.equal(r.success, false);
  });
});

describe('multi-ability support', () => {
  test('entity carrying brawler + sturdy stacks both statMods', () => {
    const e = new Entity(EntityType.SURVIVOR, 'hero', 0, 0);
    e.attack = 1; e.defense = 1;
    e.abilities = [SurvivorAbility.BRAWLER, SurvivorAbility.STURDY];
    assert.equal(e.getAttack(),  2);
    assert.equal(e.getDefense(), 2);
  });
});
