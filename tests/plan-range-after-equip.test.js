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
import { PlanActionType, projectEquippedWeaponId, computeGhostState } from '../src/planner.js';
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

// ── The REAL UI path: equips are queued as USE_ITEM of a weapon ────────────────
//
// The action arc emits `data-action="use_item"` for weapon equips (ui.js
// _buildActionPopup), so the queued action is { type: USE_ITEM, item: <weaponId> },
// NOT EQUIP_WEAPON. The projection must treat a USE_ITEM of a weapon as the equip
// — otherwise range/guard highlights never reflect the switch in actual play even
// though the EQUIP_WEAPON-only tests above pass. (executeUseItem equips a weapon
// item at resolution, so the projection must match.)

describe('weapon equips queued as USE_ITEM (the real UI path) project too', () => {
  test('projectEquippedWeaponId: USE_ITEM of a weapon switches the projected weapon', () => {
    const plan = [{ type: PlanActionType.USE_ITEM, entityId: 'h', item: 'bow' }];
    assert.equal(projectEquippedWeaponId(plan, 'h', 'sword'), 'bow');
  });

  test('projectEquippedWeaponId: USE_ITEM of a non-weapon item leaves the weapon', () => {
    const plan = [{ type: PlanActionType.USE_ITEM, entityId: 'h', item: 'food' }];
    assert.equal(projectEquippedWeaponId(plan, 'h', 'sword'), 'sword');
  });

  test('projectEquippedWeaponId: only this unit\'s USE_ITEM equip is projected', () => {
    const plan = [{ type: PlanActionType.USE_ITEM, entityId: 'other', item: 'bow' }];
    assert.equal(projectEquippedWeaponId(plan, 'h', 'sword'), 'sword');
  });

  test('computeGhostState: a USE_ITEM weapon equip lands in the weapons map', () => {
    const state = freshState();
    const hero  = state.hero;
    hero.equipWeapon('sword'); // live: melee, range 1
    const steps = computeGhostState(state, [
      { type: PlanActionType.USE_ITEM, entityId: hero.id, item: 'bow' },
    ]);
    assert.equal(steps[steps.length - 1].weapons.get(hero.id), 'bow',
      'a USE_ITEM weapon equip must project the post-equip weapon (range highlights depend on it)');
  });

  test('end-to-end: a USE_ITEM bow equip makes a distance-2 enemy a valid target', () => {
    const state = freshState();
    state.fogOfWar = 'none';
    const hero = state.hero;
    const minion = createMinion();
    state.entities = state.entities.filter(e => e.id === hero.id);
    hero.equipWeapon('sword'); // melee, range 1
    hero.col = 5; hero.row = 5;
    minion.col = 7; minion.row = 5; // distance 2
    state.entities.push(minion);

    const plan = [{ type: PlanActionType.USE_ITEM, entityId: hero.id, item: 'bow' }];
    const projected = applyProjectedEquip(hero, projectEquippedWeaponId(
      plan, hero.id, hero.getEquippedWeaponId()));
    const battle = getValidActions(state, projected).find(a => a.type === ActionType.BATTLE);
    assert.ok(battle?.targets.some(t => t.id === minion.id),
      'after a queued USE_ITEM bow equip the distance-2 minion must become attackable');
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
    // freshState() generates a fresh random map (Date.now() seed), so the tile
    // between the two hand-placed units varies run to run. With fog on, BATTLE
    // targets are gated by line-of-sight, so a forest/building on the
    // intervening hex would intermittently hide the witch and flake the
    // assertion. This test is about weapon-RANGE projection, not fog — pin fog
    // off so visibility never gates the result.
    state.fogOfWar = 'none';
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
    // Pin fog off so line-of-sight over the (random-map) intervening hex never
    // gates the distance-2 BATTLE target — see the sibling test above.
    state.fogOfWar = 'none';
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

// ── Revert: clearing the queued equip restores the live weapon for highlights ───
//
// The complement of the "add an equip" cases above: when the user UNDOES the
// queued EQUIP_WEAPON, the projected weapon (and thus the highlighted range)
// must fall back to the unit's previously-equipped LIVE weapon. The projection
// is seeded from the live weapon and only LAYERS queued equips, so dropping the
// equip action is exactly what reverts it.

describe('removing a queued EQUIP_WEAPON reverts the projected weapon to the live one', () => {
  test('projectEquippedWeaponId: empty plan keeps the live weapon, equip layers over it', () => {
    const live  = 'bow';   // W_live: ranged, the unit's currently-equipped weapon
    const melee = 'sword'; // W_melee queued by the equip action
    const equipAction = { type: PlanActionType.EQUIP_WEAPON, entityId: 'h', weapon: melee };

    // With the equip queued the projection is the melee weapon …
    assert.equal(projectEquippedWeaponId([equipAction], 'h', live), melee);
    // … and with the equip removed (empty plan) it reverts to the live weapon.
    assert.equal(projectEquippedWeaponId([], 'h', live), live,
      'clearing the queued equip must revert the projection to the live weapon');
  });

  test('computeGhostState: dropping the EQUIP_WEAPON reverts weapons map to the live weapon', () => {
    const state = freshState();
    const hero  = state.hero;
    hero.equipWeapon('bow'); // W_live: ranged, range 3
    assert.equal(hero.getEquippedWeaponId(), 'bow');

    // Plan WITH the equip → last step projects the post-equip melee weapon.
    const withEquip = computeGhostState(state, [
      { type: PlanActionType.EQUIP_WEAPON, entityId: hero.id, weapon: 'sword' },
    ]);
    const lastWithEquip = withEquip[withEquip.length - 1];
    assert.equal(lastWithEquip.weapons.get(hero.id), 'sword',
      'with the equip queued the projected weapon is the post-equip melee weapon');

    // Plan with the equip REMOVED (a non-equip step remains so a step is emitted)
    // → the weapons map reverts to the unit's live equipped weapon.
    const withoutEquip = computeGhostState(state, [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: hero.col + 1, toRow: hero.row },
    ]);
    const lastWithoutEquip = withoutEquip[withoutEquip.length - 1];
    assert.equal(lastWithoutEquip.weapons.get(hero.id), 'bow',
      'after the queued equip is cleared the projected weapon reverts to the live weapon');
  });

  test('computeGhostState: re-adding the live weapon after a switch is a no-op revert', () => {
    const state = freshState();
    const hero  = state.hero;
    hero.equipWeapon('bow'); // W_live

    // Switch to sword then switch back to bow: net projection is the live weapon.
    const roundTrip = computeGhostState(state, [
      { type: PlanActionType.EQUIP_WEAPON, entityId: hero.id, weapon: 'sword' },
      { type: PlanActionType.EQUIP_WEAPON, entityId: hero.id, weapon: 'bow' },
    ]);
    const last = roundTrip[roundTrip.length - 1];
    assert.equal(last.weapons.get(hero.id), 'bow',
      'switching back to the live weapon must leave the projection at the live weapon');
  });
});
