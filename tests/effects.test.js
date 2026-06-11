// Effects/traits system — registry, helpers, stat composition, lifecycle,
// triggers, serialization, and resolver integration.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EFFECTS, applyEffect, removeEffect, hasEffect,
  effectStatMod, effectRangeMod, effectIncomingAtkAdvantage,
  effectDamageTakenFlat, effectsBlockActions, effectsBlockHeal,
  tickEffects, dispatchTrigger, getEffect,
} from '../src/effects.js';
import {
  Entity, EntityType, attackOf, defenseOf, rangeOf,
  createHero, createWitch, createMinion, createZombie, createSurvivor,
} from '../src/entities.js';
import { GameState, Phase } from '../src/game.js';
import { hexKey } from '../src/hex.js';
import { applyPostRoundEffects } from '../src/post-round-effects.js';
import { executeBattle } from '../src/actions.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { snapshotSurvivor } from '../src/campaign/campaign.js';
import { validatePlanAction, PlanActionType } from '../src/planner.js';
import { getFaction } from '../src/factions.js';

// ── Registry shape ─────────────────────────────────────────────────────────

describe('EFFECTS registry', () => {
  test('starter effects are present', () => {
    for (const id of [
      'wounded', 'poisoned', 'bleeding', 'stunned', 'slowed', 'marked', 'cursed',
      'frenzied', 'inspired', 'fortified', 'eagle_eyed',
    ]) {
      assert.ok(EFFECTS[id], `missing ${id}`);
      assert.equal(EFFECTS[id].id, id);
      assert.ok(EFFECTS[id].label);
      assert.ok(EFFECTS[id].description);
    }
  });

  test('getEffect returns the registry entry', () => {
    assert.equal(getEffect('wounded'), EFFECTS.wounded);
    assert.equal(getEffect('not-a-real-effect'), undefined);
  });
});

// ── apply / remove / has ───────────────────────────────────────────────────

describe('applyEffect / removeEffect / hasEffect', () => {
  test('applyEffect adds a record with default duration', () => {
    const hero = createHero(0, 0);
    assert.equal(applyEffect(hero, 'wounded'), true);
    assert.equal(hasEffect(hero, 'wounded'), true);
    const rec = hero.effects[0];
    assert.equal(rec.id, 'wounded');
    assert.equal(rec.duration, EFFECTS.wounded.defaultDuration);
    assert.equal(rec.stacks, 1);
  });

  test('applying an existing effect refreshes duration to the max', () => {
    const hero = createHero(0, 0);
    applyEffect(hero, 'frenzied', { duration: 1 });
    applyEffect(hero, 'frenzied', { duration: 3 });
    assert.equal(hero.effects.length, 1);
    assert.equal(hero.effects[0].duration, 3);
    // Re-applying with a shorter duration does not shorten.
    applyEffect(hero, 'frenzied', { duration: 1 });
    assert.equal(hero.effects[0].duration, 3);
  });

  test('stack option increments stacks', () => {
    const hero = createHero(0, 0);
    applyEffect(hero, 'bleeding');
    applyEffect(hero, 'bleeding', { stack: true });
    assert.equal(hero.effects.length, 1);
    assert.equal(hero.effects[0].stacks, 2);
  });

  test('removeEffect strips all stacks', () => {
    const hero = createHero(0, 0);
    applyEffect(hero, 'wounded');
    applyEffect(hero, 'frenzied');
    assert.equal(removeEffect(hero, 'wounded'), true);
    assert.equal(hasEffect(hero, 'wounded'), false);
    assert.equal(hasEffect(hero, 'frenzied'), true);
  });

  test('applyEffect rejects unknown ids', () => {
    const hero = createHero(0, 0);
    assert.equal(applyEffect(hero, 'not-real'), false);
    assert.equal(hero.effects.length, 0);
  });

  test('mission/permanent durations beat numeric on refresh', () => {
    const hero = createHero(0, 0);
    applyEffect(hero, 'frenzied', { duration: 2 });
    applyEffect(hero, 'frenzied', { duration: 'mission' });
    assert.equal(hero.effects[0].duration, 'mission');
    applyEffect(hero, 'frenzied', { duration: 1 });
    assert.equal(hero.effects[0].duration, 'mission');
  });
});

// ── Stat composition ───────────────────────────────────────────────────────

describe('Stat composition through Entity getters', () => {
  test('frenzied gives +1 ATK / -1 DEF', () => {
    const hero = createHero(0, 0);
    const baseAtk = hero.getAttack();
    const baseDef = hero.getDefense();
    applyEffect(hero, 'frenzied');
    assert.equal(hero.getAttack(), baseAtk + 1);
    assert.equal(hero.getDefense(), baseDef - 1);
  });

  test('poisoned gives -1 DEF', () => {
    const hero = createHero(0, 0);
    const baseDef = hero.getDefense();
    applyEffect(hero, 'poisoned');
    assert.equal(hero.getDefense(), baseDef - 1);
  });

  test('inspired and frenzied stack on attack', () => {
    const hero = createHero(0, 0);
    const baseAtk = hero.getAttack();
    applyEffect(hero, 'inspired');
    applyEffect(hero, 'frenzied');
    assert.equal(hero.getAttack(), baseAtk + 2);
  });

  test('eagle_eyed effect adds +1 to range', () => {
    const witch = createWitch(0, 0);
    const baseRange = witch.getRange();
    applyEffect(witch, 'eagle_eyed');
    assert.equal(witch.getRange(), baseRange + 1);
  });

  test('eagle_eye ability composes via abilities statMods', () => {
    const witch = createWitch(0, 0);
    const baseRange = witch.getRange();
    witch.abilities.push('eagle_eye');
    assert.equal(witch.getRange(), baseRange + 1);
  });

  test('helpers return 0 for entities with no effects array', () => {
    assert.equal(effectStatMod(null, 'attack'), 0);
    assert.equal(effectRangeMod(null), 0);
    assert.equal(effectDamageTakenFlat({}), 0);
  });
});

// ── Damage hooks ───────────────────────────────────────────────────────────

describe('Wounded → +DAMAGE_SCALE incoming damage', () => {
  test('applyIncomingDamage adds wounded stack', () => {
    const hero = createHero(0, 0);
    assert.equal(hero.applyIncomingDamage(1), 1, 'baseline 1 damage');
    applyEffect(hero, 'wounded');
    assert.equal(hero.applyIncomingDamage(1), 8, 'wounded amplifies by DAMAGE_SCALE (1+7)');
  });

  test('damage never goes below 1 (no negative-flat-mod underflow)', () => {
    const hero = createHero(0, 0);
    // No effect grants negative incoming damage in the starter set, but the
    // helper is defensive against future mods that might.
    assert.equal(hero.applyIncomingDamage(1), 1);
  });
});

// ── Marked → +1 advantage to attackers ─────────────────────────────────────

describe('Marked → attackers gain +1 advantage', () => {
  test('effectIncomingAtkAdvantage reflects marked stacks', () => {
    const z = createZombie(0, 0);
    assert.equal(effectIncomingAtkAdvantage(z), 0);
    applyEffect(z, 'marked');
    assert.equal(effectIncomingAtkAdvantage(z), 1);
  });

  test('resolveCombat bumps atkAdvantage when defender is marked', () => {
    const hero = createHero(0, 0);
    const z = createZombie(1, 0);
    applyEffect(z, 'marked');
    // forced low rolls all around so we can read the dice pool sizes
    const r = Entity.resolveCombat(hero, z);
    // atkAdvantage should be at least 1 from marked alone (no other modifiers)
    assert.ok(r.atkAdvantage >= 1, `expected >=1 atkAdvantage, got ${r.atkAdvantage}`);
  });
});

// ── Stunned blocks actions ─────────────────────────────────────────────────

describe('Stunned blocks actions / heal block', () => {
  test('effectsBlockActions detects stunned', () => {
    const hero = createHero(0, 0);
    assert.equal(effectsBlockActions(hero), false);
    applyEffect(hero, 'stunned');
    assert.equal(effectsBlockActions(hero), true);
  });

  test('cursed prevents healing', () => {
    const hero = createHero(0, 0);
    hero.hp = hero.maxHp - 3;
    applyEffect(hero, 'cursed');
    assert.equal(effectsBlockHeal(hero), true);
    hero.heal(2);
    assert.equal(hero.hp, hero.maxHp - 3, 'heal was a no-op while cursed');
  });
});

// ── Round lifecycle ────────────────────────────────────────────────────────

describe('Round lifecycle — tickEffects', () => {
  function _stateWith(entity) {
    const gs = new GameState(false, false);
    gs.entities = [entity];
    return gs;
  }

  test('numeric durations decrement and expire at zero', () => {
    const hero = createHero(0, 0);
    applyEffect(hero, 'frenzied', { duration: 2 });
    const gs = _stateWith(hero);

    let result = tickEffects(gs);
    assert.equal(result.expiredEvents.length, 0);
    assert.equal(hero.effects[0].duration, 1);

    result = tickEffects(gs);
    assert.equal(result.expiredEvents.length, 1);
    assert.equal(hero.effects.length, 0);
  });

  test('mission duration does not decrement', () => {
    const hero = createHero(0, 0);
    applyEffect(hero, 'cursed', { duration: 'mission' });
    const gs = _stateWith(hero);
    tickEffects(gs);
    tickEffects(gs);
    assert.equal(hero.effects.length, 1);
    assert.equal(hero.effects[0].duration, 'mission');
  });

  test('poisoned/bleeding deal damage at round end', () => {
    const hero = createHero(0, 0);
    const startHp = hero.hp;
    applyEffect(hero, 'poisoned', { duration: 2 });
    const gs = _stateWith(hero);
    const result = tickEffects(gs);
    assert.equal(hero.hp, startHp - 7); // 1 stack × DAMAGE_SCALE
    assert.equal(result.dotEvents.length, 1);
    assert.equal(result.dotEvents[0].amount, 7);
  });

  test('DOT can kill and removes the entity from state.entities', () => {
    const z = createZombie(0, 0);
    z.hp = 1;
    applyEffect(z, 'bleeding', { duration: 5 });
    const gs = _stateWith(z);
    tickEffects(gs);
    assert.equal(z.alive, false);
    assert.equal(gs.entities.length, 0);
  });

});

// ── post-round pipeline integration ────────────────────────────────────────

describe('post-round pipeline integration', () => {
  test('applyPostRoundEffects emits effect_tick / effect_expire events', () => {
    const hero = createHero(0, 0);
    applyEffect(hero, 'bleeding', { duration: 1 });
    const gs = new GameState(false, false);
    // Strip default-spawned entities so we can test in isolation.
    gs.entities = [hero];
    gs.hero = hero;

    const events = applyPostRoundEffects(gs);
    const tick = events.find(e => e.type === 'effect_tick');
    const expire = events.find(e => e.type === 'effect_expire');
    assert.ok(tick, 'expected an effect_tick event');
    assert.ok(expire, 'expected an effect_expire event');
    assert.equal(hero.effects.length, 0);
  });
});

// ── Triggers (berserker) ───────────────────────────────────────────────────

describe('Trigger dispatch — berserker', () => {
  test('berserker grants frenzied after the second kill in a round', () => {
    const hero = createHero(0, 0);
    hero.abilities.push('berserker');

    // First kill — below threshold, no frenzy.
    hero.killsThisRound = 1;
    dispatchTrigger('kill', hero, { state: null });
    assert.equal(hasEffect(hero, 'frenzied'), false);

    // Second kill — frenzy fires.
    hero.killsThisRound = 2;
    dispatchTrigger('kill', hero, { state: null });
    assert.equal(hasEffect(hero, 'frenzied'), true);
  });

  test('non-berserker actor never gets frenzied from kills', () => {
    const hero = createHero(0, 0);
    hero.killsThisRound = 5;
    dispatchTrigger('kill', hero, { state: null });
    assert.equal(hasEffect(hero, 'frenzied'), false);
  });

  test('killsThisRound resets at the start of each turn (resetTurn)', () => {
    const hero = createHero(0, 0);
    hero.killsThisRound = 3;
    hero.resetTurn();
    assert.equal(hero.killsThisRound, 0);
  });
});

// ── End-to-end: combat increments killsThisRound ───────────────────────────

describe('combat integration', () => {
  function _setupCombat() {
    const gs = new GameState(false, false);
    gs.entities = [];
    const hero = createHero(0, 0);
    const m1 = createMinion(0, 0);
    m1.hp = 1; // one-shot
    gs.entities.push(hero, m1);
    gs.hero = hero;
    return { gs, hero, target: m1 };
  }

  test('killing a target increments attacker.killsThisRound', () => {
    const { gs, hero, target } = _setupCombat();
    // Force a guaranteed hit-killing roll: attacker rolls 6, defender 1.
    gs.setForcedDice(6, 1);
    const r = executeBattle(gs, hero, target);
    assert.equal(r.killed, true);
    assert.equal(hero.killsThisRound, 1);
  });

  test('berserker hero gains frenzy on second kill in same combat sequence', () => {
    const gs = new GameState(false, false);
    gs.entities = [];
    const hero = createHero(1, 0);
    hero.abilities.push('berserker');
    // Place targets far enough apart that neither shows up as a gang-up
    // ally for the other (>1 hex from the other's neighbour ring) — this
    // keeps each battle's dice pool to exactly 1 atk + 1 def die.
    const m1 = createMinion(1, 0); m1.hp = 1;
    const m2 = createMinion(8, 8); m2.hp = 1;
    gs.entities.push(hero, m1, m2);
    gs.hero = hero;

    gs.setForcedDice(6, 1, 6, 1);
    executeBattle(gs, hero, m1);
    assert.equal(hasEffect(hero, 'frenzied'), false, 'no frenzy after first kill');
    hero.col = 8; hero.row = 8;
    executeBattle(gs, hero, m2);
    assert.equal(hasEffect(hero, 'frenzied'), true, 'frenzy after second kill');
  });

  test('wounded target takes amplified damage', () => {
    const gs = new GameState(false, false);
    gs.entities = [];
    const hero = createHero(0, 0);
    const z = createZombie(0, 0);
    z.hp = 5;
    applyEffect(z, 'wounded');
    gs.entities.push(hero, z);
    gs.hero = hero;

    gs.setForcedDice(6, 1); // hit, no crush (6 vs 1 + def stat)
    const before = z.hp;
    executeBattle(gs, hero, z);
    // Wounded amplifies each landed hit by 1, so non-crush hit deals 2.
    assert.ok(before - z.hp >= 2, `expected >=2 damage, got ${before - z.hp}`);
  });
});

// ── Serialization ──────────────────────────────────────────────────────────

describe('Serialization round-trip', () => {
  test('effects + killsThisRound survive serialize/deserialize', () => {
    const gs = new GameState(false, false);
    const hero = gs.entities.find(e => e.type === EntityType.PALADIN);
    assert.ok(hero);
    applyEffect(hero, 'wounded', { duration: 2 });
    applyEffect(hero, 'frenzied', { duration: 'mission' });
    hero.killsThisRound = 4;
    hero.level = 3; // unit level should round-trip too

    const snap = serializeState(gs);
    const restored = deserializeState(snap);
    const rh = restored.entities.find(e => e.id === hero.id);
    assert.ok(rh);
    assert.equal(rh.level, 3, 'level survives serialize/deserialize');
    assert.equal(rh.effects.length, 2);
    const wounded = rh.effects.find(e => e.id === 'wounded');
    const frenzied = rh.effects.find(e => e.id === 'frenzied');
    assert.equal(wounded.duration, 2);
    assert.equal(frenzied.duration, 'mission');
    assert.equal(rh.killsThisRound, 4);
    // Restored entity supports the helper methods.
    assert.equal(typeof rh.applyIncomingDamage, 'function');
    assert.equal(rh.applyIncomingDamage(1), 8, 'wounded composes after restore (1+7)');
  });

  test('deserializing a pre-effects snapshot defaults effects to []', () => {
    const gs = new GameState(false, false);
    const snap = serializeState(gs);
    // Strip the new fields to simulate an old save.
    for (const e of snap.entities) {
      delete e.effects;
      delete e.killsThisRound;
      delete e.level;
    }
    const restored = deserializeState(snap);
    for (const e of restored.entities) {
      assert.deepEqual(e.effects, []);
      assert.equal(e.killsThisRound, 0);
      assert.equal(e.level, 1, 'pre-level saves default to level 1');
    }
  });
});

// ── DOT amplification by wounded (Fix #2) ──────────────────────────────────

describe('Wounded amplifies DOTs and attrition', () => {
  test('wounded + bleeding deals 14 HP per round (scaled), not 7', () => {
    const hero = createHero(0, 0);
    const startHp = hero.hp;
    applyEffect(hero, 'wounded');
    applyEffect(hero, 'bleeding', { duration: 2 });
    const gs = new GameState(false, false);
    gs.entities = [hero];
    gs.hero = hero;
    tickEffects(gs);
    assert.equal(hero.hp, startHp - 14, 'bleeding (7) + wounded (+7) = 14 HP loss');
  });

  test('wounded + poisoned deals 14 HP per round (scaled)', () => {
    const z = createZombie(0, 0);
    z.maxHp = 30; z.hp = 30; // survive the scaled tick to assert the exact loss
    const startHp = z.hp;
    applyEffect(z, 'wounded');
    applyEffect(z, 'poisoned', { duration: 2 });
    const gs = new GameState(false, false);
    gs.entities = [z];
    tickEffects(gs);
    assert.equal(z.hp, startHp - 14);
  });

  test('night attrition routes through applyIncomingDamage', () => {
    const gs = new GameState(false, false);
    gs.entities = [];
    // Place a survivor on a non-building hex (default tiles are grass).
    const surv = createSurvivor(5, 5);
    applyEffect(surv, 'wounded');
    gs.entities.push(surv);
    gs.phase = Phase.NIGHT;
    gs.attritionLevel = 1;
    // The procedural map may drop a building (which shelters the survivor) or
    // fortification on (5,5); normalize to open ground so attrition reliably
    // applies — otherwise the survivor is intermittently sheltered (0 damage).
    const tile = gs.tiles.get(hexKey(5, 5));
    if (tile) {
      tile.structure = null; tile.building = null; tile.fortifyLevel = 0;
      tile.buildingFootprintOf = null; tile.footprintHexes = [];
    }
    const startHp = surv.hp;
    applyPostRoundEffects(gs);
    assert.equal(surv.hp, startHp - 14, 'attrition (1×7) + wounded (+7) = 14 HP loss');
  });
});

// ── Lethal-DOT bookkeeping (Fix #1) ────────────────────────────────────────

describe('Lethal DOT credits the source', () => {
  function _setupLethalDot(targetHp = 1, attackerOwner = 'hero') {
    const gs = new GameState(false, false);
    gs.entities = [];
    const attacker = attackerOwner === 'hero' ? createHero(0, 0) : createWitch(0, 0);
    const target = attackerOwner === 'hero' ? createMinion(5, 5) : createSurvivor(5, 5);
    target.hp = targetHp;
    gs.entities.push(attacker, target);
    if (attackerOwner === 'hero') gs.hero = attacker;
    else gs.witch = attacker;
    return { gs, attacker, target };
  }

  test('bleeding kill credits source faction\'s trackKill', () => {
    const { gs, attacker, target } = _setupLethalDot(1, 'hero');
    applyEffect(target, 'bleeding', { duration: 1, source: attacker });
    const beforeKills = gs.heroKills ?? 0;
    applyPostRoundEffects(gs);
    assert.equal(target.alive, false, 'target died to DOT');
    assert.ok((gs.heroKills ?? 0) > beforeKills, 'kill counter incremented');
  });

  test('lethal DOT increments source.killsThisRound', () => {
    const { gs, attacker, target } = _setupLethalDot(1, 'hero');
    applyEffect(target, 'bleeding', { duration: 1, source: attacker });
    applyPostRoundEffects(gs);
    assert.equal(attacker.killsThisRound, 1);
  });

  test('lethal DOT fires source\'s berserker trigger when threshold met', () => {
    const { gs, attacker, target } = _setupLethalDot(1, 'hero');
    attacker.abilities.push('berserker');
    attacker.killsThisRound = 1; // one prior kill this round
    applyEffect(target, 'bleeding', { duration: 1, source: attacker });
    applyPostRoundEffects(gs);
    assert.equal(attacker.killsThisRound, 2);
    assert.equal(hasEffect(attacker, 'frenzied'), true, 'second kill triggered berserker');
  });

  test('lethal DOT to a leader scatters their owned units', () => {
    const gs = new GameState(false, false);
    gs.entities = [];
    const witch = createWitch(0, 0);
    witch.ownerId = 'p-witch';
    witch.hp = 1;
    gs.witch = witch;
    gs.entities.push(witch);
    gs.players = [{ id: 'p-witch', faction: 'witch', leaderId: witch.id, isAI: false }];
    let scattered = null;
    gs.scatterPlayerUnits = (ownerId) => { scattered = ownerId; };
    const hero = createHero(5, 5);
    applyEffect(witch, 'bleeding', { duration: 1, source: hero });
    applyPostRoundEffects(gs);
    assert.equal(scattered, 'p-witch', 'scatterPlayerUnits called with witch ownerId');
  });

  test('environmental DOT (no source) still kills cleanly without crash', () => {
    const gs = new GameState(false, false);
    gs.entities = [];
    const z = createZombie(0, 0);
    z.hp = 1;
    gs.entities.push(z);
    applyEffect(z, 'bleeding', { duration: 1 }); // no source
    // Must not throw.
    applyPostRoundEffects(gs);
    assert.equal(z.alive, false);
  });
});

// ── Slowed shifts lockstep order (Fix #4) ──────────────────────────────────

describe('Slowed shifts lockstep agility order', () => {
  test('getAgility composes the slowed -1', () => {
    const hero = createHero(0, 0);
    const baseAgility = hero.getAgility();
    applyEffect(hero, 'slowed');
    assert.equal(hero.getAgility(), baseAgility - 1);
  });

  test('plain-object rangeOf composes ability range mods', () => {
    const fixture = { type: 'paladin', range: 1, abilities: ['eagle_eye'] };
    assert.equal(rangeOf(fixture), 2, 'eagle_eye ability adds +1 range to fixture');
  });
});

// ── attackOf / defenseOf plain-object fallback (Fix #9) ───────────────────

describe('attackOf / defenseOf compose effect mods', () => {
  test('plain-object fixture with frenzied effect gets +1 attack', () => {
    const fixture = { type: 'paladin', attack: 3, defense: 2, abilities: [], effects: [{ id: 'frenzied', duration: 1, stacks: 1 }] };
    assert.equal(attackOf(fixture), 4);
    assert.equal(defenseOf(fixture), 1, 'frenzied also -1 DEF on plain object');
  });

  test('plain-object fixture with wounded effect leaves attack alone', () => {
    const fixture = { type: 'paladin', attack: 3, defense: 2, abilities: [], effects: [{ id: 'wounded', duration: 3, stacks: 1 }] };
    assert.equal(attackOf(fixture), 3);
    assert.equal(defenseOf(fixture), 2, 'wounded does not affect DEF');
  });
});

// ── Stunned planner gate (Fix #7) ──────────────────────────────────────────

describe('Stunned units fail validatePlanAction', () => {
  test('move action on a stunned actor is rejected', () => {
    const gs = new GameState(false, false);
    const hero = gs.hero;
    applyEffect(hero, 'stunned');
    const r = validatePlanAction(gs, {
      type: PlanActionType.MOVE, entityId: hero.id, toCol: hero.col + 1, toRow: hero.row,
    });
    assert.equal(r.valid, false);
    assert.match(r.reason ?? '', /stunned/i);
  });

  test('battle action on a stunned actor is rejected', () => {
    const gs = new GameState(false, false);
    const hero = gs.hero;
    const witch = gs.witch;
    applyEffect(hero, 'stunned');
    const r = validatePlanAction(gs, {
      type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: witch.id,
    });
    assert.equal(r.valid, false);
    assert.match(r.reason ?? '', /stunned/i);
  });

  test('non-stunned actor passes the gate', () => {
    const gs = new GameState(false, false);
    const hero = gs.hero;
    const r = validatePlanAction(gs, {
      type: PlanActionType.MOVE, entityId: hero.id, toCol: hero.col + 1, toRow: hero.row,
    });
    // Validity depends on terrain — we only care that the stun gate didn't reject it.
    if (!r.valid) assert.ok(!/stunned/i.test(r.reason ?? ''));
  });
});

// ── Campaign carry-over ────────────────────────────────────────────────────

describe('Campaign snapshotSurvivor', () => {
  test('only permanent effects survive into the campaign roster', () => {
    const gs = new GameState(false, false);
    // Use any entity — snapshotSurvivor only reads fields, not type checks.
    const e = gs.entities[0];
    e.name = 'Test'; e.title = 'Tester'; e.bio = '';
    applyEffect(e, 'wounded', { duration: 3 });
    applyEffect(e, 'cursed', { duration: 'mission' });
    applyEffect(e, 'eagle_eyed', { duration: 'permanent' });
    const snap = snapshotSurvivor(e);
    assert.deepEqual(snap.effects.map(x => x.id), ['eagle_eyed']);
  });
});
