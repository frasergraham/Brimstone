// Tests for the unit info cards — per-unit planning info painted into the
// unit icon billboard by the 3D renderer (odds in the left margin, planned-
// attack marker in the right margin).
//
// Covers the pure helper _computeUnitInfoCards() and the publish path:
//   - one card per attackable enemy with hit/crush odds from computeCombatOdds
//   - defenders sharing a hex each get their OWN odds (per entity, not per hex)
//   - queued BATTLE_UNIT attacks put attackCount on the target's card,
//     independent of the current selection
//   - inactive outside plan mode / after submit / without a friendly selection
//   - _pushUnitInfoCards publishes the map onto renderer.unitInfoCards
//
// No real DOM — UIController is instantiated with the injected elements bag.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';

const { fakeCanvas } = installGlobalMocks();

let UIController, GameState, ActionType, PlanActionType,
  computeCombatOdds, createHero, createMinion, createIronGolem,
  applyProjectedEquip;

before(async () => {
  const [uiMod, gameMod, actionsMod, plannerMod, entMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
    import('../../src/actions.js'),
    import('../../src/planner.js'),
    import('../../src/entities.js'),
  ]);
  UIController      = uiMod.UIController;
  GameState         = gameMod.GameState;
  ActionType        = actionsMod.ActionType;
  PlanActionType    = plannerMod.PlanActionType;
  computeCombatOdds = actionsMod.computeCombatOdds;
  createHero        = entMod.createHero;
  createMinion      = entMod.createMinion;
  createIronGolem   = entMod.createIronGolem;
  applyProjectedEquip = entMod.applyProjectedEquip;
});

function makeUI() {
  const state    = new GameState(true, false);
  state.fogOfWar = 'none';
  const renderer = makeFakeRenderer();
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, createElementsBag({}));
  ui.enterPlanningMode('hero', 5);
  return { ui, state, renderer };
}

/** Select `actor` and mark `targets` as attackable (the red overlay set). */
function arm(ui, actor, targets) {
  ui._selectedEntity   = actor;
  ui._isEnemySelection = false;
  ui._awaitingTarget   = null;
  ui._validActions     = [{ type: ActionType.BATTLE, targets }];
}

describe('_computeUnitInfoCards — odds', () => {
  test('one card per attackable enemy with rounded odds percentages', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    const cards = ui._computeUnitInfoCards();
    assert.equal(cards.size, 1);
    const card = cards.get(minion.id);
    const expected = computeCombatOdds(state, hero, minion);
    assert.equal(card.hitPct,   Math.round(expected.hit * 100));
    assert.equal(card.crushPct, Math.round(expected.crush * 100));
    assert.equal(card.attackCount, 0);
  });

  test('defenders sharing a hex each get their own card and odds', () => {
    const { ui, state } = makeUI();
    const hero  = createHero(3, 3, 'p1', state);
    const weak  = createMinion(3, 4, 'p2', state);
    const tough = createIronGolem(3, 4, 'p2', state);
    state.entities.push(hero, weak, tough);
    arm(ui, hero, [weak, tough]);

    const cards = ui._computeUnitInfoCards();
    assert.equal(cards.size, 2, 'per-entity cards, even on a shared hex');
    assert.ok(cards.get(weak.id).hitPct > cards.get(tough.id).hitPct,
      'the softer target must show better odds');
  });

  test('inactive outside plan mode, after submit, and for enemy selections', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    ui._planMode = false;
    assert.equal(ui._computeUnitInfoCards().size, 0);
    ui._planMode = true;

    ui._planSubmitted = true;
    assert.equal(ui._computeUnitInfoCards().size, 0);
    ui._planSubmitted = false;

    ui._isEnemySelection = true;
    assert.equal(ui._computeUnitInfoCards().size, 0);
    ui._isEnemySelection = false;

    ui._selectedEntity = null;
    assert.equal(ui._computeUnitInfoCards().size, 0);
  });

  test('no odds while targeting a non-battle action (e.g. Attack Hex)', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);
    ui._awaitingTarget = { actionType: ActionType.BATTLE_HEX, actor: hero };
    assert.equal(ui._computeUnitInfoCards().size, 0);
  });
});

describe('_computeUnitInfoCards — planned-attack counts', () => {
  test('queued BATTLE_UNIT attacks count on the target card without a selection', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    ui._selectedEntity = null;  // counts are selection-independent

    ui._unitPlans.set(hero.id, [
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
    ]);

    const card = ui._computeUnitInfoCards().get(minion.id);
    assert.equal(card.attackCount, 2);
    assert.equal(card.hitPct, null, 'no odds without a selected attacker');
  });

  test('selection odds and plan counts merge onto one card', () => {
    const { ui, state } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);
    ui._unitPlans.set(hero.id, [
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
    ]);

    const card = ui._computeUnitInfoCards().get(minion.id);
    assert.equal(card.attackCount, 1);
    assert.ok(Number.isFinite(card.hitPct));
  });

  test('BATTLE_HEX actions do not produce cards (per-hex fallback badge)', () => {
    const { ui, state } = makeUI();
    const hero = createHero(3, 3, 'p1', state);
    state.entities.push(hero);
    ui._unitPlans.set(hero.id, [
      { type: PlanActionType.BATTLE_HEX, entityId: hero.id, targetCol: 3, targetRow: 4 },
    ]);
    assert.equal(ui._computeUnitInfoCards().size, 0);
  });
});

describe('_pushUnitInfoCards', () => {
  test('publishes the map onto renderer.unitInfoCards', () => {
    const { ui, state, renderer } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    ui._pushUnitInfoCards();
    assert.ok(renderer.unitInfoCards instanceof Map);
    assert.equal(renderer.unitInfoCards.size, 1);
    assert.ok(renderer.unitInfoCards.has(minion.id));

    ui.markPlanSubmitted();
    assert.equal(renderer.unitInfoCards.size, 0, 'submit clears the cards');
  });

  test('deselecting republishes — odds vanish, planned-attack markers stay', () => {
    const { ui, state, renderer } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    const marked = createMinion(5, 5, 'p2', state);
    state.entities.push(hero, minion, marked);
    arm(ui, hero, [minion]);
    ui._unitPlans.set(hero.id, [
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: marked.id },
    ]);
    ui._pushUnitInfoCards();
    assert.ok(renderer.unitInfoCards.has(minion.id), 'odds card present while selected');

    ui._clearSelection();
    assert.ok(!renderer.unitInfoCards.has(minion.id),
      'odds must clear when the unit is deselected');
    assert.equal(renderer.unitInfoCards.get(marked.id)?.attackCount, 1,
      'planned-attack marker survives deselection');
  });
});

describe('_computeUnitInfoCards — projected range gating', () => {
  test('a queued move out of range hides the odds', () => {
    const { ui, state, renderer } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    // Plan leaves the hero far from the target (ghost projection).
    renderer.planGhostSteps = [{ positions: new Map([[hero.id, { col: 7, row: 7 }]]), action: {} }];
    assert.equal(ui._computeUnitInfoCards().size, 0,
      'odds must vanish when the plan ends out of attack range');

    // Plan ends back in range → odds return.
    renderer.planGhostSteps = [{ positions: new Map([[hero.id, { col: 3, row: 3 }]]), action: {} }];
    assert.equal(ui._computeUnitInfoCards().size, 1);
  });

  test('ranged units keep odds at their weapon range', () => {
    const { ui, state, renderer } = makeUI();
    const hero   = createHero(3, 1, 'p1', state);
    hero.equipWeapon('bow');  // range 3
    const minion = createMinion(3, 4, 'p2', state);
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    renderer.planGhostSteps = null;
    assert.equal(ui._computeUnitInfoCards().size, 1,
      'distance 3 is in range for a bow');
  });

  test('a queued ranged→melee equip removes the now-out-of-range odds card', () => {
    const { ui, state, renderer } = makeUI();
    const hero   = createHero(3, 1, 'p1', state);
    hero.equipWeapon('bow');                 // live weapon: range 3
    const minion = createMinion(3, 4, 'p2', state); // distance 3 — in bow range
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    // No equip queued → bow range covers the distance-3 target.
    renderer.planGhostSteps = [{
      positions: new Map([[hero.id, { col: 3, row: 1 }]]),
      weapons:   new Map([[hero.id, 'bow']]),
      action: {},
    }];
    assert.equal(ui._computeUnitInfoCards().size, 1,
      'with a bow the distance-3 target keeps its odds');

    // Queue a melee switch → projected range is 1, so the distance-3 target
    // drops out of range and its odds card must disappear.
    renderer.planGhostSteps = [{
      positions: new Map([[hero.id, { col: 3, row: 1 }]]),
      weapons:   new Map([[hero.id, 'sword']]),
      action: {},
    }];
    assert.equal(ui._computeUnitInfoCards().size, 0,
      'after a queued switch to a melee sword the distance-3 odds must vanish');
  });

  test('a queued melee→ranged equip surfaces an odds card the live weapon could not reach', () => {
    const { ui, state, renderer } = makeUI();
    const hero   = createHero(3, 1, 'p1', state);
    hero.equipWeapon('sword');               // live weapon: range 1
    const minion = createMinion(3, 4, 'p2', state); // distance 3
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    // Queue a bow switch → projected range 3 reaches the distance-3 target.
    renderer.planGhostSteps = [{
      positions: new Map([[hero.id, { col: 3, row: 1 }]]),
      weapons:   new Map([[hero.id, 'bow']]),
      action: {},
    }];
    assert.equal(ui._computeUnitInfoCards().size, 1,
      'after a queued switch to a bow the distance-3 target gains an odds card');
  });

  // Load-bearing for the _attackOdds weapon-projection fix: the range FILTER
  // and the odds VALUE must both read the projected weapon. Before the fix
  // _attackOdds re-projected only position, so a queued bow→sword switch
  // surfaced the adjacent target (range fix) but still printed the BOW's
  // 0-attack ranged odds instead of the SWORD's melee odds.
  test('a queued ranged→melee equip changes the card odds VALUE to the projected weapon', () => {
    const { ui, state, renderer } = makeUI();
    const hero   = createHero(3, 3, 'p1', state);
    hero.equipWeapon('bow');                          // live: ranged, +0 ATK, no crush
    const minion = createMinion(3, 4, 'p2', state);   // distance 1 — both weapons reach
    state.entities.push(hero, minion);
    arm(ui, hero, [minion]);

    // Same hex for both reads → identical terrain/phase, so any odds delta is
    // purely the weapon swap (deterministic regardless of procedural terrain).
    renderer.planGhostSteps = [{
      positions: new Map([[hero.id, { col: 3, row: 3 }]]),
      weapons:   new Map([[hero.id, 'sword']]),       // queued melee switch
      action: {},
    }];

    const card = ui._computeUnitInfoCards().get(minion.id);
    assert.ok(card, 'an adjacent target keeps its card under either weapon');

    // What the SWORD (projected) and BOW (live) would each show, on this state.
    const swordOdds = computeCombatOdds(state, applyProjectedEquip(hero, 'sword'), minion);
    const liveBowOdds = computeCombatOdds(state, hero, minion);

    // The card must reflect the PROJECTED sword, not the live bow.
    assert.equal(card.hitPct,   Math.round(swordOdds.hit * 100),
      'card hit% must match the projected sword, not the live bow');
    assert.equal(card.crushPct, Math.round(swordOdds.crush * 100),
      'card crush% must match the projected sword, not the live bow');

    // And the two weapons genuinely differ — proving the value is load-bearing.
    // Bow is ranged (no crush, +0 ATK); sword is melee (+2 ATK, crush possible).
    assert.ok(
      Math.round(swordOdds.hit * 100) !== Math.round(liveBowOdds.hit * 100) ||
      Math.round(swordOdds.crush * 100) !== Math.round(liveBowOdds.crush * 100),
      'sword and bow odds must differ so the assertion can catch the live-weapon bug',
    );
  });
});
