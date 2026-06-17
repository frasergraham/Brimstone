// Tests for plan-mode range projection through a queued EQUIP_WEAPON action.
//
// Bug: in plan mode the guard-area / attack-target highlights used the unit's
// CURRENT equipped weapon range instead of the range it will have AFTER a queued
// equip switch. The fix projects the equipped weapon through the plan (analogous
// to how position is projected through queued MOVEs) so range-driven highlights
// reflect the post-equip weapon.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import { getValidActions, ActionType } from '../src/actions.js';
import { EntityType, createMinion, rangeOf, applyProjectedEquip } from '../src/entities.js';
import { PlanActionType, projectEquippedWeaponId } from '../src/planner.js';
import { hexDistance } from '../src/hex.js';

function freshState() {
  return new GameState(true, true);
}

// ── projectEquippedWeaponId: pure plan projection ──────────────────────────────

describe('projectEquippedWeaponId projects the queued weapon switch', () => {
  test('no equip queued → keeps the current weapon', () => {
    const plan = [
      { type: PlanActionType.MOVE, entityId: 'h', toCol: 1, toRow: 1 },
    ];
    assert.equal(projectEquippedWeaponId(plan, 'h', 'sword'), 'sword');
  });

  test('queued ranged→melee equip → projects to melee weapon', () => {
    const plan = [
      { type: PlanActionType.EQUIP_WEAPON, entityId: 'h', weapon: 'sword' },
    ];
    assert.equal(projectEquippedWeaponId(plan, 'h', 'bow'), 'sword');
  });

  test('queued melee→ranged equip → projects to ranged weapon', () => {
    const plan = [
      { type: PlanActionType.EQUIP_WEAPON, entityId: 'h', weapon: 'bow' },
    ];
    assert.equal(projectEquippedWeaponId(plan, 'h', 'sword'), 'bow');
  });

  test('last EQUIP_WEAPON wins when several are queued', () => {
    const plan = [
      { type: PlanActionType.EQUIP_WEAPON, entityId: 'h', weapon: 'bow' },
      { type: PlanActionType.EQUIP_WEAPON, entityId: 'h', weapon: 'sword' },
    ];
    assert.equal(projectEquippedWeaponId(plan, 'h', 'bow'), 'sword');
  });

  test('only this unit\'s equip is projected, not another unit\'s', () => {
    const plan = [
      { type: PlanActionType.EQUIP_WEAPON, entityId: 'other', weapon: 'bow' },
    ];
    assert.equal(projectEquippedWeaponId(plan, 'h', 'sword'), 'sword');
  });
});

// ── applyProjectedEquip: build a highlight-source entity with the projected weapon

describe('applyProjectedEquip yields an entity whose range reflects the projection', () => {
  test('melee→ranged grows the range used for highlights', () => {
    const state = freshState();
    const hero  = state.hero;
    hero.equipWeapon('sword');                 // current: melee, range 1
    assert.equal(rangeOf(hero), 1);

    const eff = applyProjectedEquip(hero, 'bow'); // projected: ranged, range 3
    assert.equal(rangeOf(eff), 3, 'projected entity should report bow range');
    // The original entity is untouched.
    assert.equal(rangeOf(hero), 1, 'original entity must not be mutated');
  });

  test('ranged→melee shrinks the range used for highlights', () => {
    const state = freshState();
    const hero  = state.hero;
    hero.equipWeapon('bow');                    // current: ranged, range 3
    assert.equal(rangeOf(hero), 3);

    const eff = applyProjectedEquip(hero, 'sword'); // projected: melee, range 1
    assert.equal(rangeOf(eff), 1, 'projected entity should report sword range');
    assert.equal(rangeOf(hero), 3, 'original entity must not be mutated');
  });

  test('null projection (no equip queued) returns an equivalent-range entity', () => {
    const state = freshState();
    const hero  = state.hero;
    hero.equipWeapon('bow');
    const eff = applyProjectedEquip(hero, null);
    assert.equal(rangeOf(eff), rangeOf(hero));
  });
});

// ── End-to-end: getValidActions on the projected entity highlights the right hexes

describe('getValidActions reflects the projected weapon range for plan highlights', () => {
  test('ranged→melee: a far enemy in bow range is NOT a melee target after equip', () => {
    const state = freshState();
    const hero  = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);

    // Strip other entities that could be adjacent and muddy the assertion.
    state.entities = state.entities.filter(
      e => e.id === hero.id || e.id === witch.id
    );

    hero.equipWeapon('bow'); // range 3
    hero.col = 5; hero.row = 5;
    // Place the witch 2 hexes east — inside bow range (3), outside melee range (1).
    witch.col = 7; witch.row = 5;
    assert.equal(hexDistance(hero.col, hero.row, witch.col, witch.row), 2);

    // Current weapon (bow): the far witch is a valid BATTLE target.
    const beforeBattle = getValidActions(state, hero).find(a => a.type === ActionType.BATTLE);
    assert.ok(beforeBattle?.targets.some(t => t.id === witch.id),
      'with bow equipped the distance-2 witch should be attackable');

    // Plan queues a switch to a melee sword. The highlight source entity must
    // reflect the post-equip (melee, range 1) weapon.
    const projected = applyProjectedEquip(hero, projectEquippedWeaponId(
      [{ type: PlanActionType.EQUIP_WEAPON, entityId: hero.id, weapon: 'sword' }],
      hero.id,
      hero.getEquippedWeaponId(),
    ));
    const afterBattle = getValidActions(state, projected).find(a => a.type === ActionType.BATTLE);
    assert.ok(
      !afterBattle || !afterBattle.targets.some(t => t.id === witch.id),
      'after a queued switch to a melee sword the distance-2 witch must NOT be a melee target',
    );
  });

  test('melee→ranged: a far enemy out of melee range BECOMES a target after equip', () => {
    const state = freshState();
    const hero  = state.hero;

    // Use a controllable enemy minion placed 2 hexes away.
    const minion = createMinion();
    state.entities = state.entities.filter(e => e.id === hero.id);
    hero.equipWeapon('sword'); // melee, range 1
    hero.col = 5; hero.row = 5;
    minion.col = 7; minion.row = 5; // distance 2
    state.entities.push(minion);
    assert.equal(hexDistance(hero.col, hero.row, minion.col, minion.row), 2);

    // Current weapon (sword): the distance-2 minion is NOT attackable.
    const beforeBattle = getValidActions(state, hero).find(a => a.type === ActionType.BATTLE);
    assert.ok(
      !beforeBattle || !beforeBattle.targets.some(t => t.id === minion.id),
      'with a sword the distance-2 minion should not be attackable',
    );

    // Queue a switch to a bow (range 3). The projected entity should now reach it.
    const projected = applyProjectedEquip(hero, projectEquippedWeaponId(
      [{ type: PlanActionType.EQUIP_WEAPON, entityId: hero.id, weapon: 'bow' }],
      hero.id,
      hero.getEquippedWeaponId(),
    ));
    const afterBattle = getValidActions(state, projected).find(a => a.type === ActionType.BATTLE);
    assert.ok(afterBattle?.targets.some(t => t.id === minion.id),
      'after a queued switch to a bow the distance-2 minion must become attackable');
  });
});
